'use strict';
/**
 * ДВИЖОК ОДНОКРАТНОЙ ВЫДАЧИ.
 *
 * Правило всего файла: решение принимает БД, а не JavaScript.
 * Ни одна проверка вида `if (order.status === 'paid')` не является основанием
 * для действия — основанием является либо `UPDATE ... WHERE <ожидаемое состояние>`
 * с `changes === 1`, либо успешный INSERT в таблицу с UNIQUE-ограничением.
 * Проигравшие гонку получают changes === 0 / SQLITE_CONSTRAINT и становятся no-op.
 *
 * Четыре независимых рубежа:
 *   1. webhook_events.event_id   (PK)     — повтор вебхука
 *   2. CAS-переход orders.status           — единственный победитель среди N параллельных
 *   3. fulfillments.order_id (PK) + code (UNIQUE) — один факт выдачи, один код в один заказ
 *   4. provider_issues.request_id (PK)     — таймаут ≠ отказ
 */
const { tx, run, get, all, nowIso, logEvent, isConstraintError } = require('../db');
const { callIssue, callRelease } = require('./providerClient');
const config = require('../config');

const WORKER = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const RECOVERABLE = ['out_of_stock', 'delivery_failed'];
const TERMINAL = ['delivered', 'payment_failed'];

// ── Рубеж 2: захват «аренды» на выдачу ────────────────────────────────────────

/**
 * Пытается стать единственным исполнителем выдачи по заказу.
 * Забрать аренду можно из paid / out_of_stock / delivery_failed,
 * а также из delivering с протухшей арендой (процесс упал в середине выдачи).
 */
function claimLease(orderId) {
  return tx(() => {
    const order = get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!order) return { claimed: false, reason: 'unknown_order' };
    if (order.status === 'delivered') {
      const f = get('SELECT * FROM fulfillments WHERE order_id = ?', orderId);
      return { claimed: false, reason: 'already_delivered', code: f && f.code };
    }
    if (TERMINAL.includes(order.status)) return { claimed: false, reason: order.status };
    if (order.status === 'created') return { claimed: false, reason: 'not_paid' };

    const now = Date.now();
    const upd = run(
      `UPDATE orders
          SET status = 'delivering',
              attempt = attempt + 1,
              lease_owner = ?, lease_until = ?, updated_at = ?
        WHERE id = ?
          AND ( status IN ('paid','out_of_stock','delivery_failed')
                OR (status = 'delivering' AND (lease_until IS NULL OR lease_until < ?)) )`,
      WORKER, now + config.deliveryLeaseMs, nowIso(), orderId, now
    );
    if (upd.changes !== 1) return { claimed: false, reason: 'busy' };

    const fresh = get('SELECT attempt FROM orders WHERE id = ?', orderId);
    logEvent(orderId, 'delivery.started', `attempt=${fresh.attempt} worker=${WORKER}`);
    return { claimed: true, attempt: fresh.attempt, sku: order.sku };
  });
}

function releaseLease(orderId, nextStatus, lastError) {
  tx(() => {
    run(
      `UPDATE orders
          SET status = ?, lease_owner = NULL, lease_until = NULL,
              last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'delivering' AND lease_owner = ?`,
      nextStatus, lastError ?? null, nowIso(), orderId, WORKER
    );
  });
}

// ── Рубеж 4: работа с поставщиками ────────────────────────────────────────────

function recordAttempt(orderId, attempt, provider, requestId) {
  tx(() => {
    run(
      `INSERT INTO delivery_attempts(request_id, order_id, attempt, provider, state, created_at, updated_at)
       VALUES (?,?,?,?, 'pending', ?, ?)
       ON CONFLICT(request_id) DO NOTHING`,
      requestId, orderId, attempt, provider, nowIso(), nowIso()
    );
  });
}

function updateAttempt(requestId, state, { code, reason } = {}) {
  tx(() => {
    run(
      'UPDATE delivery_attempts SET state = ?, code = COALESCE(?, code), reason = ?, updated_at = ? WHERE request_id = ?',
      state, code ?? null, reason ?? null, nowIso(), requestId
    );
  });
}

/**
 * ПЕРЕД новой попыткой переспрашиваем все прошлые request_id.
 * Поставщик мог выдать код, а ответ до нас не дошёл (таймаут/5xx после коммита).
 * Без этого шага повторная выдача сожгла бы ещё один ключ из пула.
 */
async function reconcilePriorAttempts(orderId) {
  const prior = all(
    `SELECT * FROM delivery_attempts
      WHERE order_id = ? AND state IN ('pending','timeout','error')
      ORDER BY attempt, rowid`,
    orderId
  );
  for (const a of prior) {
    const res = await callIssue(a.provider, { request_id: a.request_id, order_id: orderId });
    if (res.outcome === 'ok') {
      updateAttempt(a.request_id, 'ok', { code: res.code });
      logEvent(orderId, 'delivery.reconciled', `${a.request_id} уже был выдан поставщиком ${a.provider}`);
      return { code: res.code, provider: a.provider, request_id: a.request_id };
    }
    if (res.outcome === 'out_of_stock') updateAttempt(a.request_id, 'out_of_stock', { reason: res.reason });
    else if (res.outcome === 'timeout') updateAttempt(a.request_id, 'timeout', { reason: 'timeout' });
    // error оставляем как есть — переспросим на следующем восстановлении
  }
  return null;
}

/** Основной путь: поставщик A (N попыток с ОДНИМ request_id), затем резервный B. */
async function requestFromProviders(orderId, attempt, sku) {
  let sawOutOfStock = false;
  let lastReason = null;

  for (const provider of ['A', 'B']) {
    const requestId = `req_${orderId}-${provider.toLowerCase()}${attempt}`;
    recordAttempt(orderId, attempt, provider, requestId);

    for (let i = 0; i < config.providerRetriesPerProvider; i++) {
      // request_id НЕ меняется между ретраями — иначе повтор после таймаута
      // выдал бы второй код.
      const res = await callIssue(provider, { request_id: requestId, sku, order_id: orderId });

      if (res.outcome === 'ok') {
        updateAttempt(requestId, 'ok', { code: res.code });
        return { code: res.code, provider, request_id: requestId };
      }
      if (res.outcome === 'out_of_stock') {
        updateAttempt(requestId, 'out_of_stock', { reason: res.reason });
        sawOutOfStock = true;
        lastReason = 'out_of_stock';
        break; // у этого поставщика пусто — ретраи бессмысленны
      }
      updateAttempt(requestId, res.outcome === 'timeout' ? 'timeout' : 'error', { reason: res.reason });
      lastReason = res.reason;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
  return { code: null, sawOutOfStock, reason: lastReason };
}

// ── Рубеж 3: фиксация выдачи ──────────────────────────────────────────────────

/**
 * Единственная точка, где код становится «выданным».
 * PK по order_id не даст двух фактов выдачи, UNIQUE по code не даст
 * одному ключу уйти в два заказа.
 */
function commitDelivery(orderId, issued) {
  return tx(() => {
    const existing = get('SELECT * FROM fulfillments WHERE order_id = ?', orderId);
    if (existing) {
      // Заказ уже выдан (гонка или повторный вызов) — новый код не наш, вернём поставщику.
      return { status: 'delivered', code: existing.code, duplicate: true, orphan: issued };
    }
    try {
      run(
        'INSERT INTO fulfillments(order_id, code, provider, request_id, created_at) VALUES (?,?,?,?,?)',
        orderId, issued.code, issued.provider, issued.request_id, nowIso()
      );
    } catch (err) {
      if (!isConstraintError(err)) throw err;
      const again = get('SELECT * FROM fulfillments WHERE order_id = ?', orderId);
      if (again) return { status: 'delivered', code: again.code, duplicate: true, orphan: issued };
      // UNIQUE сработал по code: этот ключ уже принадлежит другому заказу.
      // Это нарушение инвариантов склада — не выдаём, помечаем заказ восстановимым.
      logEvent(orderId, 'delivery.integrity_error', `код ${issued.code} уже привязан к другому заказу`);
      return { status: 'delivery_failed', integrityError: true };
    }

    run(
      `UPDATE orders SET status = 'delivered', lease_owner = NULL, lease_until = NULL,
                         last_error = NULL, updated_at = ?
        WHERE id = ? AND status <> 'delivered'`,
      nowIso(), orderId
    );
    logEvent(orderId, 'delivery.delivered', `${issued.provider} / ${issued.request_id}`);
    return { status: 'delivered', code: issued.code };
  });
}

// ── Публичная точка входа ─────────────────────────────────────────────────────

/**
 * Идемпотентная выдача. Безопасно вызывать сколько угодно раз, параллельно,
 * из нескольких процессов: лишние вызовы становятся no-op.
 */
async function fulfill(orderId) {
  const lease = claimLease(orderId);
  if (!lease.claimed) return { ok: lease.reason === 'already_delivered', ...lease };

  try {
    // 1. Сначала забираем то, что поставщик, возможно, уже выдал по старым request_id.
    let issued = await reconcilePriorAttempts(orderId);

    // 2. Если нечего забирать — новые запросы к A и B.
    let failure = null;
    if (!issued) {
      const res = await requestFromProviders(orderId, lease.attempt, lease.sku);
      if (res.code) issued = res;
      else failure = res;
    }

    if (issued) {
      const result = commitDelivery(orderId, issued);
      if (result.integrityError) {
        releaseLease(orderId, 'delivery_failed', 'integrity: код уже привязан к другому заказу');
        return { ok: false, status: 'delivery_failed' };
      }
      // Осиротевший код (заказ уже был выдан другим путём) возвращаем на склад.
      if (result.orphan) await callRelease(result.orphan.provider, result.orphan.request_id);
      // Отпускаем всё, что поставщики успели выдать по этому заказу, но что не
      // ушло покупателю: классический случай — A «завис» уже ПОСЛЕ выдачи кода,
      // и заказ закрыл резервный B. Без этого шага ключ утекал бы со склада.
      await releaseUnusedAttempts(orderId, result.code);
      return { ok: true, status: 'delivered', code: result.code };
    }

    // 3. Кода нет — заказ переходит в ВОССТАНОВИМОЕ состояние, а не падает.
    const next = failure && failure.sawOutOfStock ? 'out_of_stock' : 'delivery_failed';
    releaseLease(orderId, next, failure && failure.reason);
    logEvent(orderId, `delivery.${next}`, failure && failure.reason);
    return { ok: false, status: next, reason: failure && failure.reason };
  } catch (err) {
    releaseLease(orderId, 'delivery_failed', String(err && err.message));
    logEvent(orderId, 'delivery.exception', String(err && err.message));
    return { ok: false, status: 'delivery_failed', reason: String(err && err.message) };
  }
}

/**
 * Возврат поставщикам кодов, выданных по этому заказу, но не доставшихся клиенту.
 * Best-effort и идемпотентно: сам поставщик откажется отпускать код,
 * который числится выданным в fulfillments.
 */
async function releaseUnusedAttempts(orderId, deliveredCode) {
  const attempts = all(
    "SELECT request_id, provider, code FROM delivery_attempts WHERE order_id = ? AND state IN ('pending','timeout','ok','error')",
    orderId
  );
  for (const a of attempts) {
    if (a.code === deliveredCode) continue;
    await callRelease(a.provider, a.request_id);
  }
}

/** Запуск выдачи в фоне: вебхук обязан отвечать быстро (см. контракт). */
function fulfillInBackground(orderId) {
  setImmediate(() => {
    fulfill(orderId).catch((err) => console.error('[fulfill]', orderId, err));
  });
}

module.exports = { fulfill, fulfillInBackground, claimLease, RECOVERABLE, TERMINAL, WORKER };
