'use strict';
// Полный сброс состояния: удаляет файл БД и заново засевает данные из материалов.
const fs = require('node:fs');
const config = require('../server/config');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(config.dbFile + suffix); } catch { /* нет файла — ок */ }
}
require('../server/db');
require('../server/seed').seed();
console.log('БД пересоздана:', config.dbFile);
