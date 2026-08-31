'use strict';
/**
 * HTTP-клиент к заглушкам поставщиков. Ходим именно по сети (через свой же порт),
 * чтобы таймауты и «зависания» были настоящими, а не имитацией внутри процесса.
 */
const config = require('../config');

async function callIssue(provider, payload, timeoutMs = config.providerTimeoutMs) {
  const url = `${config.selfUrl}/provider/${provider.toLowerCase()}/issue`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.status === 'ok' && body.code) {
      return { outcome: 'ok', code: body.code, replay: !!body.replay };
    }
    if (res.status === 409 || body.reason === 'out_of_stock') {
      return { outcome: 'out_of_stock', reason: body.reason || 'out_of_stock' };
    }
    return { outcome: 'error', reason: body.reason || `http_${res.status}` };
  } catch (err) {
    // ВАЖНО: таймаут ≠ отказ. Код мог быть выдан, а ответ не дошёл.
    if (err.name === 'AbortError') return { outcome: 'timeout', reason: 'timeout' };
    return { outcome: 'error', reason: err.code || err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Вернуть поставщику неиспользованный код (best-effort, не влияет на исход заказа). */
async function callRelease(provider, request_id) {
  try {
    await fetch(`${config.selfUrl}/provider/${provider.toLowerCase()}/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id }),
      signal: AbortSignal.timeout(2000),
    });
  } catch { /* не критично */ }
}

module.exports = { callIssue, callRelease };
