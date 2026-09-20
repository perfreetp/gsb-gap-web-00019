const { db } = require('../db');
const { expectedAttendeeIds } = require('../util');

// 供提醒等内部逻辑复用的明细
module.exports = function trainingDetail(trainingId) {
  const t = db.prepare('SELECT * FROM trainings WHERE id=?').get(trainingId);
  if (!t) return null;
  const expectedIds = expectedAttendeeIds(t);
  const peopleRows = expectedIds.length
    ? db.prepare(`SELECT id, name, phone FROM people WHERE merged_into IS NULL AND id IN
        (${expectedIds.map(() => '?').join(',')})`).all(...expectedIds)
    : [];
  const signs = db.prepare('SELECT person_id FROM attendance WHERE training_id=?').all(t.id)
    .map(r => r.person_id);
  const signSet = new Set(signs);
  return { ...t, attendees: peopleRows.map(p => ({ ...p, signed: signSet.has(p.id) })) };
};
