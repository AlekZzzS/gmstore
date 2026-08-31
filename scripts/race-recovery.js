'use strict';
/**
 * Этап 3: сбои и восстановление.
 *
 *  4) Пустой пул ключей → заказ в восстановимом состоянии, без падения;
 *     после пополнения повторная выдача даёт РОВНО ОДИН ключ
 *     (в том числе при 10 одновременных нажатиях «Выдать повторно» в админке).
 *  + Ловушка таймаута: поставщик A всегда «зависает» уже ПОСЛЕ выдачи кода.
 *    Проверяем, что заказ закрывает резервный B и со склада суммарно уходит один ключ.
 */
const { api, admin, check, head, note, summary, waitForOrder, settled, chaos, sleep, NO_CHAOS } = require('./lib');

const newKey = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const integrity = async () => (await admin('GET', '/admin/api/integrity')).data;

async function buyAndPay(sku = 'KEY-CS2-PRIME') {
  const { data } = await api('POST', '/api/orders', { sku }, { 'idempotency-key': newKey('rec') });
  const order = data.order;
  await api('POST', '/api/pay/simulate', { order_id: order.id, outcome: 'paid' });
  return order;
}

async function scenarioOutOfStock() {
  head('Сценарий 4 · пустой пул ключей → восстановимое состояние → пополнение → повторная выдача');
  await chaos(NO_CHAOS);

  // Опустошаем склады обоих поставщиков.
  await admin('POST', '/admin/api/stock/drain', {});
  const emptied = (await admin('GET', '/admin/api/stock')).data.stock;
  note(`склад после опустошения: ${emptied.map((s) => `${s.provider}=${s.free}`).join(' ')}`);

  const order = await buyAndPay();
  const stuck = await waitForOrder(order.id, settled);

  note(`итог без остатка: ${stuck.status} (last_error=${stuck.last_error})`);
  check('оплата прошла, но заказ НЕ упал', !!stuck, 'сервер жив');
  check('заказ в восстановимом состоянии out_of_stock', stuck.status === 'out_of_stock', `status=${stuck.status}`);
  check('код клиенту не выдан', stuck.code === null);
  check('сервер отвечает после сбоя', (await api('GET', '/api/health')).status === 200);

  // Админка: список «оплачен, но не выдан».
  const list = (await admin('GET', '/admin/api/orders?filter=stuck')).data.orders;
  check('заказ виден в админке как «оплачен, но не выдан»', list.some((o) => o.id === order.id),
    `в списке ${list.length} заказ(ов)`);

  // Пополняем склад РОВНО ОДНИМ ключом — жёсткая проверка: задвоение сразу вылезет.
  await admin('POST', '/admin/api/stock/topup', { provider: 'A', count: 1 });
  const beforeRetry = await integrity();
  note(`пополнили склад на 1 ключ, свободно: ${beforeRetry.codes_free}`);

  // 10 ОДНОВРЕМЕННЫХ ручных повторных выдач.
  const retries = await Promise.all(
    Array.from({ length: 10 }, () => admin('POST', `/admin/api/orders/${order.id}/retry`))
  );
  const delivered = await waitForOrder(order.id, (o) => o.status === 'delivered');
  await sleep(500); // даём фоновому возврату неиспользованных кодов дойти до склада
  const afterRetry = await integrity();

  note(`после 10 параллельных retry: ${delivered.status} / ${delivered.code}`);
  check('все retry ответили 200', retries.every((r) => r.status === 200));
  check('заказ выдан', delivered.status === 'delivered');
  check('израсходован ровно один ключ', beforeRetry.codes_free - afterRetry.codes_free === 1,
    `свободно: ${beforeRetry.codes_free} → ${afterRetry.codes_free}`);
  check('факт выдачи ровно один на заказ',
    afterRetry.fulfillments_total - beforeRetry.fulfillments_total === 1);
  check('ни один ключ не ушёл в два заказа',
    afterRetry.fulfillments_total === afterRetry.distinct_codes,
    `${afterRetry.fulfillments_total} / ${afterRetry.distinct_codes}`);

  // Повторная выдача уже выданного заказа — идемпотентна.
  const again = await admin('POST', `/admin/api/orders/${order.id}/retry`);
  const afterAgain = await integrity();
  check('retry по выданному заказу идемпотентен (код тот же)',
    again.data.order.code === delivered.code);
  check('retry по выданному заказу не тратит ключ',
    afterAgain.codes_free === afterRetry.codes_free, `свободно ${afterAgain.codes_free}`);
  check('число фактов выдачи не выросло',
    afterAgain.fulfillments_total === afterRetry.fulfillments_total);
}

async function scenarioTimeoutTrap() {
  head('Сценарий 5 · ловушка таймаута: A всегда «зависает» УЖЕ ПОСЛЕ выдачи кода');
  // A: код выдаётся и коммитится, но ответ не приходит никогда. B: исправен.
  await chaos({ errorRate: 0, timeoutRate: 1, latencyMs: 5 }, NO_CHAOS);
  await admin('POST', '/admin/api/stock/topup', { provider: 'A', count: 5 });
  await admin('POST', '/admin/api/stock/topup', { provider: 'B', count: 5 });

  const before = await integrity();
  const order = await buyAndPay();
  const final = await waitForOrder(order.id, settled, { timeoutMs: 40000 });
  await sleep(800); // фоновый возврат неиспользованных кодов на склад
  const after = await integrity();

  note(`итог: ${final.status} / ${final.code} (поставщик ${final.provider})`);
  note(`свободных ключей: ${before.codes_free} → ${after.codes_free}`);

  check('заказ всё-таки выдан резервным поставщиком', final.status === 'delivered', `status=${final.status}`);
  check('код выдал поставщик B', final.provider === 'B', `provider=${final.provider}`);
  check('со склада суммарно ушёл ровно один ключ (код «зависшего» A возвращён)',
    before.codes_free - after.codes_free === 1,
    `${before.codes_free} → ${after.codes_free}`);
  check('ни один ключ не ушёл в два заказа',
    after.fulfillments_total === after.distinct_codes);

  await chaos(NO_CHAOS);
}

async function main() {
  await scenarioOutOfStock();
  await scenarioTimeoutTrap();
  return summary();
}

if (require.main === module) main().then((ok) => process.exit(ok ? 0 : 1));
module.exports = main;
