const express = require('express');
const { db } = require('../db');
const router = express.Router();

router.get('/', (req, res) => {
  const u = req.user;
  let rows;
  if (u.role === 'farmer') {
    rows = db.prepare(`SELECT * FROM notifications WHERE person_id=? ORDER BY created_at DESC LIMIT 50`)
      .all(u.person_id);
  } else if (u.role === 'enterprise') {
    rows = db.prepare(`SELECT * FROM notifications WHERE (user_id=? OR user_id IS NULL)
      ORDER BY created_at DESC LIMIT 50`).all(u.id);
  } else {
    rows = db.prepare(`SELECT * FROM notifications WHERE base_id=? AND (user_id=? OR user_id IS NULL)
      ORDER BY created_at DESC LIMIT 50`).all(u.base_id, u.id);
  }
  res.json(rows);
});

router.post('/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET read=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/read-all', (req, res) => {
  const u = req.user;
  if (u.role === 'farmer') db.prepare('UPDATE notifications SET read=1 WHERE person_id=?').run(u.person_id);
  else if (u.role === 'enterprise')
    db.prepare('UPDATE notifications SET read=1 WHERE user_id=? OR user_id IS NULL').run(u.id);
  else db.prepare('UPDATE notifications SET read=1 WHERE base_id=?').run(u.base_id);
  res.json({ ok: true });
});

module.exports = router;
