const express = require('express');
const { db, now, notify, audit } = require('../db');
const { baseScope, requireRole } = require('../auth');
const examRoutes = require('./exams.routes');
const router = express.Router();

// 待评阅列表：已交卷且有未评主观题；企业可跨基地
router.get('/pending', (req, res) => {
  const scope = baseScope(req);
  const rows = db.prepare(`SELECT r.id AS reg_id, r.status, r.graded, r.person_id, p.name AS person_name,
      e.id AS exam_id, e.title, e.base_id, e.pass_score, r.paper_version, r.attempt,
      COUNT(a.id) AS answer_count,
      SUM(CASE WHEN q.type='short' AND NOT EXISTS (SELECT 1 FROM answer_grades g WHERE g.answer_id=a.id) THEN 1 ELSE 0 END) AS pending_count
    FROM exam_registrations r
    JOIN exams e ON e.id=r.exam_id
    JOIN people p ON p.id=r.person_id
    JOIN exam_answers a ON a.reg_id=r.id
    JOIN question_bank q ON q.id=a.question_id
    WHERE r.status IN ('submitted','graded')
    ${scope ? 'AND e.base_id=?' : ''}
    GROUP BY r.id HAVING pending_count > 0
    ORDER BY r.submitted_at DESC`).all(...(scope ? [scope] : []));
  res.json(rows);
});

// 某场报考的评阅详情（题目、考生答案、已有评阅，对技术员隐藏正确答案以外内容）
router.get('/registration/:regId', (req, res) => {
  const reg = db.prepare(`SELECT r.*, e.base_id, e.title, e.pass_score FROM exam_registrations r
    JOIN exams e ON e.id=r.exam_id WHERE r.id=?`).get(req.params.regId);
  if (!reg) return res.status(404).json({ error: '记录不存在' });
  if (req.user.role !== 'enterprise' && reg.base_id !== req.user.base_id)
    return res.status(403).json({ error: '无权查看' });
  const paper = db.prepare('SELECT question_ids FROM exam_papers WHERE exam_id=? AND version=?')
    .get(reg.exam_id ? reg.exam_id : null, reg.paper_version);
  const qIds = JSON.parse(paper.question_ids);
  const questions = qIds.map(id => {
    const q = db.prepare('SELECT * FROM question_bank WHERE id=?').get(id);
    const ans = db.prepare('SELECT * FROM exam_answers WHERE reg_id=? AND question_id=?')
      .get(reg.id, id);
    const grades = ans ? db.prepare(`SELECT g.*, u.name AS grader_name FROM answer_grades g
      JOIN users u ON u.id=g.grader_id WHERE answer_id=?`).all(ans.id) : [];
    let given = null;
    try { given = ans?.answer ? JSON.parse(ans.answer) : null; } catch { given = ans?.answer; }
    return { id, type: q.type, stem: q.stem, image_url: q.image_url,
      options: q.options ? JSON.parse(q.options) : null, reference_answer: q.answer,
      analysis: q.analysis, answer_id: ans?.id || null, given,
      current_score: ans?.score ?? null, grades };
  });
  const appeals = db.prepare(`SELECT a.*, u.name AS reviewer_name FROM appeals a
    LEFT JOIN users u ON u.id=a.reviewer_id WHERE a.reg_id=?`).all(reg.id);
  res.json({ registration: reg, questions, appeals });
});

// 评阅打分（按答案；同一评阅人对同一答案仅一条，支持改分留痕到审计）
router.post('/answer/:answerId/grade', requireRole('tech', 'base_admin', 'enterprise'), (req, res) => {
  const answerId = Number(req.params.answerId);
  const score = Math.max(0, Math.min(100, Number(req.body?.score)));
  if (Number.isNaN(score)) return res.status(400).json({ error: '分值 0-100' });
  const ans = db.prepare(`SELECT a.*, r.exam_id, r.person_id, r.id AS reg_id FROM exam_answers a
    JOIN exam_registrations r ON r.id=a.reg_id WHERE a.id=?`).get(answerId);
  if (!ans) return res.status(404).json({ error: '答案不存在' });
  const exam = db.prepare('SELECT base_id FROM exams WHERE id=?').get(ans.exam_id);
  if (req.user.role !== 'enterprise' && exam.base_id !== req.user.base_id)
    return res.status(403).json({ error: '无权评阅' });

  const prev = db.prepare('SELECT * FROM answer_grades WHERE answer_id=? AND grader_id=?')
    .get(answerId, req.user.id);
  if (prev) {
    db.prepare('UPDATE answer_grades SET score=?, comment=? WHERE id=?')
      .run(score, req.body.comment || '', prev.id);
    audit(req.user, 'grade_update', 'answer_grade', prev.id,
      { answer_id: answerId, from: prev.score, to: score });
  } else {
    db.prepare('INSERT INTO answer_grades (answer_id, grader_id, score, comment, created_at) VALUES (?,?,?,?,?)')
      .run(answerId, req.user.id, score, req.body.comment || '', now());
    audit(req.user, 'grade', 'answer_grade', answerId, { score });
  }

  // 双评触发：达到 2 名评阅人后重新汇总
  const gCount = db.prepare('SELECT COUNT(*) c FROM answer_grades WHERE answer_id=?').get(answerId).c;
  const result = examRoutes.gradeRegistration(ans.reg_id);
  const reg = db.prepare('SELECT * FROM exam_registrations WHERE id=?').get(ans.reg_id);
  if (gCount >= 2 || result.fully) {
    const fullExam = db.prepare('SELECT * FROM exams WHERE id=?').get(ans.exam_id);
    const subject = db.prepare('SELECT name FROM subjects WHERE id=?').get(fullExam.subject_id);
    audit(req.user, gCount >= 2 ? 'double_grade_average' : 'grading_complete',
      'exam_registration', reg.id, { graders: gCount, ...result });
    if (result.fully) {
      const passed = result.total >= fullExam.pass_score;
      if (passed) examRoutes.issueCertificateIfPassed(reg);
      else notify({ person_id: reg.person_id, base_id: fullExam.base_id, type: 'exam_fail',
        title: `考核结果：${fullExam.title}`,
        body: `您的成绩为 ${result.total} 分，未达及格线 ${fullExam.pass_score} 分，可参加补考。`,
        ref_type: 'exam', ref_id: fullExam.id });
    }
  }
  res.json({ ok: true, grader_count: gCount, result });
});

// 申诉列表
router.get('/appeals', (req, res) => {
  const scope = baseScope(req);
  const rows = db.prepare(`SELECT a.*, p.name AS person_name, e.title, e.base_id, r.total_score
    FROM appeals a
    JOIN exam_registrations r ON r.id=a.reg_id
    JOIN people p ON p.id=r.person_id
    JOIN exams e ON e.id=r.exam_id
    ${scope ? 'WHERE e.base_id=?' : ''} ORDER BY
    CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC`).all(...(scope ? [scope] : []));
  res.json(rows);
});

// 复核申诉：可调整分数（重算成绩、补发/不发证书），全程留痕
router.post('/appeal/:id/review', requireRole('tech', 'base_admin', 'enterprise'), (req, res) => {
  const appeal = db.prepare('SELECT * FROM appeals WHERE id=?').get(req.params.id);
  if (!appeal) return res.status(404).json({ error: '申诉不存在' });
  const reg = db.prepare(`SELECT r.*, e.base_id, e.title FROM exam_registrations r
    JOIN exams e ON e.id=r.exam_id WHERE r.id=?`).get(appeal.reg_id);
  if (req.user.role !== 'enterprise' && reg.base_id !== req.user.base_id)
    return res.status(403).json({ error: '无权复核' });
  const { status, reply, adjust_score } = req.body || {};
  if (!['reviewed', 'rejected', 'adjusted'].includes(status))
    return res.status(400).json({ error: '复核状态无效' });
  db.prepare('UPDATE appeals SET status=?, reply=?, reviewer_id=?, reviewed_at=? WHERE id=?')
    .run(status, reply || '', req.user.id, now(), appeal.id);
  let adjustedTo = null;
  if (status === 'adjusted' && adjust_score != null) {
    const score = Number(Number(adjust_score).toFixed(2));
    db.prepare('UPDATE exam_registrations SET total_score=?, graded=1, status=? WHERE id=?')
      .run(score, 'graded', reg.id);
    adjustedTo = score;
    const updated = db.prepare('SELECT * FROM exam_registrations WHERE id=?').get(reg.id);
    const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(reg.exam_id);
    if (score >= exam.pass_score) examRoutes.issueCertificateIfPassed(updated);
  }
  audit(req.user, 'appeal_review', 'appeal', appeal.id,
    { from_score: reg.total_score, adjustedTo, status, reply });
  notify({ person_id: reg.person_id, type: 'appeal_result', title: '申诉复核结果',
    body: reply || '您的申诉已完成复核。', ref_type: 'appeal', ref_id: appeal.id });
  res.json({ ok: true });
});

module.exports = router;
