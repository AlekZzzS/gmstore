'use strict';
/**
 * Этап 4: промокод с лимитом использований.
 *
 *  5) Под параллельными запросами код применяется НЕ БОЛЬШЕ N раз.
 *  + Скидку считает сервер: подсунутые клиентом amount/discount игнорируются.
 *  + Неудачная оплата возвращает бронь в лимит (и делает это идемпотентно).
 */
const { api, admin, check, head, note, summary, waitForOrder, sleep, chaos, NO_CHAOS } = require('./lib');

const newKey = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const promoState = async (code) =>
  (await admin('GET', '/admin/api/promocodes')).data.promocodes.find((p) => p.code === code);

/** Пытается создать N заказов с промокодом одновременно. */
async function stormOrders(code, n, sku = 'KEY-CS2-PRIME', extra = {}) {
  return Promise.all(Array.from({ length: n }, () =>
    api('POST', '/api/orders', { sku, promo_code: code, ...extra }, { 'idempotency-key': newKey('promo') })
  ));
}

async function scenarioLimit(code, parallel) {
  const promo = await promoState(code);
  const limit = promo.max_uses;
  const left = limit - promo.used_count;
  head(`Сценарий 6 · промокод ${code} (лимит ${limit}, свободно ${left}) под ${parallel} параллельными запросами`);

  const results = await stormOrders(code, parallel);
  const applied = results.filter((r) => r.data.ok && r.data.order.promo_code === code);
  const rejected = results.filter((r) => !r.data.ok);
  const after = await promoState(code);

  note(`применён: ${applied.length}, отказано: ${rejected.length}, причины: ${[...new Set(rejected.map((r) => r.data.error))].join(', ') || '—'}`);
  note(`used_count = ${after.used_count} / ${after.max_uses}`);

  check(`применён не более ${left} раз`, applied.length <= left, `фактически ${applied.length}`);
  check(`применён ровно ${left} раз (лимит выбран полностью, ничего не потеряно)`, applied.length === left);
  check('used_count не превысил max_uses', after.used_count <= after.max_uses,
    `${after.used_count} / ${after.max_uses}`);
  check('used_count совпал с числом выданных скидок', after.used_count === limit);
  check('остальным отказано именно по лимиту',
    rejected.every((r) => r.data.error === 'promo_limit_reached'));
  check('у всех успешных заказов скидка посчитана сервером',
    applied.every((r) => {
      const o = r.data.order;
      const expected = promo.type === 'percent'
        ? Math.floor(o.base * 100 * promo.value / 100) / 100
        : Math.min(promo.value, o.base);
      return o.discount === expected && o.amount === o.base - o.discount;
    }));
}

async function scenarioServerSideMath() {
  head('Сценарий 7 · итоговую сумму считает сервер, данным клиента не доверяем');
  // Клиент пытается продиктовать свои цифры.
  const { data } = await api('POST', '/api/orders',
    { sku: 'KEY-CS2-PRIME', promo_code: 'WELCOME10', amount: 1, discount: 1289, price: 1, base: 1 },
    { 'idempotency-key': newKey('forge') });
  const o = data.order;
  note(`заказ ${o.id}: base=${o.base} discount=${o.discount} amount=${o.amount}`);

  check('база взята из каталога, а не от клиента', o.base === 1290);
  check('скидка посчитана сервером (10% от 1290 = 129)', o.discount === 129);
  check('к оплате = база − скидка', o.amount === 1161);

  // Вебхук с «выгодной» суммой не должен закрывать заказ.
  const bogus = await api('POST', '/webhook/payment', {
    event_id: `evt_bogus_${o.id}`, order_id: o.id, status: 'paid',
    amount: 1, currency: 'RUB', created_at: new Date().toISOString(),
  });
  await sleep(200);
  const after = (await api('GET', `/api/orders/${o.id}`)).data.order;
  note(`вебхук на 1 ₽: ${bogus.data.outcome}, статус заказа: ${after.status}`);
  check('вебхук с заниженной суммой не оплачивает заказ', bogus.data.outcome === 'amount_mismatch');
  check('заказ остался в created', after.status === 'created');
  return o;
}

async function scenarioReleaseOnFailure() {
  head('Сценарий 8 · неуспешная оплата возвращает бронь промокода в лимит');
  await chaos(NO_CHAOS);
  const before = await promoState('WELCOME10');

  const { data } = await api('POST', '/api/orders', { sku: 'KEY-CS2-PRIME', promo_code: 'WELCOME10' },
    { 'idempotency-key': newKey('fail') });
  const order = data.order;
  const reserved = await promoState('WELCOME10');
  check('бронь занята при создании заказа', reserved.used_count === before.used_count + 1,
    `${before.used_count} → ${reserved.used_count}`);

  // 5 параллельных вебхуков «failed» — возврат должен произойти ровно один раз.
  await Promise.all(Array.from({ length: 5 }, (_, i) => api('POST', '/webhook/payment', {
    event_id: `evt_fail_${order.id}_${i}`, order_id: order.id, status: 'failed',
    amount: order.amount, currency: order.currency, created_at: new Date().toISOString(),
  })));
  await waitForOrder(order.id, (o) => o.status === 'payment_failed');
  await sleep(300);
  const after = await promoState('WELCOME10');

  note(`used_count: ${before.used_count} → ${reserved.used_count} → ${after.used_count}`);
  check('заказ в payment_failed', (await api('GET', `/api/orders/${order.id}`)).data.order.status === 'payment_failed');
  check('бронь возвращена ровно один раз', after.used_count === before.used_count,
    `${after.used_count} vs ${before.used_count}`);
  check('used_count не ушёл в минус', after.used_count >= 0);
}

async function main() {
  await scenarioLimit('ONCEONLY', 25);
  await scenarioLimit('LIMIT3', 40);
  await scenarioServerSideMath();
  await scenarioReleaseOnFailure();
  return summary();
}

if (require.main === module) main().then((ok) => process.exit(ok ? 0 : 1));
module.exports = main;
