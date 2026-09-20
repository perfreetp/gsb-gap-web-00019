import { route, json, HttpError } from '../index.js';
import { localNow } from '../util.js';

// 某地块/工种当期作业所需持证科目（采收工种）
function requiredSubjects(db, baseId, skillCode = 'harvest') {
  const skill = db.prepare('SELECT * FROM skills WHERE code=?').get(skillCode);
  return db.prepare(`SELECT su.* FROM skill_subjects ss JOIN subjects su ON su.id=ss.subject_id
    WHERE ss.skill_id=?`).all(skill.id);
}

function workerCertStatus(db, workerId, subjectIds) {
  const now = localNow();
  const missing = [];
  for (const sid of subjectIds) {
    const c = db.prepare(`SELECT * FROM certificates WHERE worker_id=? AND subject_id=? AND status='valid'
      AND (expire_at IS NULL OR expire_at > ?) ORDER BY id DESC LIMIT 1`).get(workerId, sid, now);
    if (!c) {
      const sub = db.prepare('SELECT name FROM subjects WHERE id=?').get(sid);
      missing.push(sub.name);
    }
  }
  return { certified: missing.length === 0, missing };
}

// 采收前校验：录入地块+作业人员 -> 持证情况
route('POST', '/api/harvest/check', (ctx) => {
  const b = ctx.body || {};
  if (!b.plot_id || !b.worker_ids?.length) throw new HttpError(400, '地块和作业人员必填');
  const plot = ctx.db.prepare('SELECT * FROM plots WHERE id=?').get(b.plot_id);
  if (!plot) throw new HttpError(404, '地块不存在');
  if (ctx.user.role !== 'enterprise' && plot.base_id !== ctx.user.base_id) throw new HttpError(403, '越权');
  const subs = requiredSubjects(ctx.db, plot.base_id);
  const results = b.worker_ids.map(wid => {
    const w = ctx.db.prepare('SELECT id, name FROM workers WHERE id=?').get(wid);
    const st = workerCertStatus(ctx.db, wid, subs.map(s => s.id));
    return { worker_id: wid, name: w?.name, ...st };
  });
  json(ctx.res, 200, {
    required_subjects: subs.map(s => ({ id: s.id, name: s.name, valid_months: s.valid_months })),
    results,
    warning: results.some(r => !r.certified) ? '存在未持证作业人员，必须逐人填写原因后方可登记' : null,
  });
});

route('POST', '/api/harvest/batches', (ctx) => {
  if (!['admin', 'tech'].includes(ctx.user.role)) throw new HttpError(403, '无权限');
  const b = ctx.body || {};
  if (!b.plot_id || !b.harvest_time || !b.workers?.length) throw new HttpError(400, '地块、采收时间和作业人员必填');
  const plot = ctx.db.prepare('SELECT * FROM plots WHERE id=?').get(b.plot_id);
  if (plot.base_id !== ctx.user.base_id) throw new HttpError(403, '越权');
  const subs = requiredSubjects(ctx.db, plot.base_id);
  // 未持证必须填写原因
  for (const w of b.workers) {
    const st = workerCertStatus(ctx.db, w.worker_id, subs.map(s => s.id));
    if (!st.certified && !(w.reason || '').trim())
      throw new HttpError(400, `作业人员 ${w.worker_id} 未持证（${st.missing.join('、')}），必须填写原因`);
  }
  const batchNo = b.batch_no || ('HB' + b.harvest_time.slice(0, 10).replace(/-/g, '') + '-' +
    Math.random().toString(36).slice(2, 6).toUpperCase());
  const id = ctx.db.prepare(`INSERT INTO harvest_batches(batch_no, base_id, plot_id, variety, harvest_time, remark, created_by)
    VALUES(?,?,?,?,?,?,?)`).run(batchNo, plot.base_id, plot.id, b.variety || plot.herb_variety,
      b.harvest_time, b.remark || null, ctx.user.id).lastInsertRowid;
  const ins = ctx.db.prepare(`INSERT INTO harvest_workers(batch_id, worker_id, certified, required_subject, reason)
    VALUES(?,?,?,?,?)`);
  for (const w of b.workers) {
    const st = workerCertStatus(ctx.db, w.worker_id, subs.map(s => s.id));
    ins.run(id, w.worker_id, st.certified ? 1 : 0,
      subs.map(s => s.name).join(';'), st.certified ? null : (w.reason || null));
  }
  // 未持证推送复训提醒
  for (const w of b.workers) {
    const st = workerCertStatus(ctx.db, w.worker_id, subs.map(s => s.id));
    if (!st.certified) {
      ctx.db.prepare(`INSERT INTO notifications(worker_id, title, body, type, ref_id)
        VALUES(?,?,?,?,?)`).run(w.worker_id, '采收作业未持证提醒',
        `批次 ${batchNo} 登记显示您缺少：${st.missing.join('、')}，请尽快参加培训补考`, 'harvest_warn', id);
    }
  }
  ctx.audit('采收登记（持证校验留痕）', 'harvest_batch', id, { batch_no: batchNo, workers: b.workers.length });
  json(ctx.res, 200, { id, batch_no: batchNo });
});

route('GET', '/api/harvest/batches', (ctx) => {
  const rows = ctx.db.prepare(`SELECT hb.*, p.code plot_code, p.name plot_name, b.name base_name,
      (SELECT COUNT(*) FROM harvest_workers hw WHERE hw.batch_id=hb.id) worker_count,
      (SELECT COUNT(*) FROM harvest_workers hw WHERE hw.batch_id=hb.id AND hw.certified=0) uncertified_count
    FROM harvest_batches hb JOIN plots p ON p.id=hb.plot_id JOIN bases b ON b.id=hb.base_id
    ${ctx.user.role === 'enterprise' ? '' : 'WHERE hb.base_id=?'}
    ORDER BY hb.id DESC`).all(...(ctx.user.role === 'enterprise' ? [] : [ctx.user.base_id]));
  json(ctx.res, 200, { list: rows });
});

route('GET', '/api/harvest/batches/:id', (ctx) => {
  const b = ctx.db.prepare(`SELECT hb.*, p.code plot_code, b.name base_name FROM harvest_batches hb
    JOIN plots p ON p.id=hb.plot_id JOIN bases b ON b.id=hb.base_id WHERE hb.id=?`).get(Number(ctx.params.id));
  if (!b) throw new HttpError(404, '批次不存在');
  if (ctx.user.role !== 'enterprise' && b.base_id !== ctx.user.base_id) throw new HttpError(403, '越权');
  const workers = ctx.db.prepare(`SELECT hw.*, w.name, w.phone, c.name coop_name
    FROM harvest_workers hw JOIN workers w ON w.id=hw.worker_id
    LEFT JOIN cooperatives c ON c.id=w.coop_id WHERE hw.batch_id=?`).all(b.id);
  json(ctx.res, 200, { batch: b, workers });
});

// 证书
route('GET', '/api/certificates', (ctx) => {
  let rows;
  if (ctx.user.role === 'farmer') {
    rows = ctx.db.prepare(`SELECT ce.*, s.name subject_name, w.name worker_name FROM certificates ce
      JOIN subjects s ON s.id=ce.subject_id JOIN workers w ON w.id=ce.worker_id
      WHERE ce.worker_id=? ORDER BY ce.id DESC`).all(ctx.user.worker_id);
  } else if (ctx.query.worker_id) {
    rows = ctx.db.prepare(`SELECT ce.*, s.name subject_name, w.name worker_name FROM certificates ce
      JOIN subjects s ON s.id=ce.subject_id JOIN workers w ON w.id=ce.worker_id
      WHERE ce.worker_id=? ORDER BY ce.id DESC`).all(ctx.query.worker_id);
  } else {
    rows = ctx.db.prepare(`SELECT ce.*, s.name subject_name, w.name worker_name, b.name base_name
      FROM certificates ce JOIN subjects s ON s.id=ce.subject_id JOIN workers w ON w.id=ce.worker_id
      JOIN bases b ON b.id=w.base_id
      ${ctx.user.role === 'enterprise' ? '' : 'WHERE w.base_id=?'}
      ORDER BY ce.id DESC`).all(...(ctx.user.role === 'enterprise' ? [] : [ctx.user.base_id]));
  }
  const now = localNow();
  rows = rows.map(r => ({
    ...r,
    is_expired: r.expire_at && r.expire_at < now,
    days_left: r.expire_at ? Math.ceil((new Date(r.expire_at.replace(' ', 'T')) - new Date()) / 86400000) : null,
  }));
  json(ctx.res, 200, { list: rows });
});

// 证书到期扫描 + 推送（定时/手动）
route('POST', '/api/certificates/renew-scan', (ctx) => {
  const rows = ctx.db.prepare(`SELECT ce.*, w.name worker_name FROM certificates ce JOIN workers w ON w.id=ce.worker_id
    WHERE ce.status='valid' AND ce.expire_at IS NOT NULL
      AND ce.expire_at <= datetime('now','+30 day','localtime')
      AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.worker_id=ce.worker_id AND n.type='cert_expire'
        AND n.ref_id=ce.id AND date(n.created_at)=date('now','localtime'))`).all();
  for (const c of rows) {
    ctx.db.prepare(`INSERT INTO notifications(worker_id, title, body, type, ref_id) VALUES(?,?,?,?,?)`)
      .run(c.worker_id, '证书到期复训提醒',
        `您的《${ctx.db.prepare('SELECT name FROM subjects WHERE id=?').get(c.subject_id).name}》合格证将于 ${c.expire_at.slice(0,10)} 到期，请及时复训`,
        'cert_expire', c.id);
  }
  json(ctx.res, 200, { notified: rows.length });
});
