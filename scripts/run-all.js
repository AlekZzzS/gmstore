'use strict';
/**
 * Полный прогон проверок приёмки.
 *
 * Поднимает СВОЙ сервер на отдельном порту и отдельной БД, по умолчанию в
 * режиме кластера из 4 процессов. Это принципиально: гарантии однократной
 * выдачи держатся на ограничениях SQLite (WAL + BEGIN IMMEDIATE + UNIQUE),
 * а не на однопоточности одного Node-процесса — и здесь это видно.
 *
 *   node scripts/run-all.js              # кластер из 4 процессов
 *   node scripts/run-all.js --workers 1  # один процесс
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const PORT = Number(argOf('--port', 3111));
const WORKERS = Number(argOf('--workers', 4));
const DB = path.join(process.env.TEST_DB_DIR || path.join(__dirname, '..', 'data'), `test-${Date.now()}.db`);
const TOKEN = 'test-token';

process.env.BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.ADMIN_TOKEN = TOKEN;

const C = { b: '\x1b[1m', ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[90m', off: '\x1b[0m' };

async function waitHealthy(url, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url + '/api/health');
      if (r.ok) return true;
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function main() {
  console.log(`${C.b}Проверка надёжности магазина${C.off}`);
  console.log(`${C.dim}порт ${PORT} · процессов: ${WORKERS} · БД: ${path.basename(DB)}${C.off}`);

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CLUSTER: String(WORKERS),
      DB_FILE: DB,
      ADMIN_TOKEN: TOKEN,
      // Быстрее подхватываем зависшие выдачи, чтобы прогон не тянулся.
      DELIVERY_LEASE_MS: '6000',
      SWEEPER_INTERVAL_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (d) => serverLog.push(d.toString()));
  server.stderr.on('data', (d) => serverLog.push(d.toString()));

  const cleanup = () => {
    try { server.kill('SIGTERM'); } catch { /* уже мёртв */ }
    setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* ok */ } }, 500).unref();
    for (const s of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB + s); } catch { /* нет файла */ }
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  if (!await waitHealthy(process.env.BASE_URL)) {
    console.error(`${C.bad}Сервер не поднялся${C.off}\n` + serverLog.join(''));
    process.exit(1);
  }

  // lib подключаем ПОСЛЕ выставления BASE_URL/ADMIN_TOKEN.
  const lib = require('./lib');
  const suites = [
    ['Этап 2 · двойной клик «Купить»', require('./race-buy')],
    ['Этап 2 · вебхуки под гонками', require('./race-webhooks')],
    ['Этап 3 · сбои и восстановление', require('./race-recovery')],
    ['Этап 4 · промокоды с лимитом', require('./race-promo')],
    ['Нагрузка · целостность на потоке заказов', require('./stress')],
  ];

  for (const [title, run] of suites) {
    console.log(`\n${C.b}${'─'.repeat(64)}${C.off}\n${C.b}${title}${C.off}`);
    await run();
  }

  // Финальная сверка инвариантов по всей базе.
  console.log(`\n${C.b}${'─'.repeat(64)}${C.off}`);
  lib.head('Итоговая целостность базы');
  const it = (await lib.admin('GET', '/admin/api/integrity')).data;
  lib.note(`заказов ${it.orders_total} · выдач ${it.fulfillments_total} · уникальных кодов ${it.distinct_codes}`);
  lib.note(`ключей занято ${it.codes_claimed}, свободно ${it.codes_free} · вебхуков ${it.webhook_events}`);
  lib.note('статусы: ' + it.by_status.map((s) => `${s.status}=${s.c}`).join(' '));
  lib.check('ни один ключ не выдан в два заказа', it.fulfillments_total === it.distinct_codes,
    `${it.fulfillments_total} / ${it.distinct_codes}`);
  lib.check('нет заказов, застрявших в delivering',
    !it.by_status.some((s) => s.status === 'delivering' && s.c > 0));
  lib.check('ни один промокод не превысил лимит',
    it.promocodes.every((p) => p.used_count <= p.max_uses),
    it.promocodes.map((p) => `${p.code} ${p.used_count}/${p.max_uses}`).join(', '));

  const ok = lib.summary();
  console.log(ok
    ? `\n${C.ok}${C.b}ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ${C.off}`
    : `\n${C.bad}${C.b}ЕСТЬ ПРОВАЛЕННЫЕ ПРОВЕРКИ${C.off}`);
  cleanup();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
