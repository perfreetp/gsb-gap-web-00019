const express = require('express');
const { db, now, audit } = require('../db');
const { baseScope, requireRole } = require('../auth');
const router = express.Router();

// 课件列表（可按科目过滤）
router.get('/', (req, res) => {
  const { subject_id } = req.query;
  const rows = db.prepare(`SELECT c.*, s.name AS subject_name FROM courses c
    JOIN subjects s ON s.id=c.subject_id
    ${subject_id ? 'WHERE c.subject_id=?' : ''} ORDER BY c.subject_id, c.id`)
    .all(...(subject_id ? [Number(subject_id)] : []));
  res.json(rows);
});

// 课件创建（技术员/管理员）
router.post('/', requireRole('base_admin', 'tech', 'enterprise'), (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.subject_id) return res.status(400).json({ error: '标题与科目必填' });
  const info = db.prepare(`INSERT INTO courses (subject_id, title, type, duration_sec, content, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(Number(b.subject_id), b.title, b.type === 'video' ? 'video' : 'doc',
      Number(b.duration_sec) || 0, b.content || '', now());
  audit(req.user, 'create', 'course', info.lastInsertRowid, { title: b.title });
  res.json({ id: info.lastInsertRowid });
});

// 某人的学习进度（本人/管理员/技术员/企业）
router.get('/progress/:personId', (req, res) => {
  const pid = Number(req.params.personId);
  if (req.user.role === 'farmer' && req.user.person_id !== pid)
    return res.status(403).json({ error: '只能查看本人学习记录' });
  const rows = db.prepare(`SELECT c.id AS course_id, c.title, c.type, c.duration_sec, c.subject_id,
      s.name AS subject_name,
      COALESCE(cp.watched_sec,0) AS watched_sec, COALESCE(cp.completed,0) AS completed,
      cp.updated_at
    FROM courses c JOIN subjects s ON s.id=c.subject_id
    LEFT JOIN course_progress cp ON cp.course_id=c.id AND cp.person_id=?
    ORDER BY c.subject_id, c.id`).all(pid);
  res.json(rows);
});

// 上报观看进度（弱网批量补传由客户端累积后一次性提交，服务端取最大值去重）
router.post('/progress', (req, res) => {
  const b = req.body || {};
  const pid = req.user.role === 'farmer' ? req.user.person_id : Number(b.person_id);
  if (!pid) return res.status(400).json({ error: '缺少人员' });
  const items = Array.isArray(b.items) ? b.items : [b];
  const upsert = db.prepare(`INSERT INTO course_progress (person_id, course_id, watched_sec, completed, updated_at)
    VALUES (?,?,?,?,?) ON CONFLICT(person_id, course_id) DO UPDATE SET
      watched_sec=MAX(course_progress.watched_sec, excluded.watched_sec),
      completed=MAX(course_progress.completed, excluded.completed),
      updated_at=excluded.updated_at`);
  let touched = 0;
  const tx = db.transaction(() => items.forEach(it => {
    if (!it.course_id) return;
    const course = db.prepare('SELECT duration_sec FROM courses WHERE id=?').get(it.course_id);
    if (!course) return;
    const watched = Math.max(0, Number(it.watched_sec) || 0);
    const completed = it.completed ? 1
      : (course.duration_sec > 0 && watched >= course.duration_sec ? 1 : 0);
    upsert.run(pid, it.course_id, watched, completed, now());
    touched++;
  }));
  tx();
  res.json({ ok: true, touched });
});

module.exports = router;
