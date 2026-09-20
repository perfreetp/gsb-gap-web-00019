import { route, json, HttpError } from '../index.js';
import { notify, localNow } from '../util.js';

// 按工种应到名单
function requiredWorkers(db, sessionId) {
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
  if (!s.required_skill_id) return [];
  return db.prepare(`SELECT w.* FROM workers w
    JOIN worker_skills ws ON ws.worker_id=w.id
    WHERE w.base_id=? AND ws.skill_id=? AND w.merged_into IS NULL
    AND (w.employment_type='long_term' OR w.plot_id=?)
    ORDER BY w.id`).all(s.base_id, s.required_skill_id, s.plot_id);
}

route('GET', '/api/sessions', (ctx) => {
  const cond = ctx.user.role === 'enterprise' ? '' : 'se.base_id=?';
  const rows = ctx.db.prepare(`SELECT se.*, su.name subject_name, sk.name skill_name, p.code plot_code,
      (SELECT COUNT(*) FROM enrollments e WHERE e.session_id=se.id) enrolled,
      (SELECT COUNT(*) FROM attendance a WHERE a.session_id=se.id) attended,
      ROUND((SELECT AVG(score) FROM session_feedback f WHERE f.session_id=se.id),1) lecturer_score
    FROM sessions se
    LEFT JOIN subjects su ON su.id=se.subject_id
    LEFT JOIN skills sk ON sk.id=se.required_skill_id
    LEFT JOIN plots p ON p.id=se.plot_id
    ${cond ? 'WHERE ' + cond : ''} ORDER BY se.train_time DESC`).all(...(cond ? [ctx.user.base_id] : []));
  json(ctx.res, 200, { list: rows });
});

route('POST', '/api/sessions', (ctx) => {
  if (!['admin', 'tech'].includes(ctx.user.role)) throw new HttpError(403, '仅基地管理员/技术员可排课');
  const b = ctx.body || {};
  for (const k of ['title', 'train_time']) if (!b[k]) throw new HttpError(400, k + ' 必填');
  const id = ctx.db.prepare(`INSERT INTO sessions(base_id, subject_id, title, train_time, location, plot_id,
      lecturer, content, required_skill_id, credit_hours, created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ctx.user.base_id, b.subject_id || null, b.title, b.train_time, b.location || null, b.plot_id || null,
      b.lecturer || null, b.content || null, b.required_skill_id || null, b.credit_hours || 0, ctx.user.id).lastInsertRowid;
  // 自动生成应到名单（报名记录）
  for (const w of requiredWorkers(ctx.db, id)) {
    ctx.db.prepare('INSERT OR IGNORE INTO enrollments(session_id, worker_id) VALUES(?,?)').run(id, w.id);
  }
  ctx.audit('排培训场次', 'session', id, b);
  json(ctx.res, 200, { id });
});

route('GET', '/api/sessions/:id', (ctx) => {
  const s = ctx.db.prepare(`SELECT se.*, su.name subject_name, sk.name skill_name, p.code plot_code,
      b.name base_name FROM sessions se
      LEFT JOIN subjects su ON su.id=se.subject_id LEFT JOIN skills sk ON sk.id=se.required_skill_id
      LEFT JOIN plots p ON p.id=se.plot_id LEFT JOIN bases b ON b.id=se.base_id WHERE se.id=?`).get(ctx.params.id);
  if (!s) throw new HttpError(404, '场次不存在');
  if (ctx.user.role !== 'enterprise' && s.base_id !== ctx.user.base_id) throw new HttpError(403, '越权');
  const roster = ctx.db.prepare(`SELECT w.id, w.name, w.phone, w.employment_type,
      e.id enroll_id, e.enrolled_at,
      a.id att_id, a.check_in_at, a.method, a.source, a.proxy_by
    FROM workers w
    LEFT JOIN enrollments e ON e.worker_id=w.id AND e.session_id=?
    LEFT JOIN attendance a ON a.worker_id=w.id AND a.session_id=?
    WHERE w.base_id=? AND w.merged_into IS NULL
    ORDER BY w.id`).all(s.id, s.id, s.base_id);
  const feedback = ctx.db.prepare(`SELECT f.*, w.name worker_name FROM session_feedback f
    JOIN workers w ON w.id=f.worker_id WHERE f.session_id=?`).all(s.id);
  json(ctx.res, 200, { session: s, roster, feedback });
});

// 报名（药农扫码报名 / 代报名）
route('POST', '/api/sessions/:id/enroll', (ctx) => {
  const s = ctx.db.prepare('SELECT * FROM sessions WHERE id=?').get(ctx.params.id);
  if (!s) throw new HttpError(404, '场次不存在');
  let workerId = ctx.body.worker_id;
  if (ctx.user.role === 'farmer') workerId = ctx.user.worker_id;
  if (!workerId) throw new HttpError(400, '缺少人员');
  if (ctx.user.role === 'farmer' && s.base_id !== ctx.user.base_id) throw new HttpError(403, '越权');
  ctx.db.prepare('INSERT OR IGNORE INTO enrollments(session_id, worker_id) VALUES(?,?)').run(s.id, workerId);
  ctx.audit('培训报名', 'session', s.id, { worker_id: workerId });
  json(ctx.res, 200, { ok: true });
});

// 扫码签到（支持幂等 nonce、弱网补传）
route('POST', '/api/sessions/:id/checkin', (ctx) => {
  const s = ctx.db.prepare('SELECT * FROM sessions WHERE id=?').get(ctx.params.id);
  if (!s) throw new HttpError(404, '场次不存在');
  if (ctx.user.role !== 'enterprise' && s.base_id !== ctx.user.base_id) throw new HttpError(403, '越权');
  let workerId = ctx.body.worker_id;
  if (ctx.user.role === 'farmer') workerId = ctx.user.worker_id;
  if (!workerId) throw new HttpError(400, '缺少签到人员');

  const nonce = ctx.body.client_nonce || null;
  if (nonce) {
    const dup = ctx.db.prepare('SELECT * FROM attendance WHERE client_nonce=?').get(nonce);
    if (dup) return json(ctx.res, 200, { ok: true, idempotent: true, checkin: dup });
  }
  const existing = ctx.db.prepare('SELECT * FROM attendance WHERE session_id=? AND worker_id=?').get(s.id, workerId);
  if (existing) return json(ctx.res, 200, { ok: true, idempotent: true, checkin: existing });

  const isProxy = ctx.body.method === 'proxy' || ['admin', 'tech'].includes(ctx.user.role);
  const r = ctx.db.prepare(`INSERT INTO attendance(session_id, worker_id, check_in_at, method, proxy_by, client_nonce, source)
      VALUES(?,?,?,?,?,?,?)`)
    .run(s.id, workerId, ctx.body.check_in_at || localNow(), isProxy ? 'proxy' : 'qrcode',
      isProxy ? ctx.user.id : null, nonce, ctx.body.source || 'online');
  ctx.db.prepare('INSERT OR IGNORE INTO enrollments(session_id, worker_id) VALUES(?,?)').run(s.id, workerId);
  ctx.audit(isProxy ? '代签/补录签到' : '扫码签到', 'session', s.id, {
    worker_id: workerId, source: ctx.body.source || 'online', nonce });
  json(ctx.res, 200, { ok: true, checkin_id: r.lastInsertRowid });
});

// 结训：统计应到未到并推送提醒
route('POST', '/api/sessions/:id/finish', (ctx) => {
  if (!['admin', 'tech'].includes(ctx.user.role)) throw new HttpError(403, '无权限');
  const s = ctx.db.prepare('SELECT * FROM sessions WHERE id=?').get(ctx.params.id);
  if (!s || s.base_id !== ctx.user.base_id) throw new HttpError(404, '场次不存在');
  ctx.db.prepare("UPDATE sessions SET status='finished' WHERE id=?").run(s.id);
  const absent = ctx.db.prepare(`SELECT e.worker_id, w.name FROM enrollments e
    JOIN workers w ON w.id=e.worker_id
    WHERE e.session_id=? AND NOT EXISTS(SELECT 1 FROM attendance a WHERE a.session_id=e.session_id AND a.worker_id=e.worker_id)`)
    .all(s.id);
  for (const a of absent) {
    notify({ worker_id: a.worker_id, title: '缺课提醒', body: `您缺席了《${s.title}》，请联系技术员安排补训`, type: 'absence', ref_id: s.id });
  }
  ctx.audit('结训并推送缺课提醒', 'session', s.id, { absent: absent.length });
  json(ctx.res, 200, { ok: true, absent_count: absent.length, absent });
});

// 缺训名单（已排期但未签到，或应参训工种无任何有效培训）
route('GET', '/api/sessions/:id/absent', (ctx) => {
  const rows = ctx.db.prepare(`SELECT w.id, w.name, w.phone, c.name coop_name
    FROM enrollments e JOIN workers w ON w.id=e.worker_id
    LEFT JOIN cooperatives c ON c.id=w.coop_id
    WHERE e.session_id=? AND NOT EXISTS(SELECT 1 FROM attendance a WHERE a.session_id=e.session_id AND a.worker_id=e.worker_id)`)
    .all(ctx.params.id);
  json(ctx.res, 200, { list: rows });
});

route('POST', '/api/sessions/:id/feedback', (ctx) => {
  let workerId = ctx.body.worker_id;
  if (ctx.user.role === 'farmer') workerId = ctx.user.worker_id;
  const { score, comment } = ctx.body || {};
  ctx.db.prepare(`INSERT INTO session_feedback(session_id, worker_id, score, comment) VALUES(?,?,?,?)
    ON CONFLICT(session_id, worker_id) DO UPDATE SET score=excluded.score, comment=excluded.comment`)
    .run(ctx.params.id, workerId, score, comment || null);
  json(ctx.res, 200, { ok: true });
});

// 离线操作队列补传（报名/签到/答题进度），nonce 幂等去重
route('POST', '/api/ops/sync', (ctx) => {
  const ops = ctx.body.ops || [];
  const results = [];
  for (const op of ops) {
    const dup = ctx.db.prepare('SELECT * FROM op_queue WHERE client_nonce=?').get(op.client_nonce);
    if (dup) { results.push({ nonce: op.client_nonce, status: dup.status, idempotent: true }); continue; }
    ctx.db.prepare(`INSERT INTO op_queue(client_nonce, worker_id, op_type, payload, status, synced_at)
                    VALUES(?,?,?,?, 'done', ?)`)
      .run(op.client_nonce, op.worker_id || ctx.user.worker_id || null, op.op_type,
        JSON.stringify(op.payload || {}), localNow());
    try {
      if (op.op_type === 'checkin') {
        const p = op.payload || {};
        ctx.db.prepare(`INSERT OR IGNORE INTO attendance(session_id, worker_id, check_in_at, method, client_nonce, source)
                        VALUES(?,?,?,?,?, 'offline')`)
          .run(p.session_id, op.worker_id || ctx.user.worker_id, p.check_in_at || localNow(), 'qrcode', op.client_nonce);
      } else if (op.op_type === 'enroll') {
        ctx.db.prepare('INSERT OR IGNORE INTO enrollments(session_id, worker_id) VALUES(?,?)')
          .run(op.payload.session_id, op.worker_id || ctx.user.worker_id);
      }
      results.push({ nonce: op.client_nonce, status: 'done' });
    } catch (e) {
      results.push({ nonce: op.client_nonce, status: 'error', error: e.message });
    }
  }
  ctx.audit('弱网离线数据补传', 'op_queue', null, { count: ops.length });
  json(ctx.res, 200, { results });
});
