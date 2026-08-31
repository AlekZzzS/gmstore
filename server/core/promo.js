'use strict';
/**
 * Промокоды. Лимит держится атомарным инкрементом, а не проверкой в JS:
 *   UPDATE promocodes SET used_count = used_count + 1
 *    WHERE code = ? AND used_count < max_uses
 * changes === 1 → бронь получена, changes === 0 → лимит исчерпан.
 * Плюс CHECK(used_count <= max_uses) в схеме как последняя линия обороны.
 *
 * Скидку всегда считает сервер по своей цене; от клиента приходит только строка кода.
 */
const { tx, run, get, nowIso, logEvent } = require('../db');

/** Расчёт скидки в минорных единицах. Целочисленно — без плавающей точки. */
function computeDiscount(promo, baseMinor) {
  if (!promo) return 0;
  if (promo.type === 'percent') {
    return Math.min(baseMinor, Math.floor((baseMinor * promo.value) / 100));
  }
  // amount: value указан в основных единицах валюты
  return Math.min(baseMinor, promo.value * 100);
}

/** Предпросмотр для UI. Ничего не резервирует. */
function preview(code, baseMinor) {
  if (!code) return { ok: true, code: null, discount_minor: 0, amount_minor: baseMinor };
  const promo = get('SELECT * FROM promocodes WHERE code = ?', String(code).trim().toUpperCase());
  if (!promo) return { ok: false, reason: 'not_found' };
  if (promo.used_count >= promo.max_uses) return { ok: false, reason: 'limit_reached' };
  const discount = computeDiscount(promo, baseMinor);
  return {
    ok: true,
    code: promo.code,
    type: promo.type,
    value: promo.value,
    discount_minor: discount,
    amount_minor: baseMinor - discount,
    uses_left: promo.max_uses - promo.used_count,
  };
}

/**
 * Резервирование места под лимитом. Вызывать ТОЛЬКО внутри уже открытой tx()
 * создания заказа, чтобы бронь и заказ появились одной транзакцией.
 */
function reserveInTx(code, baseMinor) {
  if (!code) return { ok: true, code: null, discount_minor: 0 };
  const normalized = String(code).trim().toUpperCase();
  const promo = get('SELECT * FROM promocodes WHERE code = ?', normalized);
  if (!promo) return { ok: false, reason: 'not_found' };

  const upd = run(
    'UPDATE promocodes SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses',
    normalized
  );
  if (upd.changes !== 1) return { ok: false, reason: 'limit_reached' };

  return { ok: true, code: normalized, discount_minor: computeDiscount(promo, baseMinor) };
}

/** Регистрация брони за заказом. Внутри той же tx(). */
function attachRedemptionInTx(orderId, code, discountMinor) {
  if (!code) return;
  run(
    'INSERT INTO promo_redemptions(order_id, code, amount_minor, created_at) VALUES (?,?,?,?)',
    orderId, code, discountMinor, nowIso()
  );
}

/**
 * Возврат брони (оплата не прошла). Идемпотентно: released = 1 ставится
 * атомарно, и только победивший вызов уменьшает счётчик.
 */
function releaseInTx(orderId) {
  const r = get('SELECT * FROM promo_redemptions WHERE order_id = ?', orderId);
  if (!r) return { released: false, reason: 'no_redemption' };
  // Победитель гонки определяется этим UPDATE: счётчик уменьшит ровно один вызов.
  const upd = run('UPDATE promo_redemptions SET released = 1 WHERE order_id = ? AND released = 0', orderId);
  if (upd.changes !== 1) return { released: false, reason: 'already_released' };
  run('UPDATE promocodes SET used_count = used_count - 1 WHERE code = ? AND used_count > 0', r.code);
  logEvent(orderId, 'promo.released', r.code);
  return { released: true, code: r.code };
}

function release(orderId) {
  return tx(() => releaseInTx(orderId));
}

module.exports = { preview, reserveInTx, attachRedemptionInTx, release, releaseInTx, computeDiscount };
