// 首次启动时自动初始化演示数据
const { db } = require('./db');
if (db.prepare('SELECT COUNT(*) c FROM bases').get().c === 0) {
  require('./seed');
}
