const crypto = require('crypto');
const { db } = require('./db');

// 简单内存会话（重启需重新登录，足够本平台使用）
const sessions = new Map();

function login(username, password) {
  const { hashPassword } = require('./db');
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || user.password_hash !== hashPassword(password)) return null;
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { id: user.id, role: user.role, base_id: user.base_id,
    person_id: user.person_id, name: user.name });
  return { token, user: { id: user.id, username: user.username, role: user.role,
    base_id: user.base_id, person_id: user.person_id, name: user.name } };
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = sessions.get(token);
  if (!session) return res.status(401).json({ error: '未登录或会话已失效' });
  req.user = session;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: '无权限执行该操作' });
    next();
  };
}

// 数据可见范围：企业质控看全量；基地角色仅本基地
function baseScope(req) {
  return req.user.role === 'enterprise' ? null : req.user.base_id;
}

module.exports = { login, auth, requireRole, baseScope, sessions };
