import { route, json, HttpError } from '../index.js';
import { maskIdCard } from '../util.js';

function canWrite(ctx, baseId) {
  if (ctx.user.role === 'enterprise') return;
  if (ctx.user.role === 'admin' || ctx.user.role === 'tech') {
    if (baseId && baseId !== ctx.user.base_id) throw new HttpError(403, '越权操作其他基地');
    return;
  }
  throw new HttpError(403, '无权限');
}

function workerQuery(ctx, where = '', params = []) {
  const scope = ctx.user.role === 'enterprise' ? '' : 'w.base_id = ?';
  const cond = [scope, where].filter(Boolean).join(' AND ');
  const args = ctx.user.role === 'enterprise' ? params : [ctx.user.base_id, ...params];
  return ctx.db.prepare(`
    SELECT w.*, b.name base_name, c.name coop_name, p.code plot_code, p.name plot_name, p.herb_variety,
      (SELECT GROUP_CONCAT(s.name) FROM worker_skills ws JOIN skills s ON s.id=ws.skill_id WHERE ws.worker_id=w.id) skill_names,
      (SELECT GROUP_CONCAT(ws2.skill_id) FROM worker_skills ws2 WHERE ws2.worker_id=w.id) skill_ids
    FROM workers w
    LEFT JOIN bases b ON b.id=w.base_id
    LEFT JOIN cooperatives c ON c.id=w.coop_id
    LEFT JOIN plots p ON p.id=w.plot_id
    WHERE ${cond || '1=1'}
    AND (w.merged_into IS NULL)
    ORDER BY w.id DESC`).all(...args);
}

route('GET', '/api/workers', (ctx) => {
  const { keyword, skill_id, coop_id, plot_id, employment_type } = ctx.query;
  const conds = []; const params = [];
  if (keyword) { conds.push('(w.name LIKE ? OR w.id_card LIKE ? OR w.phone LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  if (coop_id) { conds.push('w.coop_id=?'); params.push(coop_id); }
  if (plot_id) { conds.push('w.plot_id=?'); params.push(plot_id); }
  if (employment_type) { conds.push('w.employment_type=?'); params.push(employment_type); }
  let rows = workerQuery(ctx, conds.join(' AND '), params);
  if (skill_id) rows = rows.filter(r => (r.skill_ids || '').split(',').includes(String(skill_id)));
  rows = rows.map(r => ({ ...r, id_card: maskIdCard(r.id_card) }));
  json(ctx.res, 200, { list: rows });
});

route('GET', '/api/workers/:id', (ctx) => {
  const w = ctx.db.prepare(`
    SELECT w.*, b.name base_name, c.name coop_name, p.code plot_code, p.name plot_name
    FROM workers w LEFT JOIN bases b ON b.id=w.base_id
    LEFT JOIN cooperatives c ON c.id=w.coop_id LEFT JOIN plots p ON p.id=w.plot_id WHERE w.id=?`).get(ctx.params.id);
  if (!w) throw new HttpError(404, '人员不存在');
  if (ctx.user.role !== 'enterprise' && w.base_id !== ctx.user.base_id) throw new HttpError(403, '越权');
  const skills = ctx.db.prepare(`SELECT s.* FROM worker_skills ws JOIN skills s ON s.id=ws.skill_id WHERE ws.worker_id=?`).all(w.id);
  json(ctx.res, 200, { worker: { ...w, id_card: maskIdCard(w.id_card), id_card_raw: ctx.user.role === 'farmer' ? undefined : w.id_card }, skills });
});

function findDuplicate(db, baseId, row) {
  // 同基地 + 身份证号一致 优先；其次 姓名+手机号
  let dup = null;
  if (row.id_card) dup = db.prepare("SELECT * FROM workers WHERE base_id=? AND id_card=? AND merged_into IS NULL").get(baseId, row.id_card);
  if (!dup && row.name && row.phone)
    dup = db.prepare("SELECT * FROM workers WHERE base_id=? AND name=? AND phone=? AND merged_into IS NULL").get(baseId, row.name, row.phone);
  return dup;
}

function upsertWorker(db, baseId, row) {
  const dup = findDuplicate(db, baseId, row);
  if (dup) {
    const fields = []; const vals = [];
    for (const k of ['gender', 'phone', 'employment_type', 'coop_id', 'plot_id']) {
      if (row[k] != null && row[k] !== '') { fields.push(`${k}=?`); vals.push(row[k]); }
    }
    if (row.id_card && !dup.id_card) fields.push('id_card=?'), vals.push(row.id_card);
    if (fields.length) { vals.push(dup.id); db.prepare(`UPDATE workers SET ${fields.join(',')} WHERE id=?`).run(...vals); }
    return { id: dup.id, merged: false, duplicate: true };
  }
  const r = db.prepare(`INSERT INTO workers(base_id, name, id_card, gender, phone, employment_type, coop_id, plot_id)
                        VALUES(?,?,?,?,?,?,?,?)`)
    .run(baseId, row.name, row.id_card || null, row.gender || null, row.phone || null,
      row.employment_type || 'seasonal', row.coop_id || null, row.plot_id || null);
  return { id: r.lastInsertRowid, merged: false, duplicate: false };
}

route('POST', '/api/workers', (ctx) => {
  const b = ctx.body || {};
  if (!b.name) throw new HttpError(400, '姓名必填');
  const baseId = ctx.user.role === 'enterprise' ? (b.base_id || throw400('base_id')) : ctx.user.base_id;
  canWrite(ctx, baseId);
  if (b.id_card && !/^\d{15}$|^\d{17}[\dXx]$/.test(b.id_card)) throw new HttpError(400, '身份证号格式不正确');
  const dup = findDuplicate(ctx.db, baseId, b);
  const result = upsertWorker(ctx.db, baseId, b);
  if (b.skill_ids) setSkills(ctx.db, result.id, b.skill_ids);
  ctx.audit(dup ? '录入重复人员-自动合并' : '新建人员台账', 'worker', result.id, { name: b.name, duplicate: !!dup });
  json(ctx.res, 200, { ...result, duplicate: !!dup });
});
function throw400(k) { throw new HttpError(400, k + ' 必填'); }

function setSkills(db, workerId, skillIds) {
  db.prepare('DELETE FROM worker_skills WHERE worker_id=?').run(workerId);
  const ins = db.prepare('INSERT OR IGNORE INTO worker_skills(worker_id, skill_id) VALUES(?,?)');
  for (const sid of skillIds) ins.run(workerId, Number(sid));
}

route('PUT', '/api/workers/:id', (ctx) => {
  const w = ctx.db.prepare('SELECT * FROM workers WHERE id=?').get(ctx.params.id);
  if (!w) throw new HttpError(404, '人员不存在');
  canWrite(ctx, w.base_id);
  const b = ctx.body || {};
  if (b.id_card && !/^\d{15}$|^\d{17}[\dXx]$/.test(b.id_card)) throw new HttpError(400, '身份证号格式不正确');
  ctx.db.prepare(`UPDATE workers SET name=?, id_card=?, gender=?, phone=?, employment_type=?, coop_id=?, plot_id=? WHERE id=?`)
    .run(b.name ?? w.name, b.id_card ?? w.id_card, b.gender ?? w.gender, b.phone ?? w.phone,
      b.employment_type ?? w.employment_type, b.coop_id ?? w.coop_id, b.plot_id ?? w.plot_id, w.id);
  if (b.skill_ids) setSkills(ctx.db, w.id, b.skill_ids);
  ctx.audit('修改人员台账', 'worker', w.id, b);
  json(ctx.res, 200, { ok: true });
});

route('PUT', '/api/workers/:id/skills', (ctx) => {
  const w = ctx.db.prepare('SELECT * FROM workers WHERE id=?').get(ctx.params.id);
  if (!w) throw new HttpError(404, '人员不存在');
  canWrite(ctx, w.base_id);
  setSkills(ctx.db, w.id, ctx.body.skill_ids || []);
  ctx.audit('更新工种技能标签', 'worker', w.id, { skill_ids: ctx.body.skill_ids });
  json(ctx.res, 200, { ok: true });
});

// 手工合并：kept_id 保留，removed_id 关联迁移
route('POST', '/api/workers/merge', (ctx) => {
  const { kept_id, removed_id } = ctx.body || {};
  if (!kept_id || !removed_id || kept_id === removed_id) throw new HttpError(400, '请选择两个不同的人员');
  const k = ctx.db.prepare('SELECT * FROM workers WHERE id=?').get(kept_id);
  const r = ctx.db.prepare('SELECT * FROM workers WHERE id=?').get(removed_id);
  if (!k || !r) throw new HttpError(404, '人员不存在');
  canWrite(ctx, k.base_id);
  const tx = ctx.db.prepare('BEGIN').run();
  try {
    for (const t of ['worker_skills', 'enrollments', 'attendance', 'course_progress', 'exam_attempts', 'certificates', 'harvest_workers']) {
      const cols = ctx.db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      if (cols.includes('worker_id')) ctx.db.prepare(`UPDATE OR IGNORE ${t} SET worker_id=? WHERE worker_id=?`).run(k.id, r.id);
    }
    ctx.db.prepare('UPDATE workers SET merged_into=?, status=? WHERE id=?').run(k.id, 'merged', r.id);
    ctx.db.prepare('INSERT INTO worker_merge_log(kept_id, removed_id, reason) VALUES(?,?,?)')
      .run(k.id, r.id, ctx.body.reason || '管理员确认重复合并');
    ctx.db.prepare('COMMIT').run();
  } catch (e) { ctx.db.prepare('ROLLBACK').run(); throw e; }
  ctx.audit('合并重复人员', 'worker', k.id, { kept: kept_id, removed: removed_id });
  json(ctx.res, 200, { ok: true });
});

route('GET', '/api/workers/duplicates/list', (ctx) => {
  const base = ctx.user.role === 'enterprise' ? {} : { base: ctx.user.base_id };
  const rows = ctx.db.prepare(`
    SELECT a.id a_id, a.name a_name, a.phone a_phone, a.id_card a_card,
           b.id b_id, b.name b_name, b.phone b_phone, b.id_card b_card,
           c.name coop_name
    FROM workers a JOIN workers b ON a.id < b.id
    LEFT JOIN cooperatives c ON c.id=a.coop_id
    WHERE a.merged_into IS NULL AND b.merged_into IS NULL
      AND (? IS NULL OR (a.base_id=? AND b.base_id=?))
      AND ((a.id_card IS NOT NULL AND a.id_card=b.id_card)
           OR (a.name=b.name AND a.phone IS NOT NULL AND a.phone=b.phone))
  `).all(base.base ?? null, base.base ?? null, base.base ?? null);
  json(ctx.res, 200, { list: rows.map(r => ({ ...r, a_card: maskIdCard(r.a_card), b_card: maskIdCard(r.b_card) })) });
});

// 简易 CSV 解析
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  const head = splitLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = splitLine(line);
    const o = {}; head.forEach((h, i) => (o[h] = (cells[i] || '').trim())); return o;
  });
}
function splitLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}

// 批量导入（CSV 文本或 JSON rows），自动查重合并
route('POST', '/api/workers/import', (ctx) => {
  const b = ctx.body || {};
  const rows = b.rows || (b.csv ? parseCsv(b.csv) : null);
  if (!rows || !rows.length) throw new HttpError(400, '没有可导入的数据');
  const baseId = ctx.user.role === 'enterprise' ? b.base_id : ctx.user.base_id;
  if (!baseId) throw new HttpError(400, '请选择基地');
  canWrite(ctx, baseId);
  const coopMap = new Map(ctx.db.prepare('SELECT id, name FROM cooperatives WHERE base_id=?').all(baseId).map(c => [c.name, c.id]));
  const plotMap = new Map(ctx.db.prepare('SELECT id, code FROM plots WHERE base_id=?').all(baseId).map(p => [p.code, p.id]));
  const skillMap = new Map(ctx.db.prepare('SELECT id, name FROM skills').all().map(s => [s.name, s.id]));

  let created = 0, merged = 0; const errors = [];
  ctx.db.prepare('BEGIN').run();
  try {
    rows.forEach((r, idx) => {
      try {
        const row = {
          name: r['姓名'] || r.name,
          id_card: r['身份证号'] || r.id_card || null,
          gender: r['性别'] || r.gender || null,
          phone: r['联系方式'] || r.phone || null,
          employment_type: (r['用工类型'] || r.employment_type || '季节性').includes('长期') ? 'long_term' : 'seasonal',
          coop_id: coopMap.get(r['所属合作社'] || r.coop_name) || null,
          plot_id: plotMap.get(r['地块编码'] || r.plot_code) || null,
        };
        if (!row.name) throw new Error('姓名为空');
        if (row.id_card && !/^\d{15}$|^\d{17}[\dXx]$/.test(row.id_card)) throw new Error('身份证格式错误');
        const res = upsertWorker(ctx.db, baseId, row);
        res.duplicate ? merged++ : created++;
        const skillNames = (r['工种'] || r.skills || '').split(/[\/、,，]/).map(s => s.trim()).filter(Boolean);
        if (skillNames.length) {
          const ids = skillNames.map(n => skillMap.get(n)).filter(Boolean);
          if (ids.length) setSkills(ctx.db, res.id, ids);
        }
      } catch (e) { errors.push(`第 ${idx + 2} 行：${e.message}`); }
    });
    ctx.db.prepare('COMMIT').run();
  } catch (e) { ctx.db.prepare('ROLLBACK').run(); throw e; }
  ctx.audit('批量导入人员（自动查重合并）', 'worker', null, { created, merged, errors: errors.length });
  json(ctx.res, 200, { created, merged, errors });
});
