'use strict';
const path = require('path');

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const num = (v, d) => (v === undefined || v === '' ? d : Number.parseFloat(v));

const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '127.0.0.1',
  cluster: int(process.env.CLUSTER, 0), // 0/1 = один процесс, >1 = N воркеров на одном порту
  dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'store.db'),
  adminToken: process.env.ADMIN_TOKEN || 'dev-admin-token',

  // Внутренний URL самого сервиса (вебхук-заглушка и клиент поставщика ходят по HTTP,
  // как в реальности — через сеть, а не прямым вызовом функции).
  selfUrl: process.env.SELF_URL || null, // выставляется при старте

  // Выдача
  providerTimeoutMs: int(process.env.PROVIDER_TIMEOUT_MS, 1500),
  providerRetriesPerProvider: int(process.env.PROVIDER_RETRIES, 2),
  // Сколько живёт «аренда» на выдачу. Если процесс упал в середине —
  // после протухания аренды заказ подхватит sweeper.
  deliveryLeaseMs: int(process.env.DELIVERY_LEASE_MS, 15000),
  sweeperIntervalMs: int(process.env.SWEEPER_INTERVAL_MS, 2000),
  autoRetryStuck: process.env.AUTO_RETRY_STUCK === '1',
  // Сколько живёт неоплаченный заказ. По истечении он закрывается, а бронь
  // промокода возвращается в лимит — как холд на билет. 0 = не истекает.
  orderTtlMs: int(process.env.ORDER_TTL_MS, 15 * 60 * 1000),

  // Хаос по умолчанию (перенастраивается в рантайме: POST /admin/api/chaos)
  chaosDefaults: {
    A: {
      errorRate: num(process.env.PROVIDER_A_ERROR_RATE, 0.15),
      timeoutRate: num(process.env.PROVIDER_A_TIMEOUT_RATE, 0.1),
      latencyMs: int(process.env.PROVIDER_A_LATENCY_MS, 40),
    },
    B: {
      errorRate: num(process.env.PROVIDER_B_ERROR_RATE, 0.1),
      timeoutRate: num(process.env.PROVIDER_B_TIMEOUT_RATE, 0.05),
      latencyMs: int(process.env.PROVIDER_B_LATENCY_MS, 60),
    },
  },

  // Как делится стартовый пул из 50 ключей между двумя поставщиками
  stockSplit: { A: int(process.env.STOCK_A, 40), B: int(process.env.STOCK_B, 10) },
};

module.exports = config;
