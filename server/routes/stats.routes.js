const express = require('express');
const { db } = require('../db');
const { baseScope } = require('../auth');
const router = express.Router();

// 总览：合格率（考核）、培训覆盖、证书、预警计数
router.get('/overview', (req, res) => {
  const scope = baseScope(req);
  const args = scope ? [scope] : [];
  const sc = s => scope ? `${s} e.base_id=?` : s;

  const exams = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN r.status='graded' THEN 1 ELSE 0 END) AS graded,
      SUM(CASE WHEN r.status='graded' AND r.total_score>=e.pass_score THEN 1 ELSE 0 END) AS passed
    FROM exam_registrations r JOIN exams e ON e.id=r.exam_id
    WHERE r.status='graded' ${scope ? 'AND e.base_id=?' : ''}`).get(...args);

  const trainings = db.prepare(`SELECT
      (SELECT COUNT(*) FROM trainings t ${scope ? 'WHERE t.base_id=?' : ''}) AS sessions,
      (SELECT COUNT(*) FROM attendance a JOIN trainings t ON t.id=a.training_id
        ${scope ? 'WHERE t.base_id=?' : ''}) AS signins`).get(...(scope ? [scope, scope] : []));

  const certs = db.prepare(`SELECT COUNT(*) c FROM certificates c JOIN people p ON p.id=c.person_id
    WHERE c.revoked=0 ${scope ? 'AND p.base_id=?' : ''}`).get(...args).c;
  const expiring = db.prepare(`SELECT COUNT(*) c FROM certificates c JOIN people p ON p.id=c.person_id
    WHERE c.revoked=0 AND c.valid_until IS NOT NULL AND c.valid_until<=?
    ${scope ? 'AND p.base_id=?' : ''}`)
    .get(Date.now() + 30 * 86400000, ...(scope ? [scope] : [])).c;
  const warnings = db.prepare(`SELECT COUNT(*) c FROM harvest_workers hw JOIN harvest_batches hb ON hb.id=hw.batch_id
    WHERE hw.certified=0 ${scope ? 'AND hb.base_id=?' : ''}`).get(...args).c;

  res.json({
    exams,
    pass_rate: exams.graded ? Number((exams.passed / exams.graded * 100).toFixed(1)) : null,
    trainings, certs, expiring_certs: expiring, harvest_warnings: warnings,
    people: db.prepare(`SELECT COUNT(*) c FROM people WHERE merged_into IS NULL ${scope ? 'AND base_id=?' : ''}`)
      .get(...args).c,
  });
});

// 合格率维度：地块 / 合作社 / 科目
router.get('/pass-rate', (req, res) => {
  const scope = baseScope(req);
  const dim = ['plot', 'cooperative', 'subject'].includes(req.query.dim) ? req.query.dim : 'subject';
  let join, labelCol;
  if (dim === 'plot') { join = `JOIN plots pl ON pl.id=p.plot_id`; labelCol = "COALESCE(pl.code || pl.name, '未分配地块')"; }
  else if (dim === 'cooperative') { join = `JOIN cooperatives co ON co.id=p.cooperative_id`; labelCol = "COALESCE(co.name, '未入社')"; }
  else { join = `JOIN subjects s2 ON s2.id=e.subject_id`; labelCol = 's2.name'; }
  const rows = db.prepare(`SELECT ${labelCol} AS label,
      SUM(CASE WHEN r.status='graded' THEN 1 ELSE 0 END) AS graded,
      SUM(CASE WHEN r.status='graded' AND r.total_score>=e.pass_score THEN 1 ELSE 0 END) AS passed,
      ROUND(100.0*SUM(CASE WHEN r.status='graded' AND r.total_score>=e.pass_score THEN 1 ELSE 0 END)/
        NULLIF(SUM(CASE WHEN r.status='graded' THEN 1 ELSE 0 END),0),1) AS rate
    FROM exam_registrations r
    JOIN exams e ON e.id=r.exam_id JOIN people p ON p.id=r.person_id ${join}
    ${scope ? 'WHERE e.base_id=?' : ''}
    GROUP BY label ORDER BY label`).all(...(scope ? [scope] : []));
  res.json(rows);
});

// 缺训名单：某场培训应到未到；或某人本年度缺训统计（不传 training_id 时汇总未来/已结束场次）
router.get('/missing-training', (req, res) => {
  const scope = baseScope(req);
  if (req.query.training_id) {
    const t = db.prepare('SELECT * FROM trainings WHERE id=?').get(req.query.training_id);
    if (!t) return res.json([]);
    const { expectedAttendeeIds } = require('../util');
    const ids = expectedAttendeeIds(t);
    if (!ids.length) return res.json([]);
    const rows = db.prepare(`SELECT p.id, p.name, p.phone, c.name AS cooperative_name FROM people p
      LEFT JOIN cooperatives c ON c.id=p.cooperative_id
      WHERE p.id IN (${ids.map(()=>'?').join(',')}) AND p.merged_into IS NULL
      AND p.id NOT IN (SELECT person_id FROM attendance WHERE training_id=?)`)
      .all(...ids, t.id);
    return res.json(rows.map(r => ({ ...r, training_title: t.title, start_at: t.start_at })));
  }
  // 汇总：每场已结束培训的缺席人员
  const trainings = db.prepare(`SELECT * FROM trainings ${scope ? 'WHERE base_id=?' : ''} ORDER BY start_at`)
    .all(...(scope ? [scope] : []));
  const { expectedAttendeeIds } = require('../util');
  const out = [];
  trainings.filter(t => t.start_at <= Date.now()).forEach(t => {
    const ids = expectedAttendeeIds(t);
    if (!ids.length) return;
    const absent = db.prepare(`SELECT id, name FROM people WHERE merged_into IS NULL AND id IN
      (${ids.map(()=>'?').join(',')}) AND id NOT IN (SELECT person_id FROM attendance WHERE training_id=?)`)
      .all(...ids, t.id);
    absent.forEach(a => out.push({ person_id: a.id, person_name: a.name,
      training_id: t.id, training_title: t.title, start_at: t.start_at }));
  });
  res.json(out);
});

// 每位药农年度学时（按培训时长，已签到计）
router.get('/annual-hours', (req, res) => {
  const scope = baseScope(req);
  const year = Number(req.query.year) || new Date().getFullYear();
  const start = new Date(year, 0, 1).getTime();
  const rows = db.prepare(`SELECT p.id, p.name, c.name AS cooperative_name,
      COUNT(a.id) AS sessions,
      ROUND(COALESCE(SUM(t.duration_min),0)/60.0,1) AS hours
    FROM people p
    LEFT JOIN cooperatives c ON c.id=p.cooperative_id
    LEFT JOIN attendance a ON a.person_id=p.id
    LEFT JOIN trainings t ON t.id=a.training_id AND t.start_at>=? AND t.start_at<?
      ${scope ? 'AND t.base_id=?' : ''}
    WHERE p.merged_into IS NULL ${scope ? 'AND p.base_id=?' : ''}
    GROUP BY p.id ORDER BY hours DESC`).all(start, start + 366 * 86400000, ...(scope ? [scope, scope] : []));
  res.json(rows);
});

// 讲师授课评分
router.get('/trainer-ratings', (req, res) => {
  const rows = db.prepare(`SELECT tr.id, tr.name, tr.title,
      (SELECT COUNT(*) FROM trainings t WHERE t.trainer_id=tr.id) AS sessions,
      ROUND(AVG(fb.score),2) AS avg_score, COUNT(fb.id) AS feedback_count
    FROM trainers tr
    LEFT JOIN trainings t ON t.trainer_id=tr.id
    LEFT JOIN training_feedback fb ON fb.training_id=t.id
    GROUP BY tr.id ORDER BY avg_score DESC NULLS LAST`).all();
  res.json(rows);
});

module.exports = router;
