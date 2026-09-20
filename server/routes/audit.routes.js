const express = require('express');
const { db } = require('../db');
const { baseScope, requireRole } = require('../auth');
const router = express.Router();

router.get('/', requireRole('tech', 'base_admin', 'enterprise'), (req, res) => {
  const { entity, action, q, limit = 100 } = req.query;
  const where = [];
  const args = [];
  if (entity) { where.push('entity=?'); args.push(entity); }
  if (action) { where.push('action LIKE ?'); args.push(`%${action}%`); }
  if (q) { where.push('(actor_name LIKE ? OR detail LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  const rows = db.prepare(`SELECT * FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT ${Math.min(500, Number(limit) || 100)}`).all(...args);
  res.json(rows.map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })));
});

module.exports = router;
