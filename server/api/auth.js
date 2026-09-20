import { route, json, HttpError } from '../index.js';
import { verifyPassword, makeToken, audit } from '../util.js';

route('POST', '/api/auth/login', (ctx) => {
  const { username, password } = ctx.body || {};
  const u = ctx.db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
  if (!u || !verifyPassword(password || '', u.salt, u.password_hash))
    throw new HttpError(401, '用户名或密码错误');
  const token = makeToken(u);
  audit(u, '登录', 'user', u.id, {});
  json(ctx.res, 200, {
    token,
    user: { id: u.id, username: u.username, real_name: u.real_name, role: u.role, base_id: u.base_id, worker_id: u.worker_id },
  });
}, { public: true });

route('GET', '/api/auth/me', (ctx) => {
  const u = ctx.user;
  const worker = u.worker_id ? ctx.db.prepare(`SELECT w.*, c.name coop_name, p.code plot_code, p.name plot_name
      FROM workers w LEFT JOIN cooperatives c ON c.id=w.coop_id LEFT JOIN plots p ON p.id=w.plot_id
      WHERE w.id=?`).get(u.worker_id) : null;
  json(ctx.res, 200, {
    user: { id: u.id, username: u.username, real_name: u.real_name, role: u.role, base_id: u.base_id, worker_id: u.worker_id },
    worker,
  });
});

route('POST', '/api/auth/logout', (ctx) => {
  json(ctx.res, 200, { ok: true });
});

route('GET', '/api/notifications', (ctx) => {
  let rows;
  if (ctx.user.role === 'farmer' && ctx.user.worker_id) {
    rows = ctx.db.prepare('SELECT * FROM notifications WHERE worker_id=? ORDER BY id DESC LIMIT 50')
      .all(ctx.user.worker_id);
  } else {
    rows = ctx.db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50')
      .all(ctx.user.id);
  }
  json(ctx.res, 200, { list: rows });
});

route('POST', '/api/notifications/:id/read', (ctx) => {
  ctx.db.prepare('UPDATE notifications SET is_read=1 WHERE id=?').run(ctx.params.id);
  json(ctx.res, 200, { ok: true });
});
