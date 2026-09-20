const express = require('express');
const { db, now, notify, audit } = require('../db');
const { baseScope, requireRole } = require('../auth');
const { validCertificate, checkSkillCertified } = require('../util');
const router = express.Router();

// 登记前预检：录入地块与作业人员，返回每人持证状态与警示
router.post('/check-workers', (req, res) => {
  const { plot_id, workers } = req.body || {};
  if (!plot_id || !Array.isArray(workers)) return res.status(400).json({ error: '地块与人员必填' });
  const result = workers.map(w => {
    const person = db.prepare('SELECT name FROM people WHERE id=?').get(w.person_id);
    const check = checkSkillCertified(w.person_id, w.tag_id);
    const tag = db.prepare('SELECT name, required_subject_ids FROM skill_tags WHERE id=?').get(w.tag_id);
    const missingSubjects = check.missing.map(sid => {
      const s = db.prepare('SELECT name FROM subjects WHERE id=?').get(sid);
      const cert = validCertificate(w.person_id, sid);
      return { subject_id: sid, name: s.name, has_any_cert: !!cert };
    });
    return { person_id: w.person_id, person_name: person?.name, tag_name: tag?.name,
      certified: check.certified, missing_subjects: missingSubjects };
  });
  res.json({ all_certified: result.every(r => r.certified), workers: result });
});

// 创建采收批次（无证必须填原因，否则拒绝；全部记录随批次留痕）
router.post('/batches', requireRole('tech', 'base_admin', 'enterprise'), (req, res) => {
  const b = req.body || {};
  const plot = db.prepare('SELECT * FROM plots WHERE id=?').get(b.plot_id);
  if (!plot) return res.status(404).json({ error: '地块不存在' });
  if (req.user.role !== 'enterprise' && plot.base_id !== req.user.base_id)
    return res.status(403).json({ error: '无权操作' });
  if (!Array.isArray(b.workers) || !b.workers.length)
    return res.status(400).json({ error: '至少登记一名作业人员' });

  // 无证人员原因校验
  const enriched = b.workers.map(w => {
    const check = checkSkillCertified(w.person_id, w.tag_id);
    return { ...w, certified: check.certified };
  });
  const uncertified = enriched.filter(w => !w.certified);
  if (uncertified.some(w => !String(w.warning_reason || '').trim()))
    return res.status(409).json({
      error: '存在当期作业人员未持证，必须逐人填写原因后方可登记',
      uncertified: uncertified.map(w => ({ person_id: w.person_id, reason_required: true })),
    });

  const batchNo = b.batch_no || `HV${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(plot.id).padStart(2, '0')}`;
  let batchId;
  db.transaction(() => {
    batchId = db.prepare(`INSERT INTO harvest_batches
      (base_id, plot_id, batch_no, variety, harvested_at, created_by, created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(plot.base_id, plot.id, batchNo, b.variety || plot.crop_variety,
        Number(b.harvested_at) || now(), req.user.id, now()).lastInsertRowid;
    const ins = db.prepare(`INSERT INTO harvest_workers (batch_id, person_id, tag_id, certified, warning_reason)
      VALUES (?,?,?,?,?)`);
    enriched.forEach(w => ins.run(batchId, w.person_id, w.tag_id || null,
      w.certified ? 1 : 0, w.certified ? null : String(w.warning_reason).trim()));
  })();
  // 无证预警通知基地管理员
  uncertified.forEach(w => {
    const person = db.prepare('SELECT name FROM people WHERE id=?').get(w.person_id);
    notify({ base_id: plot.base_id, type: 'harvest_warning',
      title: `采收持证预警：批次 ${batchNo}`,
      body: `作业人员 ${person?.name}(#${w.person_id}) 未持证上岗，已登记原因：${w.warning_reason}`,
      ref_type: 'harvest_batch', ref_id: batchId });
  });
  audit(req.user, 'create', 'harvest_batch', batchId,
    { batch_no: batchNo, workers: enriched.length, uncertified: uncertified.length });
  res.json({ ok: true, id: batchId, batch_no: batchNo, warnings: uncertified.length });
});

router.get('/batches', (req, res) => {
  const scope = baseScope(req);
  const rows = db.prepare(`SELECT hb.*, pl.code AS plot_code, pl.name AS plot_name,
      COUNT(hw.id) AS worker_count,
      SUM(CASE WHEN hw.certified=0 THEN 1 ELSE 0 END) AS warning_count
    FROM harvest_batches hb
    JOIN plots pl ON pl.id=hb.plot_id
    LEFT JOIN harvest_workers hw ON hw.batch_id=hb.id
    ${scope ? 'WHERE hb.base_id=?' : ''}
    GROUP BY hb.id ORDER BY hb.harvested_at DESC`).all(...(scope ? [scope] : []));
  res.json(rows);
});

// 批次留痕详情（可导出给下游客户/检查方）
router.get('/batches/:id', (req, res) => {
  const batch = db.prepare(`SELECT hb.*, pl.code AS plot_code, pl.name AS plot_name, b.name AS base_name,
      c.name AS cooperative_name FROM harvest_batches hb
    JOIN plots pl ON pl.id=hb.plot_id JOIN bases b ON b.id=hb.base_id
    LEFT JOIN cooperatives c ON c.id=pl.cooperative_id WHERE hb.id=?`).get(req.params.id);
  if (!batch) return res.status(404).json({ error: '批次不存在' });
  const workers = db.prepare(`SELECT hw.*, p.name AS person_name, p.id_card, p.phone,
      st.name AS tag_name FROM harvest_workers hw
    JOIN people p ON p.id=hw.person_id
    LEFT JOIN skill_tags st ON st.id=hw.tag_id WHERE hw.batch_id=?`).all(batch.id)
    .map(w => {
      const certs = [];
      if (w.tag_id) {
        const tag = db.prepare('SELECT required_subject_ids FROM skill_tags WHERE id=?').get(w.tag_id);
        JSON.parse(tag.required_subject_ids).forEach(sid => {
          const cert = validCertificate(w.person_id, sid, batch.harvested_at);
          const s = db.prepare('SELECT name FROM subjects WHERE id=?').get(sid);
          if (cert) certs.push({ subject: s.name, cert_no: cert.cert_no, valid_until: cert.valid_until });
        });
      }
      return { ...w, certificates: certs };
    });
  res.json({ batch, workers });
});

module.exports = router;
