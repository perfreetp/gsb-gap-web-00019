import { route, json, HttpError } from '../index.js';

// 企业质控不限基地；其余角色限定本基地
function baseFilter(ctx, table) {
  if (ctx.user.role === 'enterprise') return { sql: '', p: [] };
  return { sql: `${table}.base_id=?`, p: [ctx.user.base_id] };
}

// 合格率：按 地块 / 合作社 / 科目 维度
route('GET', '/api/stats/pass-rate', (ctx) => {
  const { dimension = 'plot', subject_id } = ctx.query;
  let labelSql, joinSql, baseCol;
  if (dimension === 'subject') {
    labelSql = "COALESCE(s.name,'未分科')";
    joinSql = 'JOIN subjects s ON s.id=e.subject_id';
    baseCol = 'e';
  } else if (dimension === 'coop') {
    labelSql = "COALESCE(c.name,'未分配')";
    joinSql = 'JOIN workers w2 ON w2.id=a.worker_id LEFT JOIN cooperatives c ON c.id=w2.coop_id';
    baseCol = 'e';
  } else {
    labelSql = "COALESCE(p.code,'未分配')";
    joinSql = `JOIN workers w2 ON w2.id=a.worker_id LEFT JOIN plots p ON p.id=w2.plot_id`;
    baseCol = 'e';
  }
  const bf = baseFilter(ctx, baseCol);
  const params = [...bf.p];
  if (subject_id) params.push(subject_id);
  const rows = ctx.db.prepare(`SELECT ${labelSql} label,
      COUNT(*) attempt_count,
      COUNT(DISTINCT a.worker_id) person_count,
      SUM(CASE WHEN a.passed=1 THEN 1 ELSE 0 END) pass_count,
      ROUND(100.0*SUM(CASE WHEN a.passed=1 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) pass_rate
    FROM exam_attempts a
    JOIN exams e ON e.id=a.exam_id
    ${joinSql}
    WHERE a.status='graded' ${bf.sql ? 'AND '+bf.sql : ''}
    ${subject_id ? 'AND e.subject_id=?' : ''}
    GROUP BY label ORDER BY label`).all(...params);
  json(ctx.res, 200, { list: rows, dimension });
});

// 缺训/缺证名单
route('GET', '/api/stats/missing-training', (ctx) => {
  const { subject_id, skill_id } = ctx.query;
  const bf = baseFilter(ctx, 'w');
  const conds = ['w.merged_into IS NULL', bf.sql].filter(Boolean);
  const params = [...bf.p];
  if (skill_id) { conds.push('EXISTS(SELECT 1 FROM worker_skills ws WHERE ws.worker_id=w.id AND ws.skill_id=?)'); params.push(skill_id); }
  const subs = subject_id
    ? ctx.db.prepare('SELECT * FROM subjects WHERE id=?').all(subject_id)
    : (skill_id
      ? ctx.db.prepare(`SELECT su.* FROM skill_subjects ss JOIN subjects su ON su.id=ss.subject_id WHERE ss.skill_id=?`).all(skill_id)
      : ctx.db.prepare('SELECT * FROM subjects').all());
  const workers = ctx.db.prepare(`SELECT w.id, w.name, w.phone, c.name coop_name, p.code plot_code
    FROM workers w LEFT JOIN cooperatives c ON c.id=w.coop_id LEFT JOIN plots p ON p.id=w.plot_id
    WHERE ${conds.join(' AND ')} ORDER BY w.id`).all(...params);
  const now = new Date(Date.now() + 8*3600*1000).toISOString().slice(0,19).replace('T',' ');
  const list = [];
  for (const w of workers) {
    const missing = [];
    for (const s of subs) {
      const cert = ctx.db.prepare(`SELECT 1 FROM certificates WHERE worker_id=? AND subject_id=? AND status='valid'
        AND (expire_at IS NULL OR expire_at>?)`).get(w.id, s.id, now);
      if (!cert) missing.push(s.name);
    }
    if (missing.length) list.push({ worker_id: w.id, name: w.name, phone: w.phone, coop_name: w.coop_name, plot_code: w.plot_code, missing_subjects: missing });
  }
  json(ctx.res, 200, { list });
});

// 年度学时：线下签到学时 + 线上完成课件学时
route('GET', '/api/stats/worker-hours', (ctx) => {
  const year = String(ctx.query.year || new Date().getFullYear());
  const bf = baseFilter(ctx, 'w');
  const rows = ctx.db.prepare(`SELECT w.id, w.name, w.phone, w.employment_type, c.name coop_name, p.code plot_code,
      COALESCE((
        SELECT ROUND(SUM(se.credit_hours),1) FROM attendance a
        JOIN sessions se ON se.id=a.session_id
        WHERE a.worker_id=w.id AND strftime('%Y', se.train_time)=?
      ),0) train_hours,
      COALESCE((
        SELECT ROUND(SUM(c.duration_sec)/3600.0,1) FROM course_progress cp
        JOIN courses c ON c.id=cp.course_id WHERE cp.worker_id=w.id AND cp.completed=1
          AND strftime('%Y', cp.updated_at)=?
      ),0) online_hours,
      (SELECT COUNT(*) FROM certificates ce WHERE ce.worker_id=w.id AND ce.status='valid'
        AND (ce.expire_at IS NULL OR ce.expire_at>datetime('now','localtime'))) cert_count
    FROM workers w LEFT JOIN cooperatives c ON c.id=w.coop_id LEFT JOIN plots p ON p.id=w.plot_id
    WHERE w.merged_into IS NULL ${bf.sql ? 'AND '+bf.sql : ''}
    ORDER BY train_hours DESC, w.id`).all(year, year, ...bf.p);
  json(ctx.res, 200, { list: rows.map(r => ({ ...r, total_hours: Math.round((r.train_hours + r.online_hours) * 10) / 10 })), year });
});

route('GET', '/api/stats/lecturer-scores', (ctx) => {
  const bf = baseFilter(ctx, 'se');
  const rows = ctx.db.prepare(`SELECT se.lecturer,
      COUNT(DISTINCT se.id) session_count,
      COUNT(f.id) feedback_count,
      ROUND(AVG(f.score),2) avg_score
    FROM sessions se LEFT JOIN session_feedback f ON f.session_id=se.id
    WHERE se.lecturer IS NOT NULL AND se.lecturer<>'' ${bf.sql ? 'AND '+bf.sql : ''}
    GROUP BY se.lecturer ORDER BY avg_score DESC`).all(...bf.p);
  json(ctx.res, 200, { list: rows });
});

route('GET', '/api/stats/overview', (ctx) => {
  const b = ctx.user.role === 'enterprise' ? '' : 'AND base_id=?';
  const bp = ctx.user.role === 'enterprise' ? [] : [ctx.user.base_id];
  const one = (sql, ps = []) => ctx.db.prepare(sql).get(...ps);
  const data = {
    workers: one(`SELECT COUNT(*) c FROM workers WHERE merged_into IS NULL ${b}`, bp).c,
    sessions: one(`SELECT COUNT(*) c FROM sessions WHERE 1=1 ${b}`, bp).c,
    exams: one(`SELECT COUNT(*) c FROM exams WHERE 1=1 ${b}`, bp).c,
    certs: one(`SELECT COUNT(*) c FROM certificates ce JOIN workers w ON w.id=ce.worker_id
      WHERE ce.status='valid' AND (ce.expire_at IS NULL OR ce.expire_at>datetime('now','localtime')) ${b.replace('base_id','w.base_id')}`, bp).c,
    expire_soon: one(`SELECT COUNT(*) c FROM certificates ce JOIN workers w ON w.id=ce.worker_id
      WHERE ce.status='valid' AND ce.expire_at IS NOT NULL
      AND ce.expire_at <= datetime('now','+30 day','localtime') ${b.replace('base_id','w.base_id')}`, bp).c,
    pending_review: one(`SELECT COUNT(*) c FROM exam_attempts a JOIN exams e ON e.id=a.exam_id
      WHERE a.status='submitted' ${b.replace('base_id','e.base_id')}`, bp).c,
    uncertified_harvest: one(`SELECT COUNT(*) c FROM harvest_workers hw JOIN harvest_batches hb ON hb.id=hw.batch_id
      WHERE hw.certified=0 ${b.replace('base_id','hb.base_id')}`, bp).c,
  };
  json(ctx.res, 200, data);
});

route('GET', '/api/audit-logs', (ctx) => {
  if (!['enterprise', 'admin'].includes(ctx.user.role)) throw new HttpError(403, '仅管理员可查看审计日志');
  const { entity, keyword, page = 1 } = ctx.query;
  const conds = []; const params = [];
  if (entity) { conds.push('entity=?'); params.push(entity); }
  if (keyword) { conds.push('(action LIKE ? OR actor_name LIKE ? OR detail LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = ctx.db.prepare(`SELECT COUNT(*) c FROM audit_logs ${where}`).get(...params).c;
  const rows = ctx.db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, 30, (page - 1) * 30);
  json(ctx.res, 200, { list: rows, total });
});

route('GET', '/api/export/harvest/:id.csv', (ctx) => {
  const id = Number(ctx.params.id);
  const b = ctx.db.prepare(`SELECT hb.*, p.code plot_code, p.name plot_name, ba.name base_name FROM harvest_batches hb
    JOIN plots p ON p.id=hb.plot_id JOIN bases ba ON ba.id=hb.base_id WHERE hb.id=?`).get(id);
  if (!b) throw new HttpError(404, '批次不存在');
  if (ctx.user.role !== 'enterprise' && b.base_id !== ctx.user.base_id) throw new HttpError(403, '越权');
  const workers = ctx.db.prepare(`SELECT w.name, c.name coop_name, hw.certified, hw.required_subject, hw.reason
    FROM harvest_workers hw JOIN workers w ON w.id=hw.worker_id LEFT JOIN cooperatives c ON c.id=w.coop_id
    WHERE hw.batch_id=?`).all(id);
  const lines = [
    ['中药材采收批次留痕单'],
    ['批次编号', b.batch_no, '基地', b.base_name, '地块', b.plot_code, '品种', b.variety, '采收时间', b.harvest_time],
    [],
    ['作业人员', '所属合作社', '是否持证', '要求科目', '未持证原因'],
    ...workers.map(w => [w.name, w.coop_name || '', w.certified ? '是' : '否', w.required_subject || '', w.reason || '']),
  ];
  const csv = '\uFEFF' + lines.map(l => l.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  ctx.res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="harvest_${b.batch_no}.csv"`,
  });
  ctx.res.end(csv);
});
