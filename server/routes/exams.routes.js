const express = require('express');
const { db, now, notify, audit } = require('../db');
const { baseScope, requireRole } = require('../auth');
const { coursesCompleted, addMonths } = require('../util');
const router = express.Router();

function getExam(id) {
  return db.prepare(`SELECT e.*, s.name AS subject_name, s.pesticide_safety, s.valid_months
    FROM exams e JOIN subjects s ON s.id=e.subject_id WHERE e.id=?`).get(id);
}

// 客观题判分
function gradeObjective(question, answerJson) {
  if (!answerJson) return 0;
  let given;
  try { given = JSON.parse(answerJson); } catch { given = []; }
  const correct = JSON.parse(question.answer || '[]');
  const gs = Array.isArray(given) ? given.slice().sort() : [given].sort();
  const cs = correct.slice().sort();
  return gs.length === cs.length && gs.every((v, i) => v === cs[i]) ? 1 : 0;
}

// 交卷判分：客观题自动、主观题待评；返回是否已出最终成绩
function gradeRegistration(regId) {
  const reg = db.prepare('SELECT * FROM exam_registrations WHERE id=?').get(regId);
  const exam = getExam(reg.exam_id);
  const qIds = JSON.parse(db.prepare('SELECT question_ids FROM exam_papers WHERE exam_id=? AND version=?')
    .get(exam.id, reg.paper_version).question_ids);
  const questions = qIds.map(id => db.prepare('SELECT * FROM question_bank WHERE id=?').get(id));
  const objectiveQs = questions.filter(q => ['single', 'multi', 'judge', 'image'].includes(q.type));
  const subjectiveQs = questions.filter(q => q.type === 'short');
  const perScore = 100 / questions.length;

  let objEarned = 0;
  for (const q of objectiveQs) {
    const ans = db.prepare('SELECT * FROM exam_answers WHERE reg_id=? AND question_id=?').get(regId, q.id);
    const score = gradeObjective(q, ans?.answer) * perScore;
    if (ans) db.prepare('UPDATE exam_answers SET score=? WHERE id=?').run(score, ans.id);
    objEarned += score;
  }
  objEarned = Number(objEarned.toFixed(2));

  // 主观题：每题取所有评阅均分
  let subjEarned = 0, gradedCount = 0;
  for (const q of subjectiveQs) {
    const ans = db.prepare('SELECT * FROM exam_answers WHERE reg_id=? AND question_id=?').get(regId, q.id);
    const grades = ans ? db.prepare('SELECT * FROM answer_grades WHERE answer_id=?').all(ans.id) : [];
    if (grades.length) {
      const avg = grades.reduce((s, g) => s + g.score, 0) / grades.length;
      const score = Number((avg / 100 * perScore).toFixed(2));
      db.prepare('UPDATE exam_answers SET score=? WHERE id=?').run(score, ans.id);
      subjEarned += score;
      gradedCount++;
    }
  }

  const fully = gradedCount === subjectiveQs.length;
  const total = Number((objEarned + subjEarned).toFixed(2));
  db.prepare(`UPDATE exam_registrations SET objective_score=?, subjective_score=?, total_score=?,
    graded=?, status=? WHERE id=?`)
    .run(objEarned, subjectiveQs.length ? subjEarned : null, total, fully ? 1 : 0,
      fully ? 'graded' : 'submitted', regId);
  return { objective: objEarned, subjective: subjEarned, total, fully, subjectivePending: subjectiveQs.length - gradedCount };
}

// 合格后签发电子证书
function issueCertificateIfPassed(reg) {
  const exam = getExam(reg.exam_id);
  if (reg.total_score == null || reg.total_score < exam.pass_score) return null;
  const exists = db.prepare('SELECT id FROM certificates WHERE reg_id=?').get(reg.id);
  if (exists) return exists.id;
  const subject = db.prepare('SELECT * FROM subjects WHERE id=?').get(exam.subject_id);
  const person = db.prepare('SELECT name FROM people WHERE id=?').get(reg.person_id);
  const seq = String(db.prepare("SELECT COUNT(*) c FROM certificates").get().c + 1).padStart(4, '0');
  const certNo = `GAP-${subject.code.toUpperCase()}-${new Date().getFullYear()}-${seq}`;
  const issuedAt = now();
  const validUntil = subject.valid_months > 0 ? addMonths(issuedAt, subject.valid_months) : null;
  const info = db.prepare(`INSERT INTO certificates
    (person_id, subject_id, exam_id, reg_id, cert_no, score, issued_at, valid_until)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(reg.person_id, subject.id, exam.id, reg.id, certNo, reg.total_score, issuedAt, validUntil);
  notify({ person_id: reg.person_id, base_id: exam.base_id, type: 'cert_issued',
    title: `电子培训合格证已签发：${subject.name}`,
    body: validUntil ? `证书编号 ${certNo}，有效期至 ${new Date(validUntil).toLocaleDateString('zh-CN')}` : `证书编号 ${certNo}，长期有效`,
    ref_type: 'certificate', ref_id: info.lastInsertRowid });
  return info.lastInsertRowid;
}

// ---- 场次管理 ----
router.get('/', (req, res) => {
  const scope = baseScope(req);
  const where = [];
  const args = [];
  if (scope) { where.push('e.base_id=?'); args.push(scope); }
  const rows = db.prepare(`SELECT e.*, s.name AS subject_name FROM exams e
    JOIN subjects s ON s.id=e.subject_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY e.start_at DESC`).all(...args);
  res.json(rows);
});

router.post('/', requireRole('tech', 'base_admin', 'enterprise'), (req, res) => {
  const b = req.body || {};
  const baseId = req.user.base_id || Number(b.base_id);
  if (!baseId || !b.title || !b.subject_id || !b.start_at)
    return res.status(400).json({ error: '标题、科目、开考时间必填' });
  const examId = db.prepare(`INSERT INTO exams
    (base_id, title, subject_id, variety, chapter, start_at, duration_min, pass_score, max_retakes,
     paper_question_count, require_course_completion, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(baseId, b.title, Number(b.subject_id), b.variety || null, b.chapter || null,
      Number(b.start_at), Number(b.duration_min) || 45, Number(b.pass_score) || 60,
      (Number.isFinite(Number(b.max_retakes)) ? Number(b.max_retakes) : 1), Number(b.paper_question_count) || 10,
      b.require_course_completion === false ? 0 : 1, req.user.id, now()).lastInsertRowid;

  // 抽题组卷：按品种/章节/难度分层，随后交替拆分为 A/B 卷
  const exam = getExam(examId);
  const n = exam.paper_question_count;
  let pool = db.prepare('SELECT * FROM question_bank WHERE subject_id=?').all(exam.subject_id);
  if (exam.variety) pool = pool.filter(q => !q.variety || q.variety === exam.variety);
  if (exam.chapter) pool = pool.filter(q => !q.chapter || q.chapter === exam.chapter);
  const byDiff = [1, 2, 3].map(d => pool.filter(q => q.difficulty === d));
  const picked = [];
  const quotas = [Math.ceil(n * 0.5), Math.ceil(n * 0.35), n];
  for (let round = 0; round < 3; round++) {
    const need = quotas[round] - picked.length;
    for (let i = 0; i < need; i++) {
      const arr = byDiff[round];
      if (!arr.length) break;
      picked.push(arr.splice(Math.floor(Math.random() * arr.length), 1)[0]);
    }
  }
  // 题量不足时用同科目任意题补足
  if (picked.length < n) {
    const used = new Set(picked.map(q => q.id));
    for (const q of pool) if (!used.has(q.id) && picked.length < n) picked.push(q);
  }
  const listA = picked.filter((_, i) => i % 2 === 0).map(q => q.id);
  const listB = picked.filter((_, i) => i % 2 === 1).map(q => q.id);
  const insPaper = db.prepare('INSERT OR REPLACE INTO exam_papers (exam_id, version, question_ids) VALUES (?,?,?)');
  insPaper.run(examId, 'A', JSON.stringify(listA.length ? listA : picked.map(q => q.id)));
  insPaper.run(examId, 'B', JSON.stringify(listB.length ? listB : listA));
  audit(req.user, 'create', 'exam', examId, { title: b.title, questions: picked.length });
  res.json({ id: examId, paper_a: listA.length, paper_b: listB.length });
});

router.get('/:id', (req, res) => {
  const exam = getExam(req.params.id);
  if (!exam) return res.status(404).json({ error: '考核不存在' });
  if (req.user.role !== 'enterprise' && exam.base_id !== req.user.base_id)
    return res.status(403).json({ error: '无权查看' });
  const papers = db.prepare('SELECT * FROM exam_papers WHERE exam_id=?').all(exam.id)
    .map(p => ({ ...p, question_ids: JSON.parse(p.question_ids) }));
  const regs = db.prepare(`SELECT r.*, p.name AS person_name, c.name AS cooperative_name
    FROM exam_registrations r JOIN people p ON p.id=r.person_id
    LEFT JOIN cooperatives c ON c.id=p.cooperative_id
    WHERE r.exam_id=? ORDER BY r.attempt, p.name`).all(exam.id);
  res.json({ exam, papers, registrations: regs });
});

// ---- 报名 ----
router.post('/:id/register', (req, res) => {
  const exam = getExam(req.params.id);
  if (!exam) return res.status(404).json({ error: '考核不存在' });
  if (exam.start_at + exam.duration_min * 60000 < now())
    return res.status(409).json({ error: '该场次已结束，不能补报名' });
  const pid = req.user.role === 'farmer' ? req.user.person_id : Number(req.body?.person_id);
  if (!pid) return res.status(400).json({ error: '缺少报考人员' });
  const person = db.prepare('SELECT * FROM people WHERE id=?').get(pid);
  if (!person || (req.user.role !== 'enterprise' && person.base_id !== exam.base_id))
    return res.status(403).json({ error: '人员不属于本基地' });

  // 幂等：同一人同场次同次数
  const existing = db.prepare(`SELECT * FROM exam_registrations WHERE exam_id=? AND person_id=?
    ORDER BY attempt DESC LIMIT 1`).get(exam.id, pid);
  const attemptsUsed = existing ? (db.prepare('SELECT COUNT(*) c FROM exam_registrations WHERE exam_id=? AND person_id=?').get(exam.id, pid).c) : 0;
  const nextAttempt = attemptsUsed; // 0=首考
  if (existing && (existing.status === 'registered' || existing.status === 'in_progress'))
    return res.json({ ok: true, duplicated: true, reg_id: existing.id, attempt: existing.attempt });
  if (attemptsUsed > exam.max_retakes)
    return res.status(409).json({ error: '补考次数已用完' });
  // 学完课件才允许报考
  if (exam.require_course_completion) {
    const cc = coursesCompleted(pid, exam.subject_id);
    if (!cc.completed) {
      const titles = db.prepare(`SELECT title FROM courses WHERE id IN (${cc.missing.map(()=>'?').join(',')})`)
        .all(...cc.missing).map(r => r.title);
      return res.status(409).json({ error: '对应科目课件未学完，不能报考', missing_courses: titles });
    }
  }
  const version = attemptsUsed % 2 === 0 ? 'A' : 'B';
  const info = db.prepare(`INSERT INTO exam_registrations
    (exam_id, person_id, attempt, paper_version, status, client_event_id)
    VALUES (?,?,?,?,'registered',?)`)
    .run(exam.id, pid, nextAttempt, version, req.body?.client_event_id || null);
  audit(req.user, 'register', 'exam', exam.id, { person_id: pid, attempt: nextAttempt, paper: version });
  res.json({ ok: true, reg_id: info.lastInsertRowid, attempt: nextAttempt, paper_version: version });
});

// 开始/断线续考：返回试卷（不含答案）、已答内容与剩余秒数；超时自动交卷
router.post('/:id/start', (req, res) => {
  const exam = getExam(req.params.id);
  const pid = req.user.role === 'farmer' ? req.user.person_id : Number(req.body?.person_id);
  let reg = db.prepare('SELECT * FROM exam_registrations WHERE exam_id=? AND person_id=? ORDER BY attempt DESC LIMIT 1')
    .get(exam.id, pid);
  if (!reg) return res.status(404).json({ error: '尚未报名' });
  if (['submitted', 'graded'].includes(reg.status))
    return res.status(409).json({ error: '本场次已交卷', result: summary(reg.id) });

  if (!reg.started_at) {
    db.prepare("UPDATE exam_registrations SET status='in_progress', started_at=? WHERE id=?").run(now(), reg.id);
    reg = db.prepare('SELECT * FROM exam_registrations WHERE id=?').get(reg.id);
  }
  const deadline = reg.started_at + exam.duration_min * 60000;
  // 超时：自动交卷
  if (now() >= deadline && reg.status === 'in_progress') {
    autoSubmit(reg.id);
    return res.status(409).json({ error: '考试时间已到，系统已自动交卷', result: summary(reg.id) });
  }
  const paper = db.prepare('SELECT question_ids FROM exam_papers WHERE exam_id=? AND version=?')
    .get(exam.id, reg.paper_version);
  const qIds = JSON.parse(paper.question_ids);
  const questions = qIds.map(id => {
    const q = db.prepare('SELECT id, subject_id, type, stem, image_url, options, difficulty, chapter FROM question_bank WHERE id=?').get(id);
    return { ...q, options: q.options ? JSON.parse(q.options) : null };
  });
  const answers = db.prepare('SELECT question_id, answer FROM exam_answers WHERE reg_id=?').all(reg.id);
  res.json({
    reg_id: reg.id, attempt: reg.attempt, paper_version: reg.paper_version,
    deadline, remaining_ms: Math.max(0, deadline - now()),
    duration_min: exam.duration_min, exam: { id: exam.id, title: exam.title, pass_score: exam.pass_score },
    questions,
    saved_answers: Object.fromEntries(answers.map(a => [a.question_id, safeParse(a.answer)])),
  });
});

function safeParse(s) { try { return JSON.parse(s); } catch { return s; } }

// 答题（幂等 upsert，弱网重试安全；可单题或批量）
router.post('/answer', (req, res) => {
  const b = req.body || {};
  const regId = Number(b.reg_id);
  const reg = db.prepare('SELECT * FROM exam_registrations WHERE id=?').get(regId);
  if (!reg) return res.status(404).json({ error: '报考记录不存在' });
  if (!['in_progress'].includes(reg.status))
    return res.status(409).json({ error: '当前状态不能答题' });
  const exam = getExam(reg.exam_id);
  const deadline = reg.started_at + exam.duration_min * 60000;
  if (now() >= deadline) { autoSubmit(regId); return res.status(409).json({ error: '已超时自动交卷' }); }

  const items = Array.isArray(b.answers) ? b.answers : [[b.question_id, b.answer]];
  const upsert = db.prepare(`INSERT INTO exam_answers (reg_id, question_id, answer, updated_at)
    VALUES (?,?,?,?) ON CONFLICT(reg_id, question_id) DO UPDATE SET answer=excluded.answer, updated_at=excluded.updated_at`);
  db.transaction(() => items.forEach(([qid, ans]) => {
    if (qid == null) return;
    upsert.run(regId, Number(qid), JSON.stringify(ans ?? null), now());
  }))();
  res.json({ ok: true, saved: items.length, remaining_ms: Math.max(0, deadline - now()) });
});

function autoSubmit(regId) {
  const reg = db.prepare('SELECT * FROM exam_registrations WHERE id=?').get(regId);
  if (!reg || reg.status !== 'in_progress') return null;
  db.prepare("UPDATE exam_registrations SET status='submitted', submitted_at=?, auto_submitted=1 WHERE id=?")
    .run(now(), regId);
  const result = gradeRegistration(regId);
  const updated = db.prepare('SELECT * FROM exam_registrations WHERE id=?').get(regId);
  const exam = getExam(reg.exam_id);
  audit({ id: 0, name: '系统' }, 'auto_submit', 'exam_registration', regId, result);
  if (result.fully) finalize(updated, exam);
  notify({ person_id: reg.person_id, base_id: exam.base_id, type: 'exam_autosubmit',
    title: `超时自动交卷：${exam.title}`, body: '考试时间结束，系统已自动交卷。',
    ref_type: 'exam', ref_id: exam.id });
  return result;
}

// 交卷
router.post('/:id/submit', (req, res) => {
  const pid = req.user.role === 'farmer' ? req.user.person_id : Number(req.body?.person_id);
  const reg = db.prepare('SELECT * FROM exam_registrations WHERE exam_id=? AND person_id=? ORDER BY attempt DESC LIMIT 1')
    .get(req.params.id, pid);
  if (!reg) return res.status(404).json({ error: '报考记录不存在' });
  if (['submitted', 'graded'].includes(reg.status)) return res.json({ ok: true, duplicated: true, result: summary(reg.id) });
  const exam = getExam(reg.exam_id);
  const deadline = reg.started_at + exam.duration_min * 60000;
  const isAuto = now() >= deadline;
  db.prepare("UPDATE exam_registrations SET status='submitted', submitted_at=?, auto_submitted=? WHERE id=?")
    .run(now(), isAuto ? 1 : reg.auto_submitted, reg.id);
  const result = gradeRegistration(reg.id);
  const updated = db.prepare('SELECT * FROM exam_registrations WHERE id=?').get(reg.id);
  audit(req.user, 'submit', 'exam_registration', reg.id, { auto: isAuto, ...result });
  if (result.fully) finalize(updated, exam);
  res.json({ ok: true, result: summary(reg.id) });
});

// 出分后续：签发证书 / 不合格通知
function finalize(reg, exam) {
  const passed = reg.total_score >= exam.pass_score;
  if (passed) {
    issueCertificateIfPassed(reg);
  } else {
    notify({ person_id: reg.person_id, base_id: exam.base_id, type: 'exam_fail',
      title: `考核结果：${exam.title}`,
      body: `您的成绩为 ${reg.total_score} 分，未达及格线 ${exam.pass_score} 分，可在补考配额内参加补考。`,
      ref_type: 'exam', ref_id: exam.id });
  }
}

function summary(regId) {
  const reg = db.prepare('SELECT * FROM exam_registrations WHERE id=?').get(regId);
  const exam = getExam(reg.exam_id);
  return { reg_id: regId, status: reg.status, total_score: reg.total_score,
    objective_score: reg.objective_score, subjective_score: reg.subjective_score,
    pass_score: exam.pass_score, passed: reg.total_score != null && reg.total_score >= exam.pass_score,
    graded: !!reg.graded };
}

// 纸质卷成绩回录（管理员/技术员），直接出分并发证
router.post('/:id/paper-score', requireRole('tech', 'base_admin', 'enterprise'), (req, res) => {
  const exam = getExam(req.params.id);
  const { person_id, score } = req.body || {};
  const pid = Number(person_id);
  if (!pid || score == null) return res.status(400).json({ error: '人员与分数必填' });
  const existing = db.prepare('SELECT * FROM exam_registrations WHERE exam_id=? AND person_id=? ORDER BY attempt DESC LIMIT 1')
    .get(exam.id, pid);
  const attempt = existing ? existing.attempt + 1 : 0;
  const total = Number(Number(score).toFixed(2));
  let regId;
  if (existing && ['registered', 'in_progress'].includes(existing.status)) regId = existing.id;
  else {
    regId = db.prepare(`INSERT INTO exam_registrations
      (exam_id, person_id, attempt, paper_version, status, started_at, submitted_at, graded,
       objective_score, subjective_score, total_score)
      VALUES (?,?,?, 'A','graded', ?, ?, 1, NULL, ?, ?)`)
      .run(exam.id, pid, attempt, now(), now(), total, total).lastInsertRowid;
  }
  db.prepare(`UPDATE exam_registrations SET status='graded', started_at=COALESCE(started_at,?),
    submitted_at=?, graded=1, objective_score=NULL, subjective_score=?, total_score=? WHERE id=?`)
    .run(now(), now(), total, total, regId);
  const reg = db.prepare('SELECT * FROM exam_registrations WHERE id=?').get(regId);
  audit(req.user, 'paper_score_entry', 'exam_registration', regId, { person_id: pid, score: total });
  finalize(reg, exam);
  res.json({ ok: true, result: summary(regId) });
});

// 成绩异议申诉
router.post('/registration/:regId/appeal', (req, res) => {
  const reg = db.prepare('SELECT * FROM exam_registrations WHERE id=?').get(req.params.regId);
  if (!reg) return res.status(404).json({ error: '记录不存在' });
  if (req.user.role === 'farmer' && req.user.person_id !== reg.person_id)
    return res.status(403).json({ error: '只能对本人成绩申诉' });
  if (!req.body?.reason) return res.status(400).json({ error: '请填写申诉理由' });
  const info = db.prepare(`INSERT INTO appeals (reg_id, reason, created_at) VALUES (?,?,?)`)
    .run(reg.id, req.body.reason, now()).lastInsertRowid;
  audit(req.user, 'appeal_submit', 'appeal', info.lastInsertRowid, { reg_id: reg.id });
  res.json({ ok: true, id: info.lastInsertRowid });
});

// 我的考核记录
router.get('/my/records', (req, res) => {
  if (req.user.role !== 'farmer') return res.status(403).json({ error: '仅药农视角' });
  const rows = db.prepare(`SELECT r.*, e.title, e.pass_score AS exam_pass, s.name AS subject_name
    FROM exam_registrations r JOIN exams e ON e.id=r.exam_id
    JOIN subjects s ON s.id=e.subject_id WHERE r.person_id=? ORDER BY e.start_at DESC`)
    .all(req.user.person_id);
  const appeals = db.prepare('SELECT * FROM appeals WHERE reg_id IN (' +
    (rows.map(() => '?').join(',') || 'SELECT NULL') + ')').all(...rows.map(r => r.id));
  res.json(rows.map(r => ({ ...r, appeals: appeals.filter(a => a.reg_id === r.id) })));
});

module.exports = router;
module.exports.autoSubmit = autoSubmit;
module.exports.gradeRegistration = gradeRegistration;
module.exports.issueCertificateIfPassed = issueCertificateIfPassed;
