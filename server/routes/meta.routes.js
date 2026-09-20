const express = require('express');
const { db } = require('../db');
const { baseScope } = require('../auth');
const router = express.Router();

// 下拉/标签等基础数据，自动按角色限定基地范围
router.get('/', (req, res) => {
  const scope = baseScope(req);
  const bases = db.prepare('SELECT id, name FROM bases ORDER BY id').all();
  const basesScoped = scope ? bases.filter(b => b.id === scope) : bases;
  const coopRows = db.prepare('SELECT id, base_id, name FROM cooperatives ORDER BY name').all();
  const plotRows = db.prepare('SELECT id, base_id, cooperative_id, code, name, crop_variety, manager_id FROM plots ORDER BY code').all();
  const coops = coopRows.filter(c => !scope || c.base_id === scope);
  const plots = plotRows.filter(p => !scope || p.base_id === scope)
    .map(p => ({ ...p, manager_name: personName(p.manager_id) }));
  function personName(id) {
    if (!id) return null;
    const r = db.prepare('SELECT name FROM people WHERE id=?').get(id);
    return r ? r.name : null;
  }
  res.json({
    bases: basesScoped,
    cooperatives: coops,
    plots,
    subjects: db.prepare('SELECT * FROM subjects ORDER BY id').all(),
    skill_tags: db.prepare('SELECT * FROM skill_tags ORDER BY id').all()
      .map(t => ({ ...t, required_subject_ids: JSON.parse(t.required_subject_ids) })),
    trainers: db.prepare('SELECT * FROM trainers ORDER BY id').all(),
    role: req.user.role,
    user: req.user,
  });
});

module.exports = router;
