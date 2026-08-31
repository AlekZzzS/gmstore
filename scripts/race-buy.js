'use strict';
/**
 * Этап 2, часть 1: двойной (и двадцатикратный) клик по кнопке «Купить».
 * Все запросы летят с одним Idempotency-Key и стартуют одновременно.
 * Ожидание: создан ровно один заказ.
 */
const { api, admin, check, head, note, summary } = require('./lib');

const N = Number(process.env.N || 20);

async function main() {
  head(`Гонка A · ${N} одновременных «Купить» с одним Idempotency-Key`);

  const key = `race-buy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const before = (await admin('GET', '/admin/api/integrity')).data.orders_total;

  const results = await Promise.all(
    Array.from({ length: N }, () =>
      api('POST', '/api/orders', { sku: 'KEY-CS2-PRIME' }, { 'idempotency-key': key })
    )
  );

  const ok = results.filter((r) => r.status === 200 && r.data.ok);
  const ids = new Set(ok.map((r) => r.data.order.id));
  const after = (await admin('GET', '/admin/api/integrity')).data.orders_total;

  note(`успешных ответов: ${ok.length}/${N}, уникальных order_id: ${ids.size}`);
  check('все запросы получили 200', ok.length === N);
  check('создан ровно один заказ', ids.size === 1, `→ ${[...ids].join(', ')}`);
  check('в БД добавился ровно один заказ', after - before === 1, `было ${before}, стало ${after}`);
  check('ровно один ответ помечен как первичный',
    results.filter((r) => r.data.ok && r.data.replay === false).length === 1);

  return summary();
}

if (require.main === module) main().then((ok) => process.exit(ok ? 0 : 1));
module.exports = main;
