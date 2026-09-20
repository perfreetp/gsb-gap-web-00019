import { route, json, HttpError } from '../index.js';

route('GET', '/api/courses', (ctx) => {
  const { subject_id } = ctx.query;
  const rows = ctx.db.prepare(`SELECT c.*, s.name subject_name, s.code subject_code
    FROM courses c JOIN subjects s ON s.id=c.subject_id
    ${subject_id ? 'WHERE c.subject_id=?' : ''} ORDER BY c.id`).all(...(subject_id ? [subject_id] : []));
  let wid = null;
  if (ctx.user.role === 'farmer') wid = ctx.user.worker_id;
  else if (ctx.query.worker_id) wid = ctx.query.worker_id;
  const list = rows.map(c => {
    const chapters = JSON.parse(c.chapters || '[]');
    let progress = null;
    if (wid) progress = ctx.db.prepare('SELECT * FROM course_progress WHERE course_id=? AND worker_id=?').get(c.id, wid);
    return {
      ...c,
      chapters,
      progress: progress ? {
        watched_sec: progress.watched_sec,
        completed: !!progress.completed,
        finished_chapters: JSON.parse(progress.finished_chapters || '[]'),
      } : { watched_sec: 0, completed: false, finished_chapters: [] },
    };
  });
  json(ctx.res, 200, { list });
});

route('GET', '/api/courses/:id', (ctx) => {
  const c = ctx.db.prepare(`SELECT c.*, s.name subject_name FROM courses c JOIN subjects s ON s.id=c.subject_id WHERE c.id=?`).get(ctx.params.id);
  if (!c) throw new HttpError(404, '课件不存在');
  c.chapters = JSON.parse(c.chapters || '[]');
  let progress = null;
  const wid = ctx.user.role === 'farmer' ? ctx.user.worker_id : ctx.query.worker_id;
  if (wid) progress = ctx.db.prepare('SELECT * FROM course_progress WHERE course_id=? AND worker_id=?').get(c.id, wid);
  json(ctx.res, 200, {
    course: c,
    progress: progress ? { ...progress, finished_chapters: JSON.parse(progress.finished_chapters || '[]') } : null,
  });
});

function upsertProgress(db, courseId, workerId, watchedSec, finishedChapters) {
  db.prepare(`INSERT INTO course_progress(worker_id, course_id, watched_sec, finished_chapters, completed, updated_at)
              VALUES(?,?,?, '[]', 0, datetime('now','localtime'))
              ON CONFLICT(worker_id, course_id) DO NOTHING`).run(workerId, courseId);
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(courseId);
  const cur = db.prepare('SELECT * FROM course_progress WHERE worker_id=? AND course_id=?').get(workerId, courseId);
  const newWatched = Math.max(cur.watched_sec, Math.min(course.duration_sec || 999999, watchedSec ?? cur.watched_sec));
  const chapSet = new Set([...JSON.parse(cur.finished_chapters || '[]'), ...finishedChapters]);
  const chapters = JSON.parse(course.chapters || '[]');
  const allDone = chapters.length > 0 && chapters.every(ch => chapSet.has(ch.no));
  const timeOk = !course.duration_sec || newWatched >= course.duration_sec * 0.9;
  const completed = allDone && timeOk ? 1 : 0;
  db.prepare(`UPDATE course_progress SET watched_sec=?, finished_chapters=?, completed=?, updated_at=datetime('now','localtime')
              WHERE worker_id=? AND course_id=?`)
    .run(newWatched, JSON.stringify([...chapSet].sort()), completed, workerId, courseId);
  return { watched_sec: newWatched, completed: !!completed };
}

// 上报观看进度（心跳），支持断网后补传最新值
route('POST', '/api/courses/:id/progress', (ctx) => {
  if (!['farmer', 'admin', 'tech', 'enterprise'].includes(ctx.user.role)) throw new HttpError(403, '无权限');
  let workerId = ctx.user.role === 'farmer' ? ctx.user.worker_id : (ctx.body.worker_id || null);
  if (!workerId) throw new HttpError(400, '缺少人员');
  const b = ctx.body || {};
  const res = upsertProgress(ctx.db, Number(ctx.params.id), workerId,
    Number(b.watched_sec || 0), (b.finished_chapters || []).map(Number));
  json(ctx.res, 200, res);
});

// 逐人完成度（管理员视角）
route('GET', '/api/courses/subject/:subjectId/status', (ctx) => {
  const rows = ctx.db.prepare(`SELECT w.id worker_id, w.name,
      (SELECT COUNT(*) FROM courses c WHERE c.subject_id=?) total,
      (SELECT COUNT(*) FROM course_progress cp JOIN courses c ON c.id=cp.course_id
        WHERE c.subject_id=? AND cp.worker_id=w.id AND cp.completed=1) done
    FROM workers w WHERE w.merged_into IS NULL
    ${ctx.user.role === 'enterprise' ? '' : 'AND w.base_id=?'}
  `).all(...(ctx.user.role === 'enterprise'
    ? [ctx.params.subjectId, ctx.params.subjectId]
    : [ctx.params.subjectId, ctx.params.subjectId, ctx.user.base_id]));
  json(ctx.res, 200, { list: rows.map(r => ({ ...r, ready: r.total > 0 && r.done === r.total })) });
});
