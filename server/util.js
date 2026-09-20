const { db, now } = require('./db');

function addMonths(ts, months) {
  const d = new Date(ts);
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}

function fmtDate(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 课件完成度校验：报名科目下所有课件均须完成
function coursesCompleted(personId, subjectId) {
  const courses = db.prepare('SELECT id FROM courses WHERE subject_id=?').all(subjectId);
  if (courses.length === 0) return { completed: true, missing: [] };
  const missing = [];
  for (const c of courses) {
    const prog = db.prepare('SELECT completed FROM course_progress WHERE person_id=? AND course_id=?')
      .get(personId, c.id);
    if (!prog || !prog.completed) missing.push(c.id);
  }
  return { completed: missing.length === 0, missing };
}

// 取某人某科目的当前有效证书
function validCertificate(personId, subjectId, at = now()) {
  return db.prepare(`SELECT * FROM certificates
    WHERE person_id=? AND subject_id=? AND revoked=0 AND issued_at<=?
      AND (valid_until IS NULL OR valid_until>?)
    ORDER BY issued_at DESC LIMIT 1`)
    .get(personId, subjectId, at, at);
}

// 某工种要求的全部科目均有有效证书
function checkSkillCertified(personId, tagId, at = now()) {
  const tag = db.prepare('SELECT * FROM skill_tags WHERE id=?').get(tagId);
  if (!tag) return { certified: false, missing: [] };
  const required = JSON.parse(tag.required_subject_ids);
  const missing = required.filter(sid => !validCertificate(personId, sid, at));
  return { certified: missing.length === 0, missing, required };
}

// 培训应到名单：显式名单优先，否则按工种标签动态计算
function expectedAttendeeIds(training, txDb = db) {
  const explicit = txDb.prepare('SELECT person_id FROM training_attendees WHERE training_id=?')
    .all(training.id).map(r => r.person_id);
  if (explicit.length > 0) return explicit;
  if (!training.tag_id) return [];
  return txDb.prepare('SELECT person_id FROM person_skills WHERE tag_id=?').all(training.tag_id)
    .map(r => r.person_id);
}

module.exports = { addMonths, fmtDate, coursesCompleted, validCertificate, checkSkillCertified, expectedAttendeeIds };
