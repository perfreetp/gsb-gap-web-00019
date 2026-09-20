import { db } from './db.js';
import { audit, notify, localNow, addMonths, certNo } from './util.js';

function shuffle(arr, seedSalt = '') {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 按品种 / 章节 / 难度 / 题型抽题组卷
 * blueprint: [{type, count, score}]
 */
export function composePaper(exam, versionSeed) {
  const bp = JSON.parse(exam.blueprint || '[]');
  const picked = [];
  for (const rule of bp) {
    const conds = ['subject_id = ?'];
    const params = [exam.subject_id];
    if (rule.type) { conds.push('type = ?'); params.push(rule.type); }
    if (rule.difficulty) { conds.push('difficulty = ?'); params.push(rule.difficulty); }
    if (rule.chapter) { conds.push('chapter = ?'); params.push(rule.chapter); }
    let pool = db.prepare(`SELECT * FROM question_bank WHERE ${conds.join(' AND ')}`).all(...params);
    pool = shuffle(pool, versionSeed);
    for (const q of pool.slice(0, rule.count)) {
      picked.push({ qid: q.id, type: q.type, score: rule.score ?? q.score });
    }
  }
  const total = picked.reduce((s, q) => s + q.score, 0);
  return { questions: picked, total_score: total };
}

export function generatePapers(exam) {
  const existing = db.prepare('SELECT version FROM exam_papers WHERE exam_id=?').all(exam.id).map(r => r.version);
  const out = [];
  for (const version of ['A', 'B']) {
    if (existing.includes(version)) { out.push(db.prepare('SELECT * FROM exam_papers WHERE exam_id=? AND version=?').get(exam.id, version)); continue; }
    const paper = composePaper(exam, version);
    const r = db.prepare('INSERT INTO exam_papers(exam_id, version, questions, total_score) VALUES(?,?,?,?)')
      .run(exam.id, version, JSON.stringify(paper.questions), paper.total_score);
    out.push(db.prepare('SELECT * FROM exam_papers WHERE id=?').get(r.lastInsertRowid));
  }
  return out;
}

function subjectCompleted(workerId, subjectId) {
  const courses = db.prepare('SELECT id, duration_sec FROM courses WHERE subject_id=?').all(subjectId);
  if (!courses.length) return { ok: true, missing: [] };
  const missing = [];
  for (const c of courses) {
    const p = db.prepare('SELECT * FROM course_progress WHERE worker_id=? AND course_id=?').get(workerId, c.id);
    if (!p || !p.completed) missing.push(c.id);
  }
  return { ok: missing.length === 0, missing };
}

export function getOrStartAttempt(exam, workerId, { clientNonce = null, source = 'online' } = {}) {
  // 超时自动交卷检查
  sweepExpired(exam);

  if (new Date(exam.start_time.replace(' ', 'T')).getTime() > Date.now())
    return { error: '考试尚未开始' };

  const study = subjectCompleted(workerId, exam.subject_id);
  if (!study.ok) return { error: '对应科目课件未全部学完，不能报考', code: 'STUDY_REQUIRED', missing: study.missing };

  const existing = db.prepare(`SELECT * FROM exam_attempts WHERE exam_id=? AND worker_id=?
                               AND status='ongoing' ORDER BY attempt_no DESC LIMIT 1`).get(exam.id, workerId);
  if (existing) return { attempt: existing, resumed: true };

  const last = db.prepare('SELECT MAX(attempt_no) m FROM exam_attempts WHERE exam_id=? AND worker_id=?').get(exam.id, workerId).m || 0;
  if (last >= exam.max_retakes + 1) return { error: `补考次数已用完（最多 ${exam.max_retakes} 次补考）` };

  const versions = generatePapers(exam);
  // 同一考生按次分配 A/B 卷
  const version = last % 2 === 0 ? 'A' : 'B';
  const paper = versions.find(v => v.version === version);

  const start = new Date();
  const deadline = new Date(start.getTime() + exam.duration_min * 60000);
  try {
    const r = db.prepare(`INSERT INTO exam_attempts(exam_id, paper_id, worker_id, attempt_no, status,
        started_at, deadline_at, source, client_nonce) VALUES(?,?,?,?, 'ongoing',?,?,?,?)`)
      .run(exam.id, paper.id, workerId, last + 1, localNow(start), localNow(deadline), source, clientNonce);
    return { attempt: db.prepare('SELECT * FROM exam_attempts WHERE id=?').get(r.lastInsertRowid), resumed: false };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return { error: '重复的开考请求，已忽略' };
    throw e;
  }
}

function gradeObjective(attempt, exam) {
  const paper = db.prepare('SELECT * FROM exam_papers WHERE id=?').get(attempt.paper_id);
  const qs = JSON.parse(paper.questions);
  let objective = 0;
  for (const item of qs) {
    const q = db.prepare('SELECT * FROM question_bank WHERE id=?').get(item.qid);
    if (!['single', 'multi', 'judge'].includes(q.type)) continue;
    const ans = db.prepare('SELECT * FROM attempt_answers WHERE attempt_id=? AND qid=?').get(attempt.id, q.id);
    const given = (ans?.answer || '').trim().toUpperCase().replace(/[\s,，、]+/g, ',').replace(/^,+|,+$/g, '');
    const right = (q.answer || '').trim().toUpperCase().replace(/[\s,，、]+/g, ',').replace(/^,+|,+$/g, '');
    const ok = q.type === 'multi'
      ? given.split(',').slice().sort().join(',') === right.split(',').slice().sort().join(',')
      : given === right;
    const score = ok ? item.score : 0;
    objective += score;
    db.prepare('UPDATE attempt_answers SET score=? WHERE id=?').run(score, ans?.id ?? ensureAnswer(attempt.id, q.id).id);
  }
  return objective;
}

function ensureAnswer(attemptId, qid) {
  db.prepare('INSERT OR IGNORE INTO attempt_answers(attempt_id, qid) VALUES(?,?)').run(attemptId, qid);
  return db.prepare('SELECT * FROM attempt_answers WHERE attempt_id=? AND qid=?').get(attemptId, qid);
}

function hasSubjective(attempt) {
  const paper = db.prepare('SELECT * FROM exam_papers WHERE id=?').get(attempt.paper_id);
  const qs = JSON.parse(paper.questions);
  return qs.some(item => {
    const q = db.prepare('SELECT type FROM question_bank WHERE id=?').get(item.qid);
    return ['image', 'short'].includes(q.type);
  });
}

export function submitAttempt(attempt, actor, { force = false } = {}) {
  if (attempt.status !== 'ongoing') return { attempt };
  const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(attempt.exam_id);
  const deadline = new Date(attempt.deadline_at.replace(' ', 'T')).getTime();
  if (!force && Date.now() > deadline) { /* 超时自动交卷 */ }

  const objective = gradeObjective(attempt, exam);
  const subjective = hasSubjective(attempt);
  db.prepare(`UPDATE exam_attempts SET status=?, submitted_at=?, objective_score=? WHERE id=?`)
    .run(subjective ? 'submitted' : 'graded', localNow(), objective, attempt.id);

  let result;
  if (!subjective) result = finalizeGrading(attempt.id, actor, { auto: true });
  else audit(actor, '提交试卷(待评阅)', 'exam_attempt', attempt.id, { objective });
  return { attempt: db.prepare('SELECT * FROM exam_attempts WHERE id=?').get(attempt.id) };
}

/** 双评取平均：review_round 1/2，两评完成后平均 */
export function saveReview(attemptId, qid, score, reviewer) {
  const attempt = db.prepare('SELECT * FROM exam_attempts WHERE id=?').get(attemptId);
  let ans = db.prepare('SELECT * FROM attempt_answers WHERE attempt_id=? AND qid=?').get(attemptId, qid);
  if (!ans) {
    db.prepare('INSERT INTO attempt_answers(attempt_id, qid) VALUES(?,?)').run(attemptId, qid);
    ans = db.prepare('SELECT * FROM attempt_answers WHERE attempt_id=? AND qid=?').get(attemptId, qid);
  }
  const paper = db.prepare('SELECT * FROM exam_papers WHERE id=?').get(attempt.paper_id);
  const item = JSON.parse(paper.questions).find(x => x.qid === qid);
  const maxScore = item?.score ?? 0;
  score = Math.max(0, Math.min(maxScore, Number(score) || 0));

  const round = (ans.reviewer_id && ans.reviewer_id !== reviewer.id) ? 2 : 1;
  if (round === 1) {
    db.prepare('UPDATE attempt_answers SET score=?, reviewer_id=?, review_round=1, updated_at=? WHERE id=?')
      .run(score, reviewer.id, localNow(), ans.id);
  } else {
    // 双评取平均
    const first = ans.score;
    const avg = Math.round(((first + score) / 2) * 10) / 10;
    db.prepare(`UPDATE attempt_answers SET score=?, review_round=2, updated_at=? WHERE id=?`)
      .run(avg, localNow(), ans.id);
    audit(reviewer, '主观题二次评阅(双评取平均)', 'attempt_answer', ans.id, { first, second: score, avg });
  }
  audit(reviewer, round === 1 ? '主观题评阅' : '主观题评阅(第二评)', 'attempt_answer', ans.id, { qid, score });

  // 全部主观题至少一评后出成绩
  const allReviewed = JSON.parse(paper.questions)
    .filter(x => ['image', 'short'].includes(db.prepare('SELECT type FROM question_bank WHERE id=?').get(x.qid).type))
    .every(x => {
      const a = db.prepare('SELECT * FROM attempt_answers WHERE attempt_id=? AND qid=?').get(attemptId, x.qid);
      return a && a.reviewer_id != null;
    });
  if (allReviewed && attempt.status === 'submitted') finalizeGrading(attemptId, reviewer, { auto: false });
  return db.prepare('SELECT * FROM attempt_answers WHERE id=?').get(ans.id);
}

export function finalizeGrading(attemptId, actor, { auto = false } = {}) {
  const attempt = db.prepare('SELECT * FROM exam_attempts WHERE id=?').get(attemptId);
  const paper = db.prepare('SELECT * FROM exam_papers WHERE id=?').get(attempt.paper_id);
  const qs = JSON.parse(paper.questions);
  let subj = 0;
  for (const item of qs) {
    const q = db.prepare('SELECT type FROM question_bank WHERE id=?').get(item.qid);
    if (['image', 'short'].includes(q.type)) {
      const a = db.prepare('SELECT score FROM attempt_answers WHERE attempt_id=? AND qid=?').get(attemptId, item.qid);
      subj += a?.score ?? 0;
    }
  }
  const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(attempt.exam_id);
  const total = Math.round((attempt.objective_score + subj) * 10) / 10;
  const passed = total >= exam.pass_score ? 1 : 0;
  db.prepare(`UPDATE exam_attempts SET status='graded', subjective_score=?, total_score=?, passed=? WHERE id=?`)
    .run(subj, total, passed, attemptId);
  audit(actor, auto ? '系统自动判分出成绩' : '评阅完成出成绩', 'exam_attempt', attemptId, { total, passed });

  const worker = db.prepare('SELECT * FROM workers WHERE id=?').get(attempt.worker_id);
  if (passed) issueCertificate(exam, attempt, total, worker);
  notify({
    worker_id: attempt.worker_id,
    title: passed ? '考核合格，证书已生成' : '考核未通过，请准备补考',
    body: `《${exam.title}》得分 ${total}，及格线 ${exam.pass_score}`,
    type: 'exam_result', ref_id: attemptId,
  });
  return db.prepare('SELECT * FROM exam_attempts WHERE id=?').get(attemptId);
}

export function issueCertificate(exam, attempt, score, worker) {
  const subject = db.prepare('SELECT * FROM subjects WHERE id=?').get(exam.subject_id);
  const issuedAt = localNow();
  const expireAt = subject.valid_months ? addMonths(issuedAt, subject.valid_months) : null;
  // 同科目已发证则更新为最新一次
  const old = db.prepare('SELECT id FROM certificates WHERE worker_id=? AND subject_id=?').get(worker.id, subject.id);
  if (old) {
    db.prepare('UPDATE certificates SET attempt_id=?, score=?, issued_at=?, expire_at=?, status=? WHERE id=?')
      .run(attempt.id, score, issuedAt, expireAt, 'valid', old.id);
    return old.id;
  }
  const no = certNo(subject.code, attempt.id);
  const r = db.prepare(`INSERT INTO certificates(cert_no, worker_id, subject_id, attempt_id, score, issued_at, expire_at, status)
                        VALUES(?,?,?,?,?,?,?, 'valid')`)
    .run(no, worker.id, subject.id, attempt.id, score, issuedAt, expireAt);
  return r.lastInsertRowid;
}

/** 断线续考 / 超时自动交卷 */
export function sweepExpired(examLike = null) {
  const rows = examLike
    ? db.prepare(`SELECT * FROM exam_attempts WHERE status='ongoing' AND exam_id=?
                  AND deadline_at < datetime('now','localtime')`).all(examLike.id)
    : db.prepare(`SELECT * FROM exam_attempts WHERE status='ongoing' AND deadline_at < datetime('now','localtime')`).all();
  for (const a of rows) {
    submitAttempt(a, { real_name: '系统' }, { force: true });
    const ex = db.prepare('SELECT id FROM exams WHERE id=?').get(a.exam_id);
    audit({ real_name: '系统' }, '超时自动交卷', 'exam_attempt', a.id, {});
  }
  return rows.length;
}
