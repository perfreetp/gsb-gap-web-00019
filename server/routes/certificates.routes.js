const express = require('express');
const { db, now, notify, audit } = require('../db');
const { baseScope, requireRole } = require('../auth');
const { addMonths } = require('../util');
const router = express.Router();

// 证书列表（可按人员/基地/快到期过滤）
router.get('/', (req, res) => {
  const scope = baseScope(req);
  const { person_id, expiring_days } = req.query;
  const where = ['1=1'];
  const args = [];
  if (scope) { where.push('p.base_id=?'); args.push(scope); }
  if (person_id) { where.push('c.person_id=?'); args.push(Number(person_id)); }
  if (req.user.role === 'farmer') {
    where.length = 1;
    where.push('c.person_id=?');
    args.length = 0;
    args.push(req.user.person_id);
  }
  if (expiring_days) {
    where.push('c.valid_until IS NOT NULL AND c.valid_until<=?');
    args.push(now() + Number(expiring_days) * 86400000);
  }
  const rows = db.prepare(`SELECT c.*, p.name AS person_name, p.id_card,
      s.name AS subject_name, s.pesticide_safety, b.name AS base_name, e.title AS exam_title
    FROM certificates c
    JOIN people p ON p.id=c.person_id
    JOIN subjects s ON s.id=c.subject_id
    JOIN bases b ON b.id=p.base_id
    JOIN exams e ON e.id=c.exam_id
    WHERE ${where.join(' AND ')} ORDER BY c.issued_at DESC`).all(...args)
    .map(r => ({ ...r, expired: r.valid_until && r.valid_until <= now(),
      days_left: r.valid_until ? Math.ceil((r.valid_until - now()) / 86400000) : null }));
  res.json(rows);
});

// 证书详情（用于扫码/链接调阅验证）
router.get('/verify/:certNo', (req, res) => {
  const r = db.prepare(`SELECT c.cert_no, c.score, c.issued_at, c.valid_until, c.revoked,
      p.name AS person_name, s.name AS subject_name, b.name AS base_name
    FROM certificates c
    JOIN people p ON p.id=c.person_id
    JOIN subjects s ON s.id=c.subject_id
    JOIN bases b ON b.id=p.base_id WHERE c.cert_no=?`).get(req.params.certNo);
  if (!r) return res.status(404).json({ error: '证书编号不存在' });
  res.json({ ...r, valid: !r.revoked && (!r.valid_until || r.valid_until > now()) });
});

// 到期扫描：30 天内到期发复训提醒（幂等，同证书同窗口只发一次）
router.post('/sweep-expiry', requireRole('tech', 'base_admin', 'enterprise'), (req, res) => {
  const rows = db.prepare(`SELECT c.*, s.name AS subject_name, p.base_id FROM certificates c
    JOIN subjects s ON s.id=c.subject_id JOIN people p ON p.id=c.person_id
    WHERE c.valid_until IS NOT NULL AND c.valid_until>? AND c.valid_until<=? AND c.revoked=0`)
    .all(now(), now() + 30 * 86400000);
  let sent = 0;
  rows.forEach(c => {
    const dup = db.prepare(`SELECT 1 FROM notifications WHERE person_id=? AND type='cert_expiring'
      AND ref_type='certificate' AND ref_id=? AND created_at>=?`).get(c.person_id, c.id, c.issued_at);
    if (dup) return;
    const days = Math.ceil((c.valid_until - now()) / 86400000);
    notify({ person_id: c.person_id, base_id: c.base_id, type: 'cert_expiring',
      title: `证书即将到期：${c.subject_name}`,
      body: `您的证书 ${c.cert_no} 将于 ${days} 天后到期，请及时参加复训与复考。`,
      ref_type: 'certificate', ref_id: c.id });
    sent++;
  });
  audit(req.user, 'cert_expiry_sweep', 'certificate', null, { scanned: rows.length, sent });
  res.json({ ok: true, scanned: rows.length, sent });
});

// 撤销（管理员）
router.post('/:id/revoke', requireRole('base_admin', 'enterprise'), (req, res) => {
  const c = db.prepare('SELECT * FROM certificates WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '证书不存在' });
  db.prepare('UPDATE certificates SET revoked=1 WHERE id=?').run(c.id);
  audit(req.user, 'revoke', 'certificate', c.id, { reason: req.body?.reason || null });
  res.json({ ok: true });
});

module.exports = router;
