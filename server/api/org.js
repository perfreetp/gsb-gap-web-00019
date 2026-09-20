import { route, json, HttpError } from '../index.js';
import { maskIdCard } from '../util.js';

function baseScope(ctx) {
  if (ctx.user.role === 'enterprise') return null;
  if (ctx.user.role === 'admin' || ctx.user.role === 'tech' || ctx.user.role === 'farmer') return ctx.user.base_id;
  throw new HttpError(403, '无权限');
}

// 基地/合作社/地块下拉数据
route('GET', '/api/org', (ctx) => {
  const base = baseScope(ctx);
  const bases = ctx.db.prepare(base ? 'SELECT * FROM bases WHERE id=?' : 'SELECT * FROM bases').all(...(base ? [base] : []));
  const coops = ctx.db.prepare(base ? 'SELECT * FROM cooperatives WHERE base_id=?' : 'SELECT * FROM cooperatives').all(...(base ? [base] : []));
  const plots = ctx.db.prepare(`SELECT p.*, c.name coop_name FROM plots p LEFT JOIN cooperatives c ON c.id=p.coop_id
                                ${base ? 'WHERE p.base_id=?' : ''} ORDER BY p.code`).all(...(base ? [base] : []));
  const skills = ctx.db.prepare('SELECT * FROM skills ORDER BY sort_no').all();
  const subjects = ctx.db.prepare('SELECT * FROM subjects ORDER BY id').all();
  const skillSubjects = ctx.db.prepare('SELECT * FROM skill_subjects').all();
  json(ctx.res, 200, { bases, coops, plots, skills, subjects, skillSubjects });
});

route('POST', '/api/coops', (ctx) => {
  if (!['enterprise', 'admin'].includes(ctx.user.role)) throw new HttpError(403, '无权限');
  const { name } = ctx.body || {};
  if (!name) throw new HttpError(400, '合作社名称必填');
  const baseId = ctx.user.role === 'admin' ? ctx.user.base_id : ctx.body.base_id;
  try {
    const id = ctx.db.prepare('INSERT INTO cooperatives(base_id, name) VALUES(?,?)').run(baseId, name).lastInsertRowid;
    ctx.audit('新建合作社', 'cooperative', id, { name });
    json(ctx.res, 200, { id });
  } catch { throw new HttpError(400, '合作社名称重复'); }
});

route('POST', '/api/plots', (ctx) => {
  if (!['enterprise', 'admin'].includes(ctx.user.role)) throw new HttpError(403, '无权限');
  const b = ctx.body || {};
  if (!b.code) throw new HttpError(400, '地块编码必填');
  const baseId = ctx.user.role === 'admin' ? ctx.user.base_id : b.base_id;
  try {
    const id = ctx.db.prepare(`INSERT INTO plots(base_id, coop_id, code, name, herb_variety, area_mu)
        VALUES(?,?,?,?,?,?)`).run(baseId, b.coop_id || null, b.code, b.name || null, b.herb_variety || null, b.area_mu || null).lastInsertRowid;
    ctx.audit('新登记地块', 'plot', id, b);
    json(ctx.res, 200, { id });
  } catch { throw new HttpError(400, '地块编码在本基地已存在'); }
});

route('PUT', '/api/plots/:id/manager', (ctx) => {
  const plot = ctx.db.prepare('SELECT * FROM plots WHERE id=?').get(ctx.params.id);
  if (!plot) throw new HttpError(404, '地块不存在');
  if (ctx.user.role === 'admin' && plot.base_id !== ctx.user.base_id) throw new HttpError(403, '越权操作');
  ctx.db.prepare('UPDATE plots SET manager_id=? WHERE id=?').run(ctx.body.worker_id || null, plot.id);
  ctx.audit('指定地块管护人', 'plot', plot.id, { manager_id: ctx.body.worker_id || null });
  json(ctx.res, 200, { ok: true });
});
