'use strict';
/**
 * Нагрузочная проверка целостности: много независимых покупок одновременно,
 * у каждой — свои параллельные вебхуки, при нестабильных поставщиках.
 * Проверяются глобальные инварианты, а не отдельный заказ.
 */
const { api, admin, check, head, note, summary, waitForOrder, settled, chaos, sleep } = require('./lib');

const ORDERS = Number(process.env.ORDERS || 40);
const HOOKS = Number(process.env.HOOKS || 3);

const newKey = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const integrity = async () => (await admin('GET', '/admin/api/integrity')).data;

async function main() {
  head(`Нагрузка · ${ORDERS} параллельных покупок, по ${HOOKS} вебхука на каждую`);
  await chaos({ errorRate: 0.2, timeoutRate: 0.2, latencyMs: 15 }, { errorRate: 0.1, timeoutRate: 0.1, latencyMs: 15 });
  // Ключей заведомо достаточно.
  await admin('POST', '/admin/api/stock/topup', { provider: 'A', count: ORDERS + 20 });
  await admin('POST', '/admin/api/stock/topup', { provider: 'B', count: ORDERS + 20 });

  const before = await integrity();
  const t0 = Date.now();

  // Все заказы создаются и оплачиваются одновременно.
  const orders = await Promise.all(Array.from({ length: ORDERS }, async () => {
    const { data } = await api('POST', '/api/orders', { sku: 'KEY-EFT' }, { 'idempotency-key': newKey('st') });
    const o = data.order;
    await Promise.all(Array.from({ length: HOOKS }, (_, i) => api('POST', '/webhook/payment', {
      event_id: `evt_${o.id}_${i}`, order_id: o.id, status: 'paid',
      amount: o.amount, currency: o.currency, created_at: new Date().toISOString(),
    })));
    return o;
  }));

  // Доводим восстановимые заказы повторной выдачей (штатная ветка при сбоях).
  let finals = await Promise.all(orders.map((o) => waitForOrder(o.id, settled, { timeoutMs: 60000 })));
  for (let round = 0; round < 6; round++) {
    const stuck = finals.filter((o) => o && o.recoverable);
    if (stuck.length === 0) break;
    note(`восстановимых заказов: ${stuck.length} — повторная выдача, раунд ${round + 1}`);
    await Promise.all(stuck.map((o) => admin('POST', `/admin/api/orders/${o.id}/retry`)));
    finals = await Promise.all(orders.map((o) => waitForOrder(o.id, settled, { timeoutMs: 60000 })));
  }
  await sleep(1000); // фоновый возврат неиспользованных кодов

  const after = await integrity();
  const delivered = finals.filter((o) => o && o.status === 'delivered');
  const codes = delivered.map((o) => o.code);

  note(`${ORDERS} покупок за ${((Date.now() - t0) / 1000).toFixed(1)} с; выдано ${delivered.length}`);
  note(`ключей израсходовано: ${after.codes_claimed - before.codes_claimed}`);

  check('все заказы дошли до delivered', delivered.length === ORDERS,
    `${delivered.length}/${ORDERS}`);
  check('все выданные коды уникальны', new Set(codes).size === codes.length,
    `уникальных ${new Set(codes).size} из ${codes.length}`);
  check('фактов выдачи ровно столько же, сколько заказов',
    after.fulfillments_total - before.fulfillments_total === ORDERS);
  check('ни один ключ не ушёл в два заказа',
    after.fulfillments_total === after.distinct_codes,
    `${after.fulfillments_total} / ${after.distinct_codes}`);
  check('со склада ушло ровно по одному ключу на заказ',
    after.codes_claimed - before.codes_claimed === ORDERS,
    `израсходовано ${after.codes_claimed - before.codes_claimed}, заказов ${ORDERS}`);
  check('нет заказов, застрявших в delivering',
    !after.by_status.some((s) => s.status === 'delivering' && s.c > 0));

  return summary();
}

if (require.main === module) main().then((ok) => process.exit(ok ? 0 : 1));
module.exports = main;
