'use strict';
/**
 * Создание заказа и применение вебхуков оплаты.
 *
 * Двойной клик «Купить» гасится PK по Idempotency-Key: параллельные запросы
 * с одним ключом создают ровно один заказ, проигравшие читают победителя.
 */
const { tx, run, get, all, nowIso, logEvent, nextOrderId, isConstraintError } = require('../db');
const promo = require('./promo');
const { fulfillInBackground } = require('./fulfillment');

// ── Создание заказа ───────────────────────────────────────────────────────────

function createOrder({ sku, idempotencyKey, promoCode, steamLogin }) {
  const product = get('SELECT * FROM products WHERE sku = ?', sku);
  if (!product) return { ok: false, status: 404, error: 'unknown_sku' };
  if (!idempotencyKey) return { ok: false, status: 400, error: 'idempotency_key_required' };

  const attempt = () => tx(() => {
    // Повтор с тем же ключом — отдаём уже созданный заказ, ничего не меняя.
    const seen = get('SELECT order_id FROM order_idempotency WHERE key = ?', idempotencyKey);
    if (seen) return { ok: true, replay: true, orderId: seen.order_id };

    const base = product.price_minor;
    const reserved = promo.reserveInTx(promoCode, base);
    if (!reserved.ok) return { ok: false, status: 409, error: `promo_${reserved.reason}` };

    const discount = reserved.discount_minor;
    const amount = base - discount;                      // сумму считает сервер
    const orderId = nextOrderId();

    run(
      `INSERT INTO orders(id, sku, status, base_minor, discount_minor, amount_minor,
                          currency, promo_code, steam_login, created_at, updated_at)
       VALUES (?,?, 'created', ?,?,?,?,?,?,?,?)`,
      orderId, sku, base, discount, amount, product.currency,
      reserved.code, steamLogin || null, nowIso(), nowIso()
    );
    promo.attachRedemptionInTx(orderId, reserved.code, discount);
    run('INSERT INTO order_idempotency(key, order_id, created_at) VALUES (?,?,?)',
      idempotencyKey, orderId, nowIso());
    logEvent(orderId, 'order.created', `${sku} amount=${amount / 100} ${product.currency}` +
      (reserved.code ? ` promo=${reserved.code} -${discount / 100}` : ''));
    return { ok: true, orderId };
  });

  let res;
  try {
    res = attempt();
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    // Гонка по Idempotency-Key: победитель уже вставил строку — читаем её.
    const seen = get('SELECT order_id FROM order_idempotency WHERE key = ?', idempotencyKey);
    if (!seen) throw err;
    res = { ok: true, replay: true, orderId: seen.order_id };
  }
  if (!res.ok) return res;

  // Вебхук мог прийти РАНЬШЕ создания заказа — применяем накопленные события.
  applyPendingEvents(res.orderId);
  return { ok: true, replay: !!res.replay, order: getOrder(res.orderId) };
}

// ── Вебхук оплаты ─────────────────────────────────────────────────────────────

/**
 * Идемпотентная обработка вебхука.
 * Возвращает быстро; сама выдача уходит в фон (контракт требует быстрый 200).
 */
function handleWebhook(evt) {
  const eventId = evt.event_id;
  const orderId = evt.order_id;
  if (!eventId || !orderId || !evt.status) {
    return { httpStatus: 400, body: { ok: false, error: 'event_id, order_id, status обязательны' } };
  }

  let result;
  try {
    result = tx(() => {
      // Рубеж 1: повтор с тем же event_id физически не пройдёт дальше.
      run(
        `INSERT INTO webhook_events(event_id, order_id, status, amount_minor, currency, payload, received_at)
         VALUES (?,?,?,?,?,?,?)`,
        eventId, orderId, evt.status,
        Number.isFinite(evt.amount) ? Math.round(evt.amount * 100) : null,
        evt.currency ?? null, JSON.stringify(evt), nowIso()
      );
      return applyEventInTx(eventId);
    });
  } catch (err) {
    if (isConstraintError(err)) {
      const seen = get('SELECT outcome FROM webhook_events WHERE event_id = ?', eventId);
      return { httpStatus: 200, body: { ok: true, outcome: 'duplicate', first_outcome: seen && seen.outcome } };
    }
    // 5xx — платёжка повторит доставку, это штатный путь.
    console.error('[webhook]', err);
    return { httpStatus: 500, body: { ok: false, error: 'internal' } };
  }

  if (result.startDelivery) fulfillInBackground(orderId);
  return { httpStatus: 200, body: { ok: true, outcome: result.outcome } };
}

/** Применение одного события. Вызывать только внутри tx(). */
function applyEventInTx(eventId) {
  const evt = get('SELECT * FROM webhook_events WHERE event_id = ?', eventId);
  if (!evt || evt.applied_at) return { outcome: evt ? evt.outcome : 'unknown' };

  const order = get('SELECT * FROM orders WHERE id = ?', evt.order_id);

  // Вебхук пришёл раньше заказа — не теряем, оставляем ждать.
  if (!order) {
    run("UPDATE webhook_events SET outcome = 'pending_order' WHERE event_id = ?", eventId);
    return { outcome: 'pending_order' };
  }

  const finish = (outcome) => {
    run('UPDATE webhook_events SET applied_at = ?, outcome = ? WHERE event_id = ?', nowIso(), outcome, eventId);
    return outcome;
  };

  if (evt.status === 'failed') {
    const upd = run(
      `UPDATE orders SET status = 'payment_failed', updated_at = ? WHERE id = ? AND status = 'created'`,
      nowIso(), order.id
    );
    if (upd.changes === 1) {
      logEvent(order.id, 'payment.failed', eventId);
      // Бронь промокода возвращаем в лимит — той же транзакцией, что и смену статуса.
      promo.releaseInTx(order.id);
      return { outcome: finish('applied') };
    }
    return { outcome: finish('ignored_not_pending') };
  }

  if (evt.status !== 'paid') return { outcome: finish('ignored_unknown_status') };

  // Сумму сверяем со своей, а не доверяем присланной.
  if (evt.amount_minor != null && evt.amount_minor !== order.amount_minor) {
    logEvent(order.id, 'payment.amount_mismatch', `ожидали ${order.amount_minor}, пришло ${evt.amount_minor}`);
    return { outcome: finish('amount_mismatch') };
  }

  // Рубеж 2: created → paid выигрывает ровно один из N параллельных вебхуков.
  const upd = run(
    `UPDATE orders SET status = 'paid', paid_event_id = ?, updated_at = ? WHERE id = ? AND status = 'created'`,
    eventId, nowIso(), order.id
  );
  if (upd.changes === 1) {
    logEvent(order.id, 'payment.paid', eventId);
    finish('applied');
    return { outcome: 'applied', startDelivery: true };
  }

  // Не выиграли переход. Если заказ уже оплачен, но ещё не выдан — подтолкнём выдачу:
  // это безопасно, лишний вызов fulfill() отсекается арендой.
  const startDelivery = ['paid', 'out_of_stock', 'delivery_failed'].includes(order.status);
  return { outcome: finish(startDelivery ? 'already_paid_retry_delivery' : 'ignored_terminal'), startDelivery };
}

/** Догоняющее применение вебхуков, пришедших раньше заказа. */
function applyPendingEvents(orderId) {
  const pending = all(
    'SELECT event_id FROM webhook_events WHERE order_id = ? AND applied_at IS NULL ORDER BY received_at',
    orderId
  );
  if (pending.length === 0) return 0;

  let startDelivery = false;
  for (const p of pending) {
    const r = tx(() => applyEventInTx(p.event_id));
    if (r.startDelivery) startDelivery = true;
  }
  if (startDelivery) fulfillInBackground(orderId);
  return pending.length;
}

// ── Чтение ────────────────────────────────────────────────────────────────────

function getOrder(orderId) {
  const o = get(
    `SELECT o.*, p.name AS product_name, p.image AS product_image, p.type AS product_type
       FROM orders o JOIN products p ON p.sku = o.sku WHERE o.id = ?`,
    orderId
  );
  if (!o) return null;
  const f = get('SELECT * FROM fulfillments WHERE order_id = ?', orderId);
  return {
    id: o.id,
    sku: o.sku,
    product_name: o.product_name,
    product_type: o.product_type,
    status: o.status,
    base: o.base_minor / 100,
    discount: o.discount_minor / 100,
    amount: o.amount_minor / 100,
    currency: o.currency,
    promo_code: o.promo_code,
    steam_login: o.steam_login,
    attempt: o.attempt,
    last_error: o.last_error,
    code: f ? f.code : null,
    delivered_at: f ? f.created_at : null,
    provider: f ? f.provider : null,
    created_at: o.created_at,
    updated_at: o.updated_at,
    recoverable: ['out_of_stock', 'delivery_failed'].includes(o.status),
    terminal: ['delivered', 'payment_failed'].includes(o.status),
    events: all('SELECT type, detail, created_at FROM order_events WHERE order_id = ? ORDER BY id', orderId),
  };
}

module.exports = { createOrder, handleWebhook, applyPendingEvents, getOrder };
