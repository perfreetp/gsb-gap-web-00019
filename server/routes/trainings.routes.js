const express = require('express');
const { db, now, notify, audit } = require('../db');
const { baseScope, requireRole } = require('../auth');
const { expectedAttendeeIds } = require('../util');
const router = express.Router();

function decorate(t) {
  if (!t) return t;
  const signed = db.prepare('SELECT COUNT(*) c FROM attendance WHERE training_id=?').get(t.id).c;
  const expected = db.prepare('SELECT COUNT(*) c FROM training_attendees WHERE training_id=?').get(t.id).c;
  const r = db.prepare('SELECT COALESCE(SUM(score),0) s, COUNT(*) c FROM training_feedback WHERE training_id=?').get(t.id);
  return { ...t, signed_count: signed, expected_count: expected,
    trainer_rating: r.c ? Number((r.s / r.c).toFixed(2)) : null, feedback_count: r.c };
}

// 场次列表（企业可按基地过滤；药农看本基地全部，便于扫码报名；可加 subject/plot 过滤）
router.get('/', (req, res) => {
  const scope = baseScope(req);
  const { plot_id, subject_id, upcoming } = req.query;
  const where = [];
  const args = [];
  if (scope) { where.push('t.base_id=?'); args.push(scope); }
  if (plot_id) { where.push('t.plot_id=?'); args.push(Number(plot_id)); }
  if (subject_id) { where.push('t.subject_id=?'); args.push(Number(subject_id)); }
  if (upcoming === '1') where.push('t.start_at >= ?'), args.push(now());
  const rows = db.prepare(`SELECT t.*, tr.name AS trainer_name, tr.title AS trainer_title,
      s.name AS subject_name, st.name AS tag_name, pl.code AS plot_code
    FROM trainings t
    LEFT JOIN trainers tr ON tr.id=t.trainer_id
    LEFT JOIN subjects s ON s.id=t.subject_id
    LEFT JOIN skill_tags st ON st.id=t.tag_id
    LEFT JOIN plots pl ON pl.id=t.plot_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.start_at DESC`).all(...args).map(decorate);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const t = db.prepare(`SELECT t.*, tr.name AS trainer_name, s.name AS subject_name,
      st.name AS tag_name, pl.code AS plot_code, pl.name AS plot_name
    FROM trainings t
    LEFT JOIN trainers tr ON tr.id=t.trainer_id
    LEFT JOIN subjects s ON s.id=t.subject_id
    LEFT JOIN skill_tags st ON st.id=t.tag_id
    LEFT JOIN plots pl ON pl.id=t.plot_id WHERE t.id=?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: '培训不存在' });
  if (req.user.role !== 'enterprise' && t.base_id !== req.user.base_id)
    return res.status(403).json({ error: '无权查看' });

  // 应到名单：显式名单优先，否则按工种动态
  let expectedIds = expectedAttendeeIds(t);
  const placeholders = expectedIds.map(() => '?').join(',') || 'SELECT NULL WHERE 0';
  const peopleRows = expectedIds.length
    ? db.prepare(`SELECT p.id, p.name, p.phone, c.name AS cooperative_name
        FROM people p LEFT JOIN cooperatives c ON c.id=p.cooperative_id
        WHERE p.id IN (${expectedIds.map(() => '?').join(',')}) AND p.merged_into IS NULL`)
        .all(...expectedIds)
    : [];
  const signs = db.prepare(`SELECT a.*, u.name AS proxy_name FROM attendance a
    LEFT JOIN users u ON u.id=a.proxy_user_id WHERE a.training_id=?`).all(t.id);
  const signMap = Object.fromEntries(signs.map(s => [s.person_id, s]));
  const attendees = peopleRows.map(p => ({ ...p, signed: !!signMap[p.id], sign: signMap[p.id] || null }));
  res.json({ ...decorate(t), attendees,
    absent: attendees.filter(a => !a.signed) });
});

// 排课（技术指导员）
router.post('/', requireRole('tech', 'base_admin', 'enterprise'), (req, res) => {
  const b = req.body || {};
  const baseId = req.user.base_id || Number(b.base_id);
  if (!baseId || !b.title || !b.start_at) return res.status(400).json({ error: '标题、时间必填' });
  const info = db.prepare(`INSERT INTO trainings
    (base_id, title, subject_id, tag_id, plot_id, location, trainer_id, start_at, duration_min, content, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(baseId, b.title, b.subject_id || null, b.tag_id || null, b.plot_id || null,
      b.location || null, b.trainer_id || null, Number(b.start_at), Number(b.duration_min) || 120,
      b.content || '', req.user.id, now());
  // 显式应到名单；未提供且有定向工种时按工种自动展开
  let ids = (b.attendee_ids || []).map(Number);
  if (!ids.length && b.tag_id) {
    ids = db.prepare(`SELECT person_id FROM person_skills ps
      JOIN people p ON p.id=ps.person_id WHERE ps.tag_id=? AND p.merged_into IS NULL
        AND p.base_id=?`).all(b.tag_id, baseId).map(r => r.person_id);
  }
  const ins = db.prepare('INSERT OR IGNORE INTO training_attendees (training_id, person_id) VALUES (?,?)');
  ids.forEach(pid => ins.run(info.lastInsertRowid, pid));
  // 推送培训通知
  ids.forEach(pid => notify({ base_id: baseId, person_id: pid, type: 'training_notice',
    title: `培训通知：${b.title}`, body: `时间 ${new Date(Number(b.start_at)).toLocaleString('zh-CN')}，地点 ${b.location || '见详情'}`,
    ref_type: 'training', ref_id: info.lastInsertRowid }));
  audit(req.user, 'schedule', 'training', info.lastInsertRowid, { title: b.title, attendees: ids.length });
  res.json({ id: info.lastInsertRowid });
});

// 报名（药农扫码）
router.post('/:id/register', (req, res) => {
  const t = db.prepare('SELECT * FROM trainings WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '培训不存在' });
  const pid = req.user.role === 'farmer' ? req.user.person_id : Number(req.body?.person_id);
  if (!pid) return res.status(400).json({ error: '无法识别报名人员' });
  db.prepare('INSERT OR IGNORE INTO training_attendees (training_id, person_id) VALUES (?,?)')
    .run(t.id, pid);
  audit(req.user, 'register', 'training', t.id, { person_id: pid });
  res.json({ ok: true });
});

// 缺课名单 + 推送提醒（排课方可操作）
router.post('/:id/remind-absent', requireRole('tech', 'base_admin', 'enterprise'), (req, res) => {
  const t = db.prepare('SELECT * FROM trainings WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '培训不存在' });
  const detail = require('./_trainingDetail')(t.id);
  const absent = detail.attendees.filter(a => !a.signed);
  absent.forEach(a => notify({ base_id: t.base_id, person_id: a.id, type: 'training_absent',
    title: `缺课提醒：${t.title}`, body: '系统记录您缺席了本场培训，请联系技术员安排补训。',
    ref_type: 'training', ref_id: t.id }));
  audit(req.user, 'remind_absent', 'training', t.id, { count: absent.length });
  res.json({ ok: true, absent_count: absent.length, absent: absent.map(a => ({ id: a.id, name: a.name })) });
});

// 签到（扫码/代签；幂等：同人同场次唯一；client_event_id 防弱网重传）
function doSignin(t, personId, { method, clientEventId, signedAt }) {
  const existing = db.prepare('SELECT * FROM attendance WHERE training_id=? AND person_id=?')
    .get(t.id, personId);
  if (existing) return { ok: true, duplicated: true, attendance: existing };
  if (clientEventId) {
    const byEvent = db.prepare('SELECT * FROM attendance WHERE client_event_id=?').get(clientEventId);
    if (byEvent) return { ok: true, duplicated: true, attendance: byEvent };
  }
  const info = db.prepare(`INSERT INTO attendance
    (training_id, person_id, method, proxy_user_id, client_event_id, signed_at, created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(t.id, personId, method, method === 'proxy' ? null : null,
      clientEventId || null, Number(signedAt) || now(), now());
  return { ok: true, duplicated: false, id: info.lastInsertRowid };
}

router.post('/:id/signin', (req, res) => {
  const t = db.prepare('SELECT * FROM trainings WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '培训不存在' });
  const b = req.body || {};
  let personId, method = 'scan';
  if (req.user.role === 'farmer') {
    personId = req.user.person_id;
  } else if (b.method === 'proxy') {
    if (!['tech', 'base_admin', 'enterprise'].includes(req.user.role))
      return res.status(403).json({ error: '仅技术员可代签' });
    personId = Number(b.person_id);
    method = 'proxy';
  } else {
    personId = Number(b.person_id);
  }
  if (!personId) return res.status(400).json({ error: '缺少签到人员' });
  let result;
  db.transaction(() => { result = doSignin(t, personId, { method, clientEventId: b.client_event_id, signedAt: b.signed_at }); })();
  // 代签记录 proxy_user_id
  if (!result.duplicated && method === 'proxy') {
    db.prepare('UPDATE attendance SET proxy_user_id=? WHERE id=?').run(req.user.id, result.id);
    audit(req.user, 'proxy_signin', 'training', t.id,
      { person_id: personId, client_event_id: b.client_event_id || null });
  } else if (!result.duplicated) {
    audit(req.user, 'signin', 'training', t.id, { person_id: personId });
  }
  res.json(result);
});

// 弱网批量补传（去重）
router.post('/signin-batch', (req, res) => {
  const items = req.body?.items || [];
  let created = 0, duplicated = 0;
  db.transaction(() => items.forEach(it => {
    const t = db.prepare('SELECT * FROM trainings WHERE id=?').get(it.training_id);
    if (!t) return;
    const personId = it.person_id || (req.user.role === 'farmer' ? req.user.person_id : null);
    if (!personId) return;
    const r = doSignin(t, personId, {
      method: it.method === 'proxy' ? 'proxy' : 'scan',
      clientEventId: it.client_event_id, signedAt: it.signed_at });
    if (r.duplicated) duplicated++; else {
      created++;
      if (it.method === 'proxy' && req.user.role !== 'farmer')
        db.prepare('UPDATE attendance SET proxy_user_id=? WHERE id=?').run(req.user.id, r.id);
    }
  }))();
  audit(req.user, 'signin_batch_sync', 'training', null, { created, duplicated });
  res.json({ ok: true, created, duplicated });
});

// 药农对讲师授课评分
router.post('/:id/feedback', (req, res) => {
  const score = Math.max(1, Math.min(5, Number(req.body?.score) || 0));
  if (!score) return res.status(400).json({ error: '评分 1-5' });
  const pid = req.user.role === 'farmer' ? req.user.person_id : Number(req.body?.person_id);
  db.prepare(`INSERT INTO training_feedback (training_id, person_id, score) VALUES (?,?,?)
    ON CONFLICT(training_id, person_id) DO UPDATE SET score=excluded.score`)
    .run(req.params.id, pid, score);
  const t = db.prepare('SELECT trainer_id FROM trainings WHERE id=?').get(req.params.id);
  if (t?.trainer_id) {
    const r = db.prepare('SELECT COALESCE(SUM(score),0) s, COUNT(*) c FROM training_feedback fb JOIN trainings tr ON tr.id=fb.training_id WHERE tr.trainer_id=?').get(t.trainer_id);
    db.prepare('UPDATE trainers SET rating_sum=?, rating_count=? WHERE id=?').run(r.s, r.c, t.trainer_id);
  }
  res.json({ ok: true });
});

module.exports = router;
