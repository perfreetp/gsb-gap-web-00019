import { route, json, HttpError } from '../index.js';
import { localNow, audit } from '../util.js';
import {
  generatePapers, getOrStartAttempt, submitAttempt, saveReview,
  finalizeGrading, sweepExpired, issueCertificate,
} from '../exam-core.js';

// 题库管理
route('GET', '/api/questions', (ctx) => {
  const { subject_id, type, difficulty } = ctx.query;
  const conds = []; const params = [];
  if (subject_id) { conds.push('subject_id=?'); params.push(subject_id); }
  if (type) { conds.push('type=?'); params.push(type); }
  if (difficulty) { conds.push('difficulty=?'); params.push(difficulty); }
  const rows = ctx.db.prepare(`SELECT q.*, s.name subject_name FROM question_bank q
    JOIN subjects s ON s.id=q.subject_id ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
    ORDER BY q.subject_id, q.difficulty`).all(...params);
  json(ctx.res, 200, { list: rows });
});

route('POST', '/api/questions', (ctx) => {
  if (!['enterprise', 'admin', 'tech'].includes(ctx.user.role)) throw new HttpError(403, '无权限');
  const b = ctx.body || {};
  if (!b.stem || !b.subject_id) throw new HttpError(400, '题干和所属科目必填');
  const id = ctx.db.prepare(`INSERT INTO question_bank(subject_id, variety, chapter, difficulty, type, stem, options, answer, score)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(b.subject_id, b.variety || null, b.chapter || null,
      b.difficulty || 1, b.type || 'single', b.stem,
      b.options ? JSON.stringify(b.options) : null, b.answer || null, b.score || 0).lastInsertRowid;
  ctx.audit('新增题目', 'question', id, { subject_id: b.subject_id });
  json(ctx.res, 200, { id });
});

// 考试列表
route('GET', '/api/exams', (ctx) => {
  const rows = ctx.db.prepare(`SELECT e.*, s.name subject_name,
      (SELECT COUNT(*) FROM exam_attempts a WHERE a.exam_id=e.id AND a.passed=1) passed_count,
      (SELECT COUNT(*) FROM exam_attempts a WHERE a.exam_id=e.id) attempt_count
    FROM exams e JOIN subjects s ON s.id=e.subject_id
    ${ctx.user.role === 'enterprise' ? '' : 'WHERE e.base_id=?'}
    ORDER BY e.start_time DESC`).all(...(ctx.user.role === 'enterprise' ? [] : [ctx.user.base_id]));
  json(ctx.res, 200, { list: rows });
});

route('POST', '/api/exams', (ctx) => {
  if (!['admin', 'tech'].includes(ctx.user.role)) throw new HttpError(403, '仅基地管理员/技术员可组织考试');
  const b = ctx.body || {};
  for (const k of ['title', 'subject_id', 'start_time', 'duration_min', 'pass_score']) if (b[k] == null) throw new HttpError(400, k + ' 必填');
  const id = ctx.db.prepare(`INSERT INTO exams(base_id, subject_id, variety, title, start_time, duration_min,
      pass_score, max_retakes, blueprint, created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(ctx.user.base_id, b.subject_id, b.variety || null, b.title, b.start_time,
      b.duration_min, b.pass_score, b.max_retakes ?? 1, JSON.stringify(b.blueprint || []), ctx.user.id).lastInsertRowid;
  const exam = ctx.db.prepare('SELECT * FROM exams WHERE id=?').get(id);
  generatePapers(exam);
  ctx.audit('创建考试并生成A/B卷', 'exam', id, b);
  json(ctx.res, 200, { id });
});

// 预览 A/B 卷（不含答案）
route('GET', '/api/exams/:id/papers', (ctx) => {
  const exam = ctx.db.prepare('SELECT * FROM exams WHERE id=?').get(ctx.params.id);
  if (!exam) throw new HttpError(404, '考试不存在');
  const papers = generatePapers(exam);
  const out = papers.map(p => ({
    id: p.id, version: p.version, total_score: p.total_score,
    questions: JSON.parse(p.questions).map(item => {
      const q = ctx.db.prepare('SELECT id, type, stem, options, score FROM question_bank WHERE id=?').get(item.qid);
      return { ...q, options: q.options ? JSON.parse(q.options) : null, paper_score: item.score };
    }),
  }));
  json(ctx.res, 200, { papers: out });
});

// 考生可见的考试 + 本人资格
route('GET', '/api/exams/my', (ctx) => {
  if (ctx.user.role !== 'farmer') throw new HttpError(403, '仅药农视角');
  const wid = ctx.user.worker_id;
  const exams = ctx.db.prepare(`SELECT e.*, s.name subject_name FROM exams e
    JOIN subjects s ON s.id=e.subject_id WHERE e.base_id=? ORDER BY e.start_time DESC`)
    .all(ctx.user.base_id);
  const out = exams.map(e => {
    const courses = ctx.db.prepare('SELECT id FROM courses WHERE subject_id=?').all(e.subject_id);
    const done = ctx.db.prepare('SELECT COUNT(*) c FROM course_progress cp JOIN courses c ON c.id=cp.course_id WHERE c.subject_id=? AND cp.worker_id=? AND cp.completed=1').get(e.subject_id, wid).c;
    const attempts = ctx.db.prepare('SELECT * FROM exam_attempts WHERE exam_id=? AND worker_id=? ORDER BY attempt_no').all(e.id, wid);
    return { ...e, eligible: courses.length === done, course_done: done, course_total: courses.length, attempts };
  });
  json(ctx.res, 200, { list: out });
});

// 开考 / 断线续考
route('POST', '/api/exams/:id/start', (ctx) => {
  const exam = ctx.db.prepare('SELECT * FROM exams WHERE id=?').get(ctx.params.id);
  if (!exam) throw new HttpError(404, '考试不存在');
  if (ctx.user.role === 'farmer' && exam.base_id !== ctx.user.base_id) throw new HttpError(403, '越权');
  if (exam.status === 'finished') throw new HttpError(400, '该场考试已结束');
  const wid = ctx.user.role === 'farmer' ? ctx.user.worker_id : ctx.body.worker_id;
  const r = getOrStartAttempt(exam, wid, { clientNonce: ctx.body.client_nonce || null });
  if (r.error) throw new HttpError(400, r.error);
  const paper = ctx.db.prepare('SELECT * FROM exam_papers WHERE id=?').get(r.attempt.paper_id);
  const questions = JSON.parse(paper.questions).map(item => {
    const q = ctx.db.prepare('SELECT id, type, stem, options FROM question_bank WHERE id=?').get(item.qid);
    return { ...q, options: q.options ? JSON.parse(q.options) : null, paper_score: item.score };
  });
  const saved = ctx.db.prepare('SELECT qid, answer FROM attempt_answers WHERE attempt_id=?').all(r.attempt.id);
  audit(ctx.user, r.resumed ? '断线续考恢复' : '开考', 'exam_attempt', r.attempt.id, {});
  json(ctx.res, 200, {
    attempt: { id: r.attempt.id, attempt_no: r.attempt.attempt_no, status: r.attempt.status,
      started_at: r.attempt.started_at, deadline_at: r.attempt.deadline_at, version: paper.version },
    resumed: r.resumed, questions, saved: Object.fromEntries(saved.map(s => [s.qid, s.answer])),
  });
});

// 保存单题答案（幂等：同 attempt+qid 覆盖；带 nonce）
route('POST', '/api/attempts/:id/answer', (ctx) => {
  const a = ctx.db.prepare('SELECT * FROM exam_attempts WHERE id=?').get(ctx.params.id);
  if (!a) throw new HttpError(404, '答题记录不存在');
  if (a.status !== 'ongoing') throw new HttpError(400, '本场考试已交卷');
  const { qid, answer, client_nonce } = ctx.body || {};
  ctx.db.prepare(`INSERT INTO attempt_answers(attempt_id, qid, answer) VALUES(?,?,?)
    ON CONFLICT(attempt_id, qid) DO UPDATE SET answer=excluded.answer, updated_at=datetime('now','localtime')`)
    .run(a.id, qid, answer ?? '');
  json(ctx.res, 200, { ok: true });
});

// 交卷
route('POST', '/api/attempts/:id/submit', (ctx) => {
  const a = ctx.db.prepare('SELECT * FROM exam_attempts WHERE id=?').get(ctx.params.id);
  if (!a) throw new HttpError(404, '答题记录不存在');
  if (ctx.user.role === 'farmer' && a.worker_id !== ctx.user.worker_id) throw new HttpError(403, '越权');
  const r = submitAttempt(a, ctx.user);
  audit(ctx.user, '交卷', 'exam_attempt', a.id, { force: !!ctx.body.force });
  json(ctx.res, 200, { attempt: r.attempt });
});

// 我的成绩与证书
route('GET', '/api/attempts/my', (ctx) => {
  if (ctx.user.role !== 'farmer') throw new HttpError(403, '仅药农视角');
  const rows = ctx.db.prepare(`SELECT a.*, e.title exam_title, p.version, s.name subject_name
    FROM exam_attempts a JOIN exams e ON e.id=a.exam_id
    JOIN exam_papers p ON p.id=a.paper_id JOIN subjects s ON s.id=e.subject_id
    WHERE a.worker_id=? ORDER BY a.id DESC`).all(ctx.user.worker_id);
  json(ctx.res, 200, { list: rows });
});

// 待评阅列表（识图/简答）
route('GET', '/api/exams/review/pending', (ctx) => {
  if (!['admin', 'tech', 'enterprise'].includes(ctx.user.role)) throw new HttpError(403, '无权限');
  const rows = ctx.db.prepare(`SELECT a.id attempt_id, a.status, w.name worker_name, e.title, p.version,
      a.objective_score, a.attempt_no
    FROM exam_attempts a JOIN workers w ON w.id=a.worker_id
    JOIN exams e ON e.id=a.exam_id JOIN exam_papers p ON p.id=a.paper_id
    WHERE a.status='submitted' ${ctx.user.role === 'enterprise' ? '' : 'AND e.base_id=?'}
    ORDER BY a.id`).all(...(ctx.user.role === 'enterprise' ? [] : [ctx.user.base_id]));
  json(ctx.res, 200, { list: rows });
});

route('GET', '/api/attempts/:id', (ctx) => {
  const a = ctx.db.prepare(`SELECT a.*, e.title exam_title, e.pass_score, e.base_id, w.name worker_name, p.version
    FROM exam_attempts a JOIN exams e ON e.id=a.exam_id JOIN workers w ON w.id=a.worker_id
    JOIN exam_papers p ON p.id=a.paper_id WHERE a.id=?`).get(ctx.params.id);
  if (!a) throw new HttpError(404, '记录不存在');
  if (ctx.user.role === 'farmer' && a.worker_id !== ctx.user.worker_id) throw new HttpError(403, '越权');
  if (['admin', 'tech'].includes(ctx.user.role) && a.base_id !== ctx.user.base_id) throw new HttpError(403, '越权');
  const paper = ctx.db.prepare('SELECT * FROM exam_papers WHERE id=?').get(a.paper_id);
  const questions = JSON.parse(paper.questions).map(item => {
    const q = ctx.db.prepare('SELECT * FROM question_bank WHERE id=?').get(item.qid);
    const ans = ctx.db.prepare('SELECT * FROM attempt_answers WHERE attempt_id=? AND qid=?').get(a.id, item.qid);
    return { ...q, options: q.options ? JSON.parse(q.options) : null, paper_score: item.score, answer_sheet: ans || null };
  });
  json(ctx.res, 200, { attempt: a, questions });
});

// 技术员评阅（双评取平均：不同评审员第二次评分时自动平均）
route('POST', '/api/attempts/:id/review', (ctx) => {
  if (!['admin', 'tech'].includes(ctx.user.role)) throw new HttpError(403, '仅技术员可评阅');
  const a = ctx.db.prepare(`SELECT e.base_id FROM exam_attempts a JOIN exams e ON e.id=a.exam_id WHERE a.id=?`).get(ctx.params.id);
  if (a.base_id !== ctx.user.base_id) throw new HttpError(403, '越权');
  const { qid, score } = ctx.body || {};
  const res = saveReview(Number(ctx.params.id), qid, score, ctx.user);
  json(ctx.res, 200, { ok: true, answer: res });
});

// 纸质卷成绩回录
route('POST', '/api/exams/:id/paper-score', (ctx) => {
  if (!['admin', 'tech'].includes(ctx.user.role)) throw new HttpError(403, '无权限');
  const exam = ctx.db.prepare('SELECT * FROM exams WHERE id=?').get(ctx.params.id);
  if (!exam || exam.base_id !== ctx.user.base_id) throw new HttpError(404, '考试不存在');
  const { worker_id, total_score, paper_version = 'A' } = ctx.body || {};
  const paper = ctx.db.prepare('SELECT * FROM exam_papers WHERE exam_id=? AND version=?').get(exam.id, paper_version)
    || generatePapers(exam)[0];
  const no = (ctx.db.prepare('SELECT MAX(attempt_no) m FROM exam_attempts WHERE exam_id=? AND worker_id=?').get(exam.id, worker_id).m || 0) + 1;
  const total = Number(total_score);
  const passed = total >= exam.pass_score ? 1 : 0;
  const r = ctx.db.prepare(`INSERT INTO exam_attempts(exam_id, paper_id, worker_id, attempt_no, status,
      started_at, submitted_at, total_score, objective_score, subjective_score, passed, source)
      VALUES(?,?,?,?,'graded', ?, ?, ?, ?, ?, ?, 'paper')`)
    .run(exam.id, paper.id, worker_id, no, localNow(), localNow(), total, 0, total, passed).lastInsertRowid;
  if (passed) {
    const w = ctx.db.prepare('SELECT * FROM workers WHERE id=?').get(worker_id);
    issueCertificate(exam, ctx.db.prepare('SELECT * FROM exam_attempts WHERE id=?').get(r), total, w);
  }
  ctx.audit('纸质卷成绩回录', 'exam_attempt', r, { worker_id, total_score });
  json(ctx.res, 200, { id: r, passed: !!passed });
});

// 申诉
route('POST', '/api/attempts/:id/appeal', (ctx) => {
  const a = ctx.db.prepare('SELECT * FROM exam_attempts WHERE id=?').get(ctx.params.id);
  if (!a) throw new HttpError(404, '记录不存在');
  if (ctx.user.role === 'farmer' && a.worker_id !== ctx.user.worker_id) throw new HttpError(403, '越权');
  const id = ctx.db.prepare('INSERT INTO appeals(attempt_id, worker_id, reason) VALUES(?,?,?)')
    .run(a.id, a.worker_id, ctx.body.reason).lastInsertRowid;
  ctx.audit('成绩申诉提交', 'appeal', id, { attempt_id: a.id });
  json(ctx.res, 200, { id });
});

route('GET', '/api/appeals', (ctx) => {
  const rows = ctx.db.prepare(`SELECT ap.*, w.name worker_name, e.title exam_title
    FROM appeals ap JOIN workers w ON w.id=ap.worker_id
    JOIN exam_attempts a ON a.id=ap.attempt_id JOIN exams e ON e.id=a.exam_id
    ${ctx.user.role === 'enterprise' ? '' : 'WHERE e.base_id=?'} ORDER BY ap.id DESC`)
    .all(...(ctx.user.role === 'enterprise' ? [] : [ctx.user.base_id]));
  json(ctx.res, 200, { list: rows });
});

route('POST', '/api/appeals/:id/handle', (ctx) => {
  if (!['admin', 'tech'].includes(ctx.user.role)) throw new HttpError(403, '仅技术员可复核');
  const ap = ctx.db.prepare(`SELECT ap.*, e.base_id FROM appeals ap JOIN exam_attempts a ON a.id=ap.attempt_id
    JOIN exams e ON e.id=a.exam_id WHERE ap.id=?`).get(ctx.params.id);
  if (!ap || ap.base_id !== ctx.user.base_id) throw new HttpError(404, '申诉不存在');
  const { status, reply, adjust_score } = ctx.body || {};
  ctx.db.prepare(`UPDATE appeals SET status=?, reply=?, reviewer_id=?, handled_at=? WHERE id=?`)
    .run(status, reply || null, ctx.user.id, localNow(), ap.id);
  let detail = { status, reply };
  if (status === 'approved' && adjust_score != null) {
    const a = ctx.db.prepare('SELECT * FROM exam_attempts WHERE id=?').get(ap.attempt_id);
    const exam = ctx.db.prepare('SELECT * FROM exams WHERE id=?').get(a.exam_id);
    const passed = adjust_score >= exam.pass_score ? 1 : 0;
    ctx.db.prepare('UPDATE exam_attempts SET total_score=?, passed=? WHERE id=?').run(adjust_score, passed, a.id);
    detail.adjust_score = adjust_score;
    if (passed) {
      const w = ctx.db.prepare('SELECT * FROM workers WHERE id=?').get(a.worker_id);
      issueCertificate(exam, { ...a, total_score: adjust_score }, adjust_score, w);
    }
  }
  ctx.audit('申诉复核留痕', 'appeal', ap.id, detail);
  json(ctx.res, 200, { ok: true });
});

// 手动触发超时扫描（也可由定时器完成）
route('POST', '/api/exams/sweep', (ctx) => {
  const n = sweepExpired();
  json(ctx.res, 200, { auto_submitted: n });
});

// 某场考试的全部成绩（管理端）
route('GET', '/api/exams/:id/attempts', (ctx) => {
  const exam = ctx.db.prepare('SELECT * FROM exams WHERE id=?').get(ctx.params.id);
  if (!exam) throw new HttpError(404, '考试不存在');
  if (ctx.user.role !== 'enterprise' && exam.base_id !== ctx.user.base_id) throw new HttpError(403, '越权');
  const rows = ctx.db.prepare(`SELECT a.*, w.name worker_name, p.version,
      (SELECT status FROM appeals ap WHERE ap.attempt_id=a.id ORDER BY ap.id DESC LIMIT 1) appeal_status
    FROM exam_attempts a JOIN workers w ON w.id=a.worker_id
    JOIN exam_papers p ON p.id=a.paper_id WHERE a.exam_id=?
    ORDER BY a.attempt_no, w.id`).all(Number(ctx.params.id));
  json(ctx.res, 200, { exam, list: rows });
});
