'use strict';
/**
 * Этап 2, часть 2 — ключевой сценарий приёмки.
 *
 *  1) 50 параллельных вебхуков «оплачено» по одному заказу
 *     → ровно один факт выдачи, израсходован ровно один ключ.
 *  2) Повторный вебхук с тем же event_id ничего не меняет.
 *  3) Вебхук пришёл раньше создания заказа → обработано без потери и дубля.
 *
 * Прогоняется при включённом «хаосе» поставщиков (5xx + таймауты),
 * то есть одновременно проверяется и ловушка таймаута.
 */
const { api, admin, check, head, note, summary, waitForOrder, settled, chaos, sleep } = require('./lib');

const N = Number(process.env.N || 50);

const stockClaimed = async () => (await admin('GET', '/admin/api/integrity')).data.codes_claimed;
const newKey = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function createOrder(sku = 'KEY-CS2-PRIME') {
  const { data } = await api('POST', '/api/orders', { sku }, { 'idempotency-key': newKey('ord') });
  return data.order;
}

/** Прямая отправка вебхука, минуя эмулятор оплаты — как это сделала бы платёжка. */
const webhook = (payload) => api('POST', '/webhook/payment', payload);

async function scenario1() {
  head(`Сценарий 1 · ${N} параллельных вебхуков «paid» по одному заказу`);
  // Поставщик A нестабилен: часть запросов 5xx, часть «зависает» уже ПОСЛЕ выдачи кода.
  await chaos({ errorRate: 0.3, timeoutRate: 0.3, latencyMs: 20 }, { errorRate: 0.1, timeoutRate: 0.1, latencyMs: 20 });

  const order = await createOrder();
  const claimedBefore = await stockClaimed();

  // 50 РАЗНЫХ event_id — то есть дедупликация по event_id тут не помогает,
  // работать должен CAS-переход статуса заказа.
  const t0 = Date.now();
  const responses = await Promise.all(
    Array.from({ length: N }, (_, i) => webhook({
      event_id: `evt_${order.id}_${i}`,
      order_id: order.id,
      status: 'paid',
      amount: order.amount,
      currency: order.currency,
      created_at: new Date().toISOString(),
    }))
  );
  const elapsed = Date.now() - t0;

  let final = await waitForOrder(order.id, settled);
  const applied = responses.filter((r) => r.data.outcome === 'applied').length;

  note(`${N} вебхуков за ${elapsed} мс, все ответы 200: ${responses.every((r) => r.status === 200)}`);
  note(`после шторма: ${final.status}${final.code ? ` / ${final.code}` : ''}, попыток выдачи: ${final.attempt}`);

  check('все вебхуки ответили 200', responses.every((r) => r.status === 200));
  check('ровно один вебхук перевёл заказ в paid', applied === 1, `applied=${applied}`);

  // Поставщики специально нестабильны, поэтому заказ мог законно уйти в
  // восстановимое состояние (это штатная ветка, а не потеря). Доводим его
  // повторными выдачами — и проверяем, что за ВСЮ историю, включая шторм и
  // повторы, со склада ушёл ровно один ключ.
  for (let i = 0; i < 8 && final.status !== 'delivered'; i++) {
    if (!final.recoverable) break;
    note(`заказ в ${final.status} — повторная выдача #${i + 1}`);
    await admin('POST', `/admin/api/orders/${order.id}/retry`);
    final = await waitForOrder(order.id, settled);
  }
  await sleep(600); // фоновый возврат неиспользованных кодов на склад

  const claimedAfter = await stockClaimed();
  const integrity = (await admin('GET', '/admin/api/integrity')).data;

  note(`итог заказа: ${final.status}${final.code ? ` / ${final.code}` : ''}, попыток выдачи: ${final.attempt}`);

  check('заказ выдан', final.status === 'delivered', `status=${final.status}`);
  check('у заказа ровно один код', !!final.code);
  check('за всю историю израсходован ровно один ключ', claimedAfter - claimedBefore === 1,
    `claimed: ${claimedBefore} → ${claimedAfter}`);
  check('фактов выдачи = число уникальных кодов (ни один ключ не ушёл в два заказа)',
    integrity.fulfillments_total === integrity.distinct_codes,
    `${integrity.fulfillments_total} / ${integrity.distinct_codes}`);
  return final;
}

async function scenario2(order) {
  head('Сценарий 2 · повторный вебхук с тем же event_id ничего не меняет');
  const before = await api('GET', `/api/orders/${order.id}`);
  const eventId = `evt_dup_${order.id}`;
  const payload = {
    event_id: eventId, order_id: order.id, status: 'paid',
    amount: order.amount, currency: order.currency, created_at: new Date().toISOString(),
  };

  const first = await webhook(payload);
  const repeats = await Promise.all(Array.from({ length: 10 }, () => webhook(payload)));
  await sleep(300);
  const after = await api('GET', `/api/orders/${order.id}`);

  note(`первый ответ: ${first.data.outcome}, повторы: ${repeats.map((r) => r.data.outcome).join(', ')}`);
  check('все повторы получили 200', repeats.every((r) => r.status === 200));
  check('все повторы помечены как duplicate', repeats.every((r) => r.data.outcome === 'duplicate'));
  check('код заказа не изменился', after.data.order.code === before.data.order.code);
  check('статус заказа не изменился', after.data.order.status === before.data.order.status);
  check('число попыток выдачи не выросло', after.data.order.attempt === before.data.order.attempt);
}

async function scenario3() {
  head('Сценарий 3 · вебхук пришёл РАНЬШЕ создания заказа');
  await chaos({ errorRate: 0, timeoutRate: 0, latencyMs: 5 });

  // Узнаём, какой id получит следующий заказ, и шлём вебхук заранее.
  const predicted = (await admin('GET', '/admin/api/integrity')).data.next_order_id;
  const product = { sku: 'KEY-CS2-PRIME', amount: 1290, currency: 'RUB' };
  const claimedBefore = await stockClaimed();

  const early = await webhook({
    event_id: `evt_early_${predicted}`, order_id: predicted, status: 'paid',
    amount: product.amount, currency: product.currency, created_at: new Date().toISOString(),
  });
  note(`вебхук по ещё не существующему ${predicted}: ${early.status} / ${early.data.outcome}`);

  check('ранний вебхук принят с 200 (платёжка не будет ретраить зря)', early.status === 200);
  check('ранний вебхук не потерян, а отложен', early.data.outcome === 'pending_order');

  const order = await createOrder(product.sku);
  check('созданный заказ получил предсказанный id', order.id === predicted, `${order.id} vs ${predicted}`);

  const final = await waitForOrder(order.id, settled);
  const claimedAfter = await stockClaimed();
  note(`итог: ${final.status} / ${final.code}`);

  check('отложенный вебхук применился после создания заказа', final.status === 'delivered');
  check('выдан ровно один ключ', claimedAfter - claimedBefore === 1, `claimed: ${claimedBefore} → ${claimedAfter}`);

  // Повтор раннего вебхука уже после выдачи — снова ничего не меняет.
  const again = await webhook({
    event_id: `evt_early_${predicted}`, order_id: predicted, status: 'paid',
    amount: product.amount, currency: product.currency, created_at: new Date().toISOString(),
  });
  const afterAgain = (await api('GET', `/api/orders/${order.id}`)).data.order;
  check('повтор раннего вебхука — duplicate', again.data.outcome === 'duplicate');
  check('код не изменился после повтора', afterAgain.code === final.code);
}

async function main() {
  const order = await scenario1();
  await scenario2(order);
  await scenario3();
  await chaos({ errorRate: 0.15, timeoutRate: 0.1, latencyMs: 40 }, { errorRate: 0.1, timeoutRate: 0.05, latencyMs: 60 });
  return summary();
}

if (require.main === module) main().then((ok) => process.exit(ok ? 0 : 1));
module.exports = main;
