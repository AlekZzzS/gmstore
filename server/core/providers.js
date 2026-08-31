'use strict';
/**
 * Две заглушки-поставщика по «Контракту поставщика выдачи».
 *
 * Ключевое место — ЛОВУШКА ТАЙМАУТА: код закрепляется за request_id и
 * коммитится в БД ДО того, как заглушка решит «зависнуть». То есть таймаут
 * на нашей стороне вполне может означать, что код уже выдан. Повтор с тем же
 * request_id обязан вернуть тот же самый код и не тронуть склад.
 */
const { tx, run, get, all, nowIso, isConstraintError } = require('../db');
const config = require('../config');

// Настраивается в рантайме через POST /admin/api/chaos — чтобы сценарии
// воспроизводились детерминированно, а не «как повезёт».
// Хранится в БД, а не в памяти: при CLUSTER=N настройку должны видеть все воркеры.
const CHAOS_KEY = 'provider_chaos';

function getChaos() {
  const row = get('SELECT value FROM settings WHERE key = ?', CHAOS_KEY);
  if (!row) return { A: { ...config.chaosDefaults.A }, B: { ...config.chaosDefaults.B } };
  try {
    const saved = JSON.parse(row.value);
    return {
      A: { ...config.chaosDefaults.A, ...saved.A },
      B: { ...config.chaosDefaults.B, ...saved.B },
    };
  } catch {
    return { A: { ...config.chaosDefaults.A }, B: { ...config.chaosDefaults.B } };
  }
}

function setChaos(patch = {}) {
  return tx(() => {
    const current = getChaos();
    for (const p of ['A', 'B']) {
      if (!patch[p]) continue;
      for (const k of ['errorRate', 'timeoutRate', 'latencyMs']) {
        if (patch[p][k] !== undefined) current[p][k] = Number(patch[p][k]);
      }
    }
    run(
      "INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      CHAOS_KEY, JSON.stringify(current)
    );
    return current;
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST /issue — выдать код.
 * Возвращает { httpStatus, body } либо { hang: true } (ответа не будет вовсе).
 */
async function issue(provider, { request_id, sku, order_id }) {
  const cfg = getChaos()[provider];
  if (!cfg) return { httpStatus: 404, body: { status: 'error', reason: 'unknown_provider' } };
  if (!request_id) return { httpStatus: 400, body: { status: 'error', reason: 'request_id_required' } };

  await delay(cfg.latencyMs);

  // 1. Повтор по тому же request_id: всегда тот же код, склад не трогаем.
  const prior = get('SELECT * FROM provider_issues WHERE request_id = ?', request_id);
  if (prior) {
    // Даже на повторе поставщик может «зависнуть» — это допустимо и делает тест злее.
    if (Math.random() < cfg.timeoutRate) return { hang: true, replay: true };
    return { httpStatus: 200, body: { status: 'ok', request_id, code: prior.code, replay: true } };
  }

  // 2. Случайный отказ ДО списания со склада — код не выдан.
  if (Math.random() < cfg.errorRate) {
    return { httpStatus: 503, body: { status: 'error', reason: 'provider_unavailable' } };
  }

  // 3. Атомарный захват свободного ключа + запись в журнал выдач.
  let result;
  try {
    result = tx(() => {
      // Победитель определяется результатом UPDATE, а не предварительным SELECT.
      const upd = run(
        `UPDATE provider_stock
            SET claimed_by = ?, claimed_at = ?
          WHERE id = (SELECT id FROM provider_stock
                       WHERE provider = ? AND claimed_by IS NULL
                       ORDER BY id LIMIT 1)
            AND claimed_by IS NULL`,
        request_id, nowIso(), provider
      );
      if (upd.changes !== 1) return { outOfStock: true };

      const row = get('SELECT code FROM provider_stock WHERE claimed_by = ?', request_id);
      run(
        'INSERT INTO provider_issues(request_id, provider, code, order_id, created_at) VALUES (?,?,?,?,?)',
        request_id, provider, row.code, order_id ?? null, nowIso()
      );
      return { code: row.code };
    });
  } catch (err) {
    if (isConstraintError(err)) {
      // Гонка по одному request_id: кто-то уже записал выдачу — отдаём её.
      const again = get('SELECT * FROM provider_issues WHERE request_id = ?', request_id);
      if (again) return { httpStatus: 200, body: { status: 'ok', request_id, code: again.code, replay: true } };
    }
    throw err;
  }

  if (result.outOfStock) {
    return { httpStatus: 409, body: { status: 'error', reason: 'out_of_stock' } };
  }

  // 4. ЛОВУШКА: код уже закоммичен, а ответа клиент не получит.
  if (Math.random() < cfg.timeoutRate) return { hang: true };

  return { httpStatus: 200, body: { status: 'ok', request_id, code: result.code } };
}

/**
 * POST /release — вернуть на склад код, который магазин в итоге не использовал
 * (например, победил код от резервного поставщика). Идемпотентно.
 */
function release(provider, request_id) {
  return tx(() => {
    const iss = get('SELECT * FROM provider_issues WHERE request_id = ? AND provider = ?', request_id, provider);
    if (!iss) return { released: false, reason: 'unknown_request' };
    if (iss.released) return { released: false, reason: 'already_released' };
    // Нельзя вернуть код, который уже отдан покупателю.
    const used = get('SELECT 1 x FROM fulfillments WHERE code = ?', iss.code);
    if (used) return { released: false, reason: 'code_delivered' };

    run('UPDATE provider_issues SET released = 1 WHERE request_id = ? AND released = 0', request_id);
    run('UPDATE provider_stock SET claimed_by = NULL, claimed_at = NULL WHERE claimed_by = ?', request_id);
    return { released: true, code: iss.code };
  });
}

function stockSummary() {
  const rows = all(
    `SELECT provider,
            COUNT(*) AS total,
            SUM(CASE WHEN claimed_by IS NULL THEN 1 ELSE 0 END) AS free
       FROM provider_stock GROUP BY provider ORDER BY provider`
  );
  return rows.map((r) => ({ provider: r.provider, total: r.total, free: r.free, claimed: r.total - r.free }));
}

/** Пополнение склада поставщика (для сценария «остаток закончился»). */
function topUp(provider, count) {
  return tx(() => {
    const added = [];
    for (let i = 0; i < count; i++) {
      // Код гарантированно уникален: UNIQUE(code) не даст завести дубль.
      const code = ['RSTK', rand4(), rand4()].join('-');
      try {
        run('INSERT INTO provider_stock(provider, code) VALUES (?,?)', provider, code);
        added.push(code);
      } catch (err) {
        if (!isConstraintError(err)) throw err;
        i--; // коллизия кода — пробуем ещё раз
      }
    }
    return added;
  });
}

/** Опустошить склад поставщика (для сценария out_of_stock). Свободные ключи «прячем». */
function drain(provider) {
  return tx(() => {
    const r = run(
      "UPDATE provider_stock SET claimed_by = 'drained:' || id, claimed_at = ? WHERE provider = ? AND claimed_by IS NULL",
      nowIso(), provider
    );
    return { drained: r.changes };
  });
}

const rand4 = () => Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X');

module.exports = { issue, release, stockSummary, topUp, drain, getChaos, setChaos };
