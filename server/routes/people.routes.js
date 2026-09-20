const express = require('express');
const { db, now, audit } = require('../db');
const { baseScope, requireRole } = require('../auth');
const router = express.Router();

const PERSON_COLS = `
  SELECT p.*, c.name AS cooperative_name, pl.code AS plot_code, pl.name AS plot_name,
  GROUP_CONCAT(st.id) AS tag_ids, GROUP_CONCAT(st.name) AS tag_names
  FROM people p
  LEFT JOIN cooperatives c ON c.id = p.cooperative_id
  LEFT JOIN plots pl ON pl.id = p.plot_id
  LEFT JOIN person_skills ps ON ps.person_id = p.id
  LEFT JOIN skill_tags st ON st.id = ps.tag_id
`;

function rowToPerson(r) {
  if (!r) return r;
  return { ...r, tag_ids: r.tag_ids ? String(r.tag_ids).split(',').map(Number) : [],
    tag_names: r.tag_names ? String(r.tag_names).split(',') : [] };
}

// 列表（企业可加 base_id 过滤；基地角色仅本基地）
router.get('/', (req, res) => {
  const scope = baseScope(req);
  const { q, cooperative_id, plot_id, tag_id, employment_type, base_id } = req.query;
  const where = ['(p.merged_into IS NULL)'];
  const args = [];
  const bid = scope || (base_id ? Number(base_id) : null);
  if (bid) { where.push('p.base_id=?'); args.push(bid); }
  if (cooperative_id) { where.push('p.cooperative_id=?'); args.push(Number(cooperative_id)); }
  if (plot_id) { where.push('p.plot_id=?'); args.push(Number(plot_id)); }
  if (employment_type) { where.push('p.employment_type=?'); args.push(employment_type); }
  if (q) { where.push('(p.name LIKE ? OR p.id_card LIKE ? OR p.phone LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  let sql = PERSON_COLS + ' WHERE ' + where.join(' AND ') + ' GROUP BY p.id ORDER BY p.id';
  let rows = db.prepare(sql).all(...args);
  if (tag_id) rows = rows.filter(r => rowToPerson(r).tag_ids.includes(Number(tag_id)));
  res.json(rows.map(rowToPerson));
});

router.get('/:id', (req, res) => {
  const r = db.prepare(PERSON_COLS + ' WHERE p.id=? GROUP BY p.id').get(req.params.id);
  if (!r) return res.status(404).json({ error: '人员不存在' });
  const person = rowToPerson(r);
  if (req.user.role !== 'enterprise' && person.base_id !== req.user.base_id)
    return res.status(403).json({ error: '无权查看他基地人员' });
  res.json(person);
});

function findDuplicate(baseId, { id_card, phone, name }) {
  if (id_card) {
    const r = db.prepare('SELECT * FROM people WHERE base_id=? AND id_card=? AND merged_into IS NULL')
      .get(baseId, id_card);
    if (r) return r;
  }
  if (phone && name) {
    const r = db.prepare('SELECT * FROM people WHERE base_id=? AND phone=? AND name=? AND merged_into IS NULL')
      .get(baseId, phone, name);
    if (r) return r;
  }
  return null;
}

router.post('/', requireRole('base_admin', 'enterprise'), (req, res) => {
  const b = req.body || {};
  const baseId = req.user.base_id || Number(b.base_id);
  if (!baseId) return res.status(400).json({ error: '请指定基地' });
  const dup = findDuplicate(baseId, b);
  if (dup) return res.status(409).json({ error: '检测到重复人员，建议合并', duplicate: rowToPerson(
    db.prepare(PERSON_COLS + ' WHERE p.id=? GROUP BY p.id').get(dup.id)) });
  const info = db.prepare(`INSERT INTO people
    (base_id, name, id_card, phone, cooperative_id, plot_id, employment_type, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(baseId, b.name, b.id_card || null, b.phone || null,
    b.cooperative_id || null, b.plot_id || null, b.employment_type || 'seasonal', now(), now());
  setTags(info.lastInsertRowid, b.tag_ids || []);
  audit(req.user, 'create', 'person', info.lastInsertRowid, { name: b.name });
  res.json(rowToPerson(db.prepare(PERSON_COLS + ' WHERE p.id=? GROUP BY p.id').get(info.lastInsertRowid)));
});

function setTags(personId, tagIds) {
  db.prepare('DELETE FROM person_skills WHERE person_id=?').run(personId);
  const ins = db.prepare('INSERT OR IGNORE INTO person_skills (person_id, tag_id) VALUES (?,?)');
  [...new Set(tagIds.map(Number))].forEach(tid => ins.run(personId, tid));
}

router.put('/:id', requireRole('base_admin', 'enterprise', 'tech'), (req, res) => {
  const person = db.prepare('SELECT * FROM people WHERE id=?').get(req.params.id);
  if (!person) return res.status(404).json({ error: '人员不存在' });
  if (req.user.role !== 'enterprise' && person.base_id !== req.user.base_id)
    return res.status(403).json({ error: '无权操作他基地人员' });
  const b = req.body || {};
  db.prepare(`UPDATE people SET name=?, id_card=?, phone=?, cooperative_id=?, plot_id=?,
    employment_type=?, updated_at=? WHERE id=?`)
    .run(b.name ?? person.name, b.id_card ?? person.id_card, b.phone ?? person.phone,
      b.cooperative_id ?? person.cooperative_id, b.plot_id ?? person.plot_id,
      b.employment_type ?? person.employment_type, now(), person.id);
  if (Array.isArray(b.tag_ids)) setTags(person.id, b.tag_ids);
  audit(req.user, 'update', 'person', person.id, { fields: Object.keys(b) });
  res.json(rowToPerson(db.prepare(PERSON_COLS + ' WHERE p.id=? GROUP BY p.id').get(person.id)));
});

// 合并重复人员：把 source 数据并入 target，迁移关联记录，source 标记删除
router.post('/merge', requireRole('base_admin', 'enterprise'), (req, res) => {
  const { source_id, target_id } = req.body || {};
  const source = db.prepare('SELECT * FROM people WHERE id=?').get(source_id);
  const target = db.prepare('SELECT * FROM people WHERE id=?').get(target_id);
  if (!source || !target || source.id === target.id)
    return res.status(400).json({ error: '合并对象无效' });
  if (req.user.role !== 'enterprise' && (source.base_id !== req.user.base_id || target.base_id !== req.user.base_id))
    return res.status(403).json({ error: '无权跨基地操作' });
  const merged = { source_name: source.name, target_name: target.name, migrated: {} };
  db.transaction(() => {
    // 互补字段
    db.prepare(`UPDATE people SET
      id_card = COALESCE(id_card, ?), phone = COALESCE(phone, ?),
      cooperative_id = COALESCE(cooperative_id, ?), plot_id = COALESCE(plot_id, ?),
      employment_type = CASE WHEN employment_type='seasonal' THEN ? ELSE employment_type END,
      updated_at=? WHERE id=?`)
      .run(source.id_card, source.phone, source.cooperative_id, source.plot_id,
        source.employment_type, now(), target.id);
    // 关联表 -> 业务唯一列（迁移时按该列去重）
    const uniqueCols = {
      person_skills: 'tag_id',
      course_progress: 'course_id',
      attendance: 'training_id',
      training_feedback: 'training_id',
      exam_registrations: ['exam_id', 'attempt'],
      certificates: ['subject_id', 'exam_id'],
      harvest_workers: 'batch_id',
    };
    const move = (table, col) => {
      const cols = Array.isArray(col) ? col : [col];
      const rows = db.prepare(`SELECT * FROM ${table} WHERE person_id=?`).all(source.id);
      rows.forEach(row => {
        const whereSql = cols.map(c => `${c}=?`).join(' AND ');
        const vals = cols.map(c => row[c]);
        const existsQuery = table === 'person_skills'
          ? `SELECT person_id FROM ${table} WHERE person_id=? AND ${whereSql}`
          : `SELECT id FROM ${table} WHERE person_id=? AND ${whereSql}`;
        const exists = db.prepare(existsQuery).get(target.id, ...vals);
        if (exists) {
          if (table === 'person_skills')
            db.prepare(`DELETE FROM ${table} WHERE person_id=? AND tag_id=?`).run(source.id, row.tag_id);
          else db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
        } else if (table === 'person_skills') {
          db.prepare(`INSERT OR IGNORE INTO person_skills (person_id, tag_id) VALUES (?,?)`)
            .run(target.id, row.tag_id);
          db.prepare('DELETE FROM person_skills WHERE person_id=? AND tag_id=?').run(source.id, row.tag_id);
        } else {
          db.prepare(`UPDATE ${table} SET person_id=? WHERE id=?`).run(target.id, row.id);
        }
      });
      merged.migrated[table] = rows.length;
    };
    ['person_skills', 'course_progress', 'attendance', 'training_feedback',
     'exam_registrations', 'certificates', 'harvest_workers', 'notifications'].forEach(t => {
      const keyCol = uniqueCols[t];
      if (t === 'notifications') {
        db.prepare('UPDATE notifications SET person_id=? WHERE person_id=?').run(target.id, source.id);
        merged.migrated[t] = 1;
      } else move(t, keyCol);
    });
    db.prepare('UPDATE people SET merged_into=?, updated_at=? WHERE id=?').run(target.id, now(), source.id);
  })();
  audit(req.user, 'merge', 'person', target.id, merged);
  res.json({ ok: true, merged });
});

// 极简 CSV（支持引号与逗号）
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(v => v.trim() !== '')) rows.push(row); }
  return rows;
}

// 批量导入：表头 姓名,身份证,手机号,合作社,地块,用工类型,工种标签(;分隔)
// 自动识别重复：匹配则合并工种标签，不新建
router.post('/import', requireRole('base_admin', 'enterprise'), (req, res) => {
  const { csv } = req.body || {};
  const baseId = req.user.base_id || Number(req.body.base_id);
  if (!csv || !baseId) return res.status(400).json({ error: '缺少 CSV 内容或基地' });
  const rows = parseCsv(csv.trim());
  if (rows.length < 2) return res.status(400).json({ error: 'CSV 至少需要表头与一行数据' });
  const coops = Object.fromEntries(db.prepare('SELECT name, id FROM cooperatives WHERE base_id=?').all(baseId)
    .map(r => [r.name, r.id]));
  const plots = Object.fromEntries(db.prepare('SELECT code, id FROM plots WHERE base_id=?').all(baseId)
    .map(r => [r.code, r.id]));
  const tags = Object.fromEntries(db.prepare('SELECT code, id FROM skill_tags').all().map(r => [r.code, r.id]));
  const tagByName = Object.fromEntries(db.prepare('SELECT name, id FROM skill_tags').all().map(r => [r.name, r.id]));

  const result = { created: 0, merged: 0, skipped: 0, details: [] };
  const tx = db.transaction(() => {
    for (let i = 1; i < rows.length; i++) {
      const [name, idCard, phone, coopName, plotCode, empType, tagList] = rows[i].map(v => (v || '').trim());
      if (!name) { result.skipped++; continue; }
      const tagIds = (tagList || '').split(/[;;、,，]/).map(s => s.trim()).filter(Boolean)
        .map(s => tags[s] || tagByName[s]).filter(Boolean);
      const dup = findDuplicate(baseId, { id_card: idCard, phone, name });
      if (dup) {
        const exist = db.prepare('SELECT tag_id FROM person_skills WHERE person_id=?').all(dup.id).map(r => r.tag_id);
        setTags(dup.id, [...exist, ...tagIds]);
        db.prepare('UPDATE people SET updated_at=? WHERE id=?').run(now(), dup.id);
        result.merged++;
        result.details.push({ name, action: 'merged', target_id: dup.id });
      } else {
        const info = db.prepare(`INSERT INTO people
          (base_id, name, id_card, phone, cooperative_id, plot_id, employment_type, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(baseId, name, idCard || null, phone || null,
          coops[coopName] || null, plots[plotCode] || null,
          empType.includes('长期') ? 'long_term' : 'seasonal', now(), now());
        setTags(info.lastInsertRowid, tagIds);
        result.created++;
        result.details.push({ name, action: 'created', id: info.lastInsertRowid });
      }
    }
  });
  tx();
  audit(req.user, 'import', 'person', null, { created: result.created, merged: result.merged });
  res.json(result);
});

// 重复人员候选清单（身份证重复 或 姓名+手机重复）
router.get('/duplicates/list', (req, res) => {
  const scope = baseScope(req);
  const sql = `SELECT a.id AS a_id, b.id AS b_id, a.name, a.id_card, a.phone
    FROM people a JOIN people b ON a.base_id=b.base_id AND a.id<b.id
      AND a.merged_into IS NULL AND b.merged_into IS NULL
      AND ((a.id_card IS NOT NULL AND a.id_card=b.id_card)
        OR (a.phone IS NOT NULL AND a.phone=b.phone AND a.name=b.name))
    ${scope ? 'WHERE a.base_id=?' : ''} ORDER BY a.id`;
  res.json(scope ? db.prepare(sql).all(scope) : db.prepare(sql).all());
});

module.exports = router;
