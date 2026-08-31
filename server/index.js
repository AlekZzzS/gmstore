'use strict';
const http = require('node:http');
const cluster = require('node:cluster');
const config = require('./config');
const { sendJson, readBody, serveStatic } = require('./http');

// CLUSTER=N поднимает N процессов на одном порту. Это важно: гарантии
// однократной выдачи держатся на ограничениях SQLite (WAL + BEGIN IMMEDIATE),
// а не на однопоточности одного процесса — и это можно проверить.
if (cluster.isPrimary && config.cluster > 1) {
  console.log(`[primary ${process.pid}] запускаю ${config.cluster} воркеров`);
  // Схему и данные готовим один раз в мастере, чтобы воркеры не гонялись за неё.
  require('./db');
  require('./seed').seed();
  for (let i = 0; i < config.cluster; i++) cluster.fork();
  cluster.on('exit', (w, code) => {
    console.error(`[primary] воркер ${w.process.pid} упал (${code}), перезапускаю`);
    cluster.fork();
  });
} else {
  startWorker();
}

function startWorker() {
  require('./db');
  require('./seed').seed();
  const router = require('./routes');
  const sweeper = require('./core/sweeper');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    try {
      const route = router.match(req.method, pathname);
      if (route) {
        let body = {};
        if (req.method === 'POST') {
          try {
            body = await readBody(req);
          } catch (err) {
            return sendJson(res, 400, { ok: false, error: err.message });
          }
        }
        return await route.handler(req, res, { params: route.params, body, query: url.searchParams });
      }
      if (req.method === 'GET') return serveStatic(req, res, pathname);
      sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      console.error('[http]', req.method, pathname, err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' });
      else res.end();
    }
  });

  // Заглушка поставщика умеет «зависать» — соединение не должно рваться раньше времени.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 65000;

  server.listen(config.port, config.host, () => {
    // Внутренние вызовы (вебхук-эмулятор, клиент поставщика) должны ходить на
    // конкретный адрес: в Docker HOST=0.0.0.0 — это адрес прослушивания,
    // а не адрес назначения, ходить по нему нельзя.
    const dialHost = ['0.0.0.0', '::', ''].includes(config.host) ? '127.0.0.1' : config.host;
    config.selfUrl = config.selfUrl || `http://${dialHost}:${config.port}`;
    sweeper.start();
    const tag = cluster.isWorker ? `worker ${process.pid}` : `pid ${process.pid}`;
    console.log(`[${tag}] слушаю ${config.host}:${config.port} · внутренний адрес ${config.selfUrl}`);
    if (cluster.isPrimary) {
      console.log(`  витрина  ${config.selfUrl}/`);
      console.log(`  админка  ${config.selfUrl}/admin.html (токен: ${config.adminToken})`);
    }
  });

  const shutdown = () => { sweeper.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
