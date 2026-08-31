'use strict';
const { Router, sendJson } = require('./http');
const { all, get, run, tx, nowIso, logEvent } = require('./db');
const config = require('./config');
const orders = require('./core/orders');
const promo = require('./core/promo');
const providers = require('./core/providers');
const { fulfill } = require('./core/fulfillment');

const router = new Router();

// ── Витрина ───────────────────────────────────────────────────────────────────

router.get('/api/catalog', (req, res) => {
  const rows = all('SELECT sku, name, type, price_minor, currency, image FROM products ORDER BY rowid');
  sendJson(res, 200, {
    currency_note: 'Базовая цена в RUB. Переключатель валют ($/₸/₽) — только отображение.',
    products: rows.map((p) => ({
      sku: p.sku, name: p.name, type: p.type,
      price: p.price_minor / 100, currency: p.currency, image: p.image,
    })),
  });
});

// Предпросмотр скидки. Ничего не резервирует; итог всё равно пересчитает сервер при создании заказа.
router.post('/api/promo/preview', async (req, res, { body }) => {
  const product = get('SELECT * FROM products WHERE sku = ?', body.sku);
  if (!product) return sendJson(res, 404, { ok: false, error: 'unknown_sku' });
  const p = promo.preview(body.code, product.price_minor);
  if (!p.ok) return sendJson(res, 200, { ok: false, reason: p.reason });
  sendJson(res, 200, {
    ok: true, code: p.code, discount: p.discount_minor / 100,
    amount: p.amount_minor / 100, uses_left: p.uses_left,
  });
});

// ── Заказы ────────────────────────────────────────────────────────────────────

router.post('/api/orders', async (req, res, { body }) => {
  const idempotencyKey = req.headers['idempotency-key'] || body.idempotency_key;
  const result = orders.createOrder({
    sku: body.sku,
    idempotencyKey,
    promoCode: body.promo_code,
    steamLogin: body.steam_login,
  });
  if (!result.ok) return sendJson(res, result.status || 400, { ok: false, error: result.error });
  // 200, а не 201: повторный запрос с тем же ключом возвращает тот же заказ.
  sendJson(res, 200, { ok: true, replay: !!result.replay, order: result.order });
});

router.get('/api/orders/:id', (req, res, { params }) => {
  const o = orders.getOrder(params.id);
  if (!o) return sendJson(res, 404, { ok: false, error: 'not_found' });
  sendJson(res, 200, { ok: true, order: o });
});

// ── Эмуляция оплаты ───────────────────────────────────────────────────────────
// Реального эквайринга нет: этот эндпоинт играет роль платёжной системы и
// шлёт вебхук по контракту на наш же /webhook/payment.

router.post('/api/pay/simulate', async (req, res, { body }) => {
  const order = get('SELECT * FROM orders WHERE id = ?', body.order_id);
  if (!order) return sendJson(res, 404, { ok: false, error: 'unknown_order' });

  const outcome = body.outcome === 'failed' ? 'failed' : 'paid';
  const times = Math.min(Math.max(Number(body.times) || 1, 1), 100);
  const duplicate = !!body.duplicate; // повторить с ТЕМ ЖЕ event_id
  const eventId = body.event_id || `evt_${Math.random().toString(36).slice(2, 10)}`;

  const payloads = [];
  for (let i = 0; i < times; i++) {
    payloads.push({
      event_id: duplicate ? eventId : (times > 1 ? `${eventId}_${i}` : eventId),
      order_id: order.id,
      status: outcome,
      amount: order.amount_minor / 100,
      currency: order.currency,
      created_at: new Date().toISOString(),
    });
  }

  // Отправляем параллельно — так же, как повела бы себя платёжка при ретраях.
  const results = await Promise.all(payloads.map((p) =>
    fetch(`${config.selfUrl}/webhook/payment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(p),
    }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e.message) }))
  ));

  sendJson(res, 200, { ok: true, sent: payloads.length, results });
});

// ── Вебхук платёжной системы ──────────────────────────────────────────────────

router.post('/webhook/payment', async (req, res, { body }) => {
  const r = orders.handleWebhook(body);
  sendJson(res, r.httpStatus, r.body);
});

// ── Заглушки поставщиков ──────────────────────────────────────────────────────

router.post('/provider/:id/issue', async (req, res, { params, body }) => {
  const provider = String(params.id).toUpperCase();
  const r = await providers.issue(provider, body);
  // hang: ответа не будет вовсе — клиент словит таймаут. Код при этом уже выдан.
  if (r.hang) return;
  sendJson(res, r.httpStatus, r.body);
});

router.post('/provider/:id/release', async (req, res, { params, body }) => {
  const r = providers.release(String(params.id).toUpperCase(), body.request_id);
  sendJson(res, 200, { ok: true, ...r });
});

// ── Админка ───────────────────────────────────────────────────────────────────

function requireAdmin(req, res) {
  const token = req.headers['x-admin-token'] || new URL(req.url, 'http://x').searchParams.get('token');
  if (token !== config.adminToken) { sendJson(res, 401, { ok: false, error: 'unauthorized' }); return false; }
  return true;
}

// Список «оплачен, но не выдан».
router.get('/admin/api/orders', (req, res, { query }) => {
  if (!requireAdmin(req, res)) return;
  // Фильтр — только из белого списка: строка из запроса в SQL не попадает.
  const STATUSES = ['created', 'paid', 'delivering', 'delivered',
    'payment_failed', 'out_of_stock', 'delivery_failed'];
  const filter = query.get('filter') || 'stuck';
  const wanted = filter === 'all' ? STATUSES
    : filter === 'stuck' ? ['paid', 'delivering', 'out_of_stock', 'delivery_failed']
      : STATUSES.includes(filter) ? [filter] : [];
  if (wanted.length === 0) return sendJson(res, 400, { ok: false, error: 'bad_filter' });

  const rows = all(
    `SELECT o.*, f.code AS delivered_code, p.name AS product_name
       FROM orders o
       LEFT JOIN fulfillments f ON f.order_id = o.id
       LEFT JOIN products p ON p.sku = o.sku
      WHERE o.status IN (${wanted.map(() => '?').join(',')})
      ORDER BY o.updated_at DESC LIMIT 200`,
    ...wanted
  );
  sendJson(res, 200, {
    ok: true,
    orders: rows.map((o) => ({
      id: o.id, sku: o.sku, product_name: o.product_name, status: o.status,
      amount: o.amount_minor / 100, currency: o.currency, attempt: o.attempt,
      promo_code: o.promo_code, code: o.delivered_code, last_error: o.last_error,
      lease_until: o.lease_until, created_at: o.created_at, updated_at: o.updated_at,
    })),
  });
});

// Безопасная ручная повторная выдача. Идемпотентна: уже выданный заказ не меняется.
router.post('/admin/api/orders/:id/retry', async (req, res, { params }) => {
  if (!requireAdmin(req, res)) return;
  const before = orders.getOrder(params.id);
  if (!before) return sendJson(res, 404, { ok: false, error: 'not_found' });
  logEvent(params.id, 'admin.retry', 'ручная повторная выдача');
  const r = await fulfill(params.id);
  sendJson(res, 200, { ok: true, result: r, order: orders.getOrder(params.id) });
});

router.get('/admin/api/stock', (req, res) => {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { ok: true, stock: providers.stockSummary(), chaos: providers.getChaos() });
});

router.post('/admin/api/stock/topup', async (req, res, { body }) => {
  if (!requireAdmin(req, res)) return;
  const added = providers.topUp(String(body.provider || 'A').toUpperCase(), Math.min(Number(body.count) || 1, 500));
  sendJson(res, 200, { ok: true, added: added.length, codes: added, stock: providers.stockSummary() });
});

router.post('/admin/api/stock/drain', async (req, res, { body }) => {
  if (!requireAdmin(req, res)) return;
  const out = {};
  for (const p of body.provider ? [String(body.provider).toUpperCase()] : ['A', 'B']) {
    out[p] = providers.drain(p);
  }
  sendJson(res, 200, { ok: true, drained: out, stock: providers.stockSummary() });
});

router.post('/admin/api/chaos', async (req, res, { body }) => {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { ok: true, chaos: providers.setChaos(body) });
});

router.get('/admin/api/promocodes', (req, res) => {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { ok: true, promocodes: all('SELECT * FROM promocodes ORDER BY code') });
});

// Сводка целостности — используется скриптами проверок.
router.get('/admin/api/integrity', (req, res) => {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, {
    ok: true,
    // Следующий id заказа — нужен сценарию «вебхук пришёл раньше заказа».
    next_order_id: 'ord_' + String((get("SELECT value FROM counters WHERE name = 'order'")?.value ?? 0) + 1).padStart(5, '0'),
    orders_total: get('SELECT COUNT(*) c FROM orders').c,
    fulfillments_total: get('SELECT COUNT(*) c FROM fulfillments').c,
    distinct_codes: get('SELECT COUNT(DISTINCT code) c FROM fulfillments').c,
    codes_claimed: get('SELECT COUNT(*) c FROM provider_stock WHERE claimed_by IS NOT NULL').c,
    codes_free: get('SELECT COUNT(*) c FROM provider_stock WHERE claimed_by IS NULL').c,
    provider_issues: get('SELECT COUNT(*) c FROM provider_issues').c,
    webhook_events: get('SELECT COUNT(*) c FROM webhook_events').c,
    by_status: all('SELECT status, COUNT(*) c FROM orders GROUP BY status'),
    promocodes: all('SELECT code, used_count, max_uses FROM promocodes ORDER BY code'),
  });
});

router.get('/api/health', (req, res) => sendJson(res, 200, { ok: true, pid: process.pid }));

module.exports = router;
