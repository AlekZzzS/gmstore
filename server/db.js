'use strict';
// node:sqlite помечен как экспериментальный — предупреждение шумит в выводе тестов.
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = (w, ...rest) => {
  if (String(w).includes('SQLite is an experimental feature')) return;
  return _emitWarning(w, ...rest);
};

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new DatabaseSync(config.dbFile);

// WAL + busy_timeout — чтобы гарантии работали и при нескольких процессах (CLUSTER=N),
// а не только благодаря однопоточности одного Node-процесса.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA synchronous = NORMAL');

const SCHEMA = `
-- ── Каталог ────────────────────────────────────────────────────────────────────
-- Деньги везде в минорных единицах (копейках) целым числом: никакой плавающей точки.
CREATE TABLE IF NOT EXISTS products (
  sku          TEXT PRIMARY KEY,
  name         TEXT    NOT NULL,
  type         TEXT    NOT NULL,
  price_minor  INTEGER NOT NULL CHECK (price_minor >= 0),
  currency     TEXT    NOT NULL,
  image        TEXT,
  purchasable  INTEGER NOT NULL DEFAULT 1
);

-- ── Склад поставщика ───────────────────────────────────────────────────────────
-- Это склад ВНЕШНЕГО поставщика, а не наш. Ключ считается израсходованным,
-- как только он закреплён за request_id.
CREATE TABLE IF NOT EXISTS provider_stock (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT NOT NULL,
  code        TEXT NOT NULL,
  claimed_by  TEXT,            -- request_id; NULL = свободен
  claimed_at  TEXT,
  UNIQUE (provider, code)
);
-- Один и тот же ключ физически не может быть закреплён дважды.
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_code ON provider_stock(code);
CREATE INDEX IF NOT EXISTS ix_stock_free ON provider_stock(provider, id) WHERE claimed_by IS NULL;

-- Журнал выдач поставщика. PK по request_id = «таймаут ≠ отказ»:
-- повтор с тем же request_id обязан вернуть ТОТ ЖЕ код.
CREATE TABLE IF NOT EXISTS provider_issues (
  request_id  TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  code        TEXT NOT NULL,
  order_id    TEXT,
  released    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

-- ── Заказы ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  sku             TEXT    NOT NULL REFERENCES products(sku),
  status          TEXT    NOT NULL CHECK (status IN (
                    'created','paid','delivering','delivered',
                    'payment_failed','out_of_stock','delivery_failed')),
  base_minor      INTEGER NOT NULL,
  discount_minor  INTEGER NOT NULL DEFAULT 0,
  amount_minor    INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency        TEXT    NOT NULL,
  promo_code      TEXT,
  steam_login     TEXT,
  attempt         INTEGER NOT NULL DEFAULT 0,
  lease_owner     TEXT,
  lease_until     INTEGER,       -- epoch ms
  paid_event_id   TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_orders_status ON orders(status, updated_at);

-- РОВНО ОДИН факт выдачи на заказ (PK) и один код — не более чем в один заказ (UNIQUE).
CREATE TABLE IF NOT EXISTS fulfillments (
  order_id    TEXT PRIMARY KEY REFERENCES orders(id),
  code        TEXT NOT NULL UNIQUE,
  provider    TEXT NOT NULL,
  request_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- Попытки выдачи. Нужны, чтобы при восстановлении СНАЧАЛА переспросить
-- старые request_id (провайдер мог выдать код, а ответ не дошёл).
CREATE TABLE IF NOT EXISTS delivery_attempts (
  request_id  TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  attempt     INTEGER NOT NULL,
  provider    TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('pending','ok','error','timeout','out_of_stock')),
  code        TEXT,
  reason      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_attempts_order ON delivery_attempts(order_id, attempt);

-- Идемпотентность создания заказа: двойной клик «Купить» = один заказ.
CREATE TABLE IF NOT EXISTS order_idempotency (
  key         TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- ── Вебхуки оплаты ─────────────────────────────────────────────────────────────
-- PK по event_id закрывает at-least-once. applied_at IS NULL = событие пришло
-- раньше заказа и ждёт «догоняющего» применения (не по порядку).
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id     TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL,
  status       TEXT NOT NULL,
  amount_minor INTEGER,
  currency     TEXT,
  payload      TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  applied_at   TEXT,
  outcome      TEXT
);
CREATE INDEX IF NOT EXISTS ix_webhook_pending ON webhook_events(order_id) WHERE applied_at IS NULL;

-- ── Промокоды ──────────────────────────────────────────────────────────────────
-- CHECK — последняя линия обороны: перерасход лимита невозможен на уровне БД.
CREATE TABLE IF NOT EXISTS promocodes (
  code        TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('percent','amount')),
  value       INTEGER NOT NULL,
  currency    TEXT,
  max_uses    INTEGER NOT NULL,
  used_count  INTEGER NOT NULL DEFAULT 0,
  CHECK (used_count >= 0 AND used_count <= max_uses)
);

-- Один заказ — не больше одного списания промокода (PK).
CREATE TABLE IF NOT EXISTS promo_redemptions (
  order_id      TEXT PRIMARY KEY REFERENCES orders(id),
  code          TEXT NOT NULL REFERENCES promocodes(code),
  amount_minor  INTEGER NOT NULL,
  released      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_promo_redemptions_code ON promo_redemptions(code);

-- ── Журнал событий заказа (для страницы статуса и админки) ─────────────────────
CREATE TABLE IF NOT EXISTS order_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL,
  type        TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_order_events ON order_events(order_id, id);

-- Общие настройки рантайма. В БД, а не в памяти процесса, чтобы при CLUSTER=N
-- их видели все воркеры (например, «хаос» поставщиков в сценариях проверки).
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Счётчик для человекочитаемых id заказов.
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
`;

db.exec(SCHEMA);

// ── Хелперы ──────────────────────────────────────────────────────────────────

/** Нарушение ограничения (UNIQUE / PK / CHECK) — младший байт кода SQLite = 19. */
function isConstraintError(err) {
  return !!err && typeof err.errcode === 'number' && (err.errcode & 0xff) === 19;
}

const cache = new Map();
/** Подготовленные выражения кэшируются по тексту запроса. */
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
const run = (sql, ...a) => stmt(sql).run(...a);
const get = (sql, ...a) => stmt(sql).get(...a);
const all = (sql, ...a) => stmt(sql).all(...a);

/**
 * Пишущая транзакция. BEGIN IMMEDIATE берёт write-lock сразу, поэтому
 * два процесса не могут одновременно оказаться внутри критической секции.
 * При SQLITE_BUSY повторяем с небольшим бэк-оффом.
 */
function tx(fn, { retries = 40 } = {}) {
  for (let i = 0; ; i++) {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      if (i < retries && /busy|locked/i.test(err.message)) { sleep(5 + i); continue; }
      throw err;
    }
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* уже откачено */ }
      if (i < retries && /busy|locked/i.test(err.message) && !isConstraintError(err)) {
        sleep(5 + i);
        continue;
      }
      throw err;
    }
  }
}

// Короткая синхронная пауза для бэк-оффа внутри транзакционного ретрая.
const sab = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) { Atomics.wait(sab, 0, 0, ms); }

const nowIso = () => new Date().toISOString();

function logEvent(orderId, type, detail) {
  run(
    'INSERT INTO order_events(order_id, type, detail, created_at) VALUES (?,?,?,?)',
    orderId, type, detail == null ? null : String(detail), nowIso()
  );
}

/** Следующий номер заказа. Вызывать только внутри tx(). */
function nextOrderId() {
  run("INSERT INTO counters(name, value) VALUES ('order', 0) ON CONFLICT(name) DO NOTHING");
  run("UPDATE counters SET value = value + 1 WHERE name = 'order'");
  const { value } = get("SELECT value FROM counters WHERE name = 'order'");
  return 'ord_' + String(value).padStart(5, '0');
}

module.exports = { db, tx, run, get, all, stmt, isConstraintError, nowIso, logEvent, nextOrderId, sleep };
