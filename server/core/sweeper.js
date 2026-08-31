'use strict';
/**
 * Фоновое восстановление. Ничего не «чинит руками» — просто повторно
 * запускает те же идемпотентные операции, поэтому безопасен при любом числе
 * процессов и при любом моменте падения.
 */
const { all, tx, run, get, nowIso, logEvent } = require('../db');
const { fulfill } = require('./fulfillment');
const { applyPendingEvents } = require('./orders');
const promo = require('./promo');
const config = require('../config');

let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    // 1. Вебхуки, пришедшие раньше заказа: заказ мог появиться уже после них
    //    (в том числе в другом процессе).
    const orphans = all(
      `SELECT DISTINCT w.order_id FROM webhook_events w
         JOIN orders o ON o.id = w.order_id
        WHERE w.applied_at IS NULL LIMIT 50`
    );
    for (const o of orphans) applyPendingEvents(o.order_id);

    // 2. Заказы, застрявшие в delivering с протухшей арендой (процесс умер в середине).
    const stale = all(
      `SELECT id FROM orders
        WHERE status = 'delivering' AND (lease_until IS NULL OR lease_until < ?)
        LIMIT 20`,
      Date.now()
    );
    for (const s of stale) {
      logEvent(s.id, 'recovery.lease_expired', 'аренда на выдачу протухла, перезапуск');
      await fulfill(s.id);
    }

    // 3. Неоплаченные заказы с истёкшим сроком: закрываем заказ и возвращаем
    //    бронь промокода в лимит.
    if (config.orderTtlMs > 0) expireStaleOrders(config.orderTtlMs);

    // 4. Необязательный автоповтор восстановимых заказов (по умолчанию выключен —
    //    в задании требуется ручная повторная выдача из админки).
    if (config.autoRetryStuck) {
      const stuck = all(
        `SELECT id FROM orders WHERE status IN ('out_of_stock','delivery_failed')
          ORDER BY updated_at LIMIT 5`
      );
      for (const s of stuck) await fulfill(s.id);
    }
  } catch (err) {
    console.error('[sweeper]', err);
  } finally {
    running = false;
  }
}

/**
 * Протухание неоплаченных заказов.
 *
 * Бронь промокода занимается при СОЗДАНИИ заказа, иначе лимит нельзя было бы
 * удержать под параллельными запросами. Значит брошенный заказ навсегда съедал
 * бы место под лимитом — код можно «выжечь», не заплатив.
 *
 * Ключевой момент: вернуть бронь и закрыть заказ нужно ОДНОЙ транзакцией с
 * CAS-переходом из 'created'. Если отпустить бронь, оставив заказ живым,
 * поздний вебхук 'paid' довёл бы его до выдачи — и скидку получили бы N+1
 * покупателей. Здесь из 'created' выходит ровно один: либо мы, либо вебхук.
 */
function expireStaleOrders(ttlMs) {
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  const stale = all(
    "SELECT id FROM orders WHERE status = 'created' AND created_at < ? LIMIT 50",
    cutoff
  );
  for (const s of stale) {
    tx(() => {
      const upd = run(
        `UPDATE orders SET status = 'payment_failed', last_error = 'expired', updated_at = ?
          WHERE id = ? AND status = 'created'`,
        nowIso(), s.id
      );
      // changes === 0 — вебхук успел раньше нас. Заказ живой, бронь не трогаем.
      if (upd.changes !== 1) return;
      logEvent(s.id, 'order.expired', `не оплачен за ${Math.round(ttlMs / 60000)} мин`);
      promo.releaseInTx(s.id);
    });
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick(); }, config.sweeperIntervalMs);
  timer.unref();
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, tick };
