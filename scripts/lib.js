'use strict';
// Общие утилиты для скриптов проверки гонок.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const ADMIN = process.env.ADMIN_TOKEN || 'dev-admin-token';

const j = (r) => r.json();

async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await j(res).catch(() => ({}));
  return { status: res.status, data };
}

const admin = (method, path, body) => api(method, path, body, { 'x-admin-token': ADMIN });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ждём, пока заказ дойдёт до терминального или восстановимого состояния. */
async function waitForOrder(id, predicate, { timeoutMs = 30000, everyMs = 150 } = {}) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    const { data } = await api('GET', `/api/orders/${id}`);
    last = data.order;
    if (last && predicate(last)) return last;
    await sleep(everyMs);
  }
  return last;
}

const settled = (o) =>
  o && ['delivered', 'payment_failed', 'out_of_stock', 'delivery_failed'].includes(o.status);

// ── Отчётность ────────────────────────────────────────────────────────────────
const C = { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[90m', b: '\x1b[1m', off: '\x1b[0m' };
const state = { passed: 0, failed: 0, failures: [] };

function check(label, condition, detail = '') {
  if (condition) {
    state.passed++;
    console.log(`  ${C.ok}✓${C.off} ${label}${detail ? ` ${C.dim}${detail}${C.off}` : ''}`);
  } else {
    state.failed++;
    state.failures.push(label);
    console.log(`  ${C.bad}✗ ${label}${C.off}${detail ? ` ${detail}` : ''}`);
  }
  return condition;
}

function head(title) { console.log(`\n${C.b}${title}${C.off}`); }
function note(text) { console.log(`  ${C.dim}${text}${C.off}`); }

function summary() {
  const total = state.passed + state.failed;
  console.log(`\n${C.b}Итог:${C.off} ${state.failed === 0 ? C.ok : C.bad}${state.passed}/${total} проверок пройдено${C.off}`);
  if (state.failed) console.log(`${C.bad}Провалено:${C.off}\n  - ` + state.failures.join('\n  - '));
  return state.failed === 0;
}

/** Настроить «хаос» поставщиков детерминированно. */
const chaos = (a, b = a) => admin('POST', '/admin/api/chaos', { A: a, B: b });

const NO_CHAOS = { errorRate: 0, timeoutRate: 0, latencyMs: 5 };

module.exports = { BASE, ADMIN, api, admin, sleep, waitForOrder, settled, check, head, note, summary, chaos, NO_CHAOS, C, state };
