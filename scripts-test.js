const base = 'http://localhost:3000';
let pass = 0, fail = 0;
async function api(method, path, token, body) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL:', msg); } }
async function login(u) {
  return (await api('POST', '/api/auth/login', null, { username: u, password: '123456' })).json.token;
}

(async () => {
  const admin = await login('admin');
  const tech = await login('tech');
  const farmer = await login('farmer');

  console.log('-- roster & merge --');
  let r = await api('POST', '/api/people', admin, { name: '测试药农', id_card: 'TEST123', phone: '13700000001',
    cooperative_id: 1, plot_id: 1, employment_type: 'seasonal', base_id: 1 });
  ok(r.status === 200, 'create person');
  const newId = r.json.id;
  r = await api('POST', '/api/people', admin, { name: '测试药农', id_card: 'TEST123', base_id: 1 });
  ok(r.status === 409, 'duplicate id card -> 409');

  const dupId = (await api('POST', '/api/people', admin, { name: '重复源', id_card: 'TESTDUP99',
    phone: '13700009999', base_id: 1, tag_ids: [1] })).json.id;
  r = await api('POST', '/api/people/merge', admin, { source_id: dupId, target_id: newId });
  ok(r.status === 200 && r.json.merged, 'merge duplicates');
  const merged = (await api('GET', '/api/people/' + newId, admin)).json;
  ok(merged.tag_ids.includes(1), 'tag migrated after merge');

  r = await api('POST', '/api/people/import', admin, { base_id: 1, csv:
    '姓名,身份证,手机号,合作社,地块,用工类型,工种标签\n导入甲,IMP001,13800000001,青山药农专业合作社,P-01,长期用工,育苗工\n导入甲,IMP001,13800000001,青山药农专业合作社,P-01,长期用工,移栽工\n导入乙,IMP002,,青山药农专业合作社,P-02,季节性用工,除草工' });
  ok(r.json.created === 2 && r.json.merged === 1, 'csv import: 2 created 1 merged');
  const imp = (await api('GET', '/api/people?q=导入甲', admin)).json[0];
  ok(imp.tag_names.includes('育苗工') && imp.tag_names.includes('移栽工'), 'import merge accumulates tags');

  console.log('-- attendance idempotency --');
  const training = (await api('GET', '/api/trainings?upcoming=1', tech)).json[0];
  r = await api('POST', `/api/trainings/${training.id}/signin`, farmer, { client_event_id: 'evt-abc-1' });
  ok(r.status === 200 && !r.json.duplicated, 'scan signin');
  r = await api('POST', `/api/trainings/${training.id}/signin`, farmer, { client_event_id: 'evt-abc-1' });
  ok(r.json.duplicated === true, 'duplicate signin deduped');
  r = await api('POST', '/api/trainings/signin-batch', tech, { items: [
    { training_id: training.id, person_id: 3, method: 'proxy', client_event_id: 'batch-1' },
    { training_id: training.id, person_id: 3, method: 'proxy', client_event_id: 'batch-1' },
    { training_id: training.id, person_id: 4, method: 'proxy', client_event_id: 'batch-2' } ] });
  ok(r.json.created === 2 && r.json.duplicated === 1, 'offline batch: 2 new 1 dup');

  console.log('-- absent list --');
  r = await api('POST', `/api/trainings/1/remind-absent`, tech);
  ok(r.json.absent_count === 2, '2 absent for past GAP training');

  console.log('-- course gate --');
  const meta = (await api('GET', '/api/meta', tech)).json;
  const hvSubj = meta.subjects.find(s => s.code === 'harvest_std').id;
  const gateExam = (await api('POST', '/api/exams', tech, { title: '门槛测试卷', subject_id: hvSubj,
    start_at: Date.now() + 86400000, duration_min: 40, pass_score: 60, paper_question_count: 3,
    require_course_completion: true })).json;
  r = await api('POST', `/api/exams/${gateExam.id}/register`, farmer);
  ok(r.status === 409 && /未学完/.test(r.json.error), 'cannot register before courses done');
  const hvCourse = (await api('GET', `/api/courses?subject_id=${hvSubj}`, farmer)).json[0];
  await api('POST', '/api/courses/progress', farmer, { course_id: hvCourse.id, watched_sec: hvCourse.duration_sec || 1, completed: true });
  r = await api('POST', `/api/exams/${gateExam.id}/register`, farmer);
  ok(r.status === 200, 'register after completion');

  console.log('-- resume & answer idempotency --');
  r = await api('POST', `/api/exams/${gateExam.id}/start`, farmer);
  ok(r.status === 200 && r.json.remaining_ms > 0, 'start with countdown');
  const regId = r.json.reg_id;
  const q0 = r.json.questions[0];
  await api('POST', '/api/exams/answer', farmer, { reg_id: regId, question_id: q0.id, answer: [0] });
  r = await api('POST', '/api/exams/answer', farmer, { reg_id: regId, question_id: q0.id, answer: [0] });
  ok(r.status === 200, 'answer upsert idempotent');
  r = await api('POST', `/api/exams/${gateExam.id}/start`, farmer);
  ok(Object.keys(r.json.saved_answers).length === 1, 'resume restores answers');

  console.log('-- A/B papers --');
  const examDetail = (await api('GET', `/api/exams/${gateExam.id}`, tech)).json;
  ok(examDetail.papers.length === 2, 'A/B papers generated');

  console.log('-- grading & cert --');
  r = await api('POST', `/api/exams/${gateExam.id}/submit`, farmer);
  ok(r.json.result, 'submit returns result');

  console.log('-- paper score entry --');
  const paperTarget = (await api('GET', '/api/people?q=郑有福', admin)).json[0];
  r = await api('POST', `/api/exams/${gateExam.id}/paper-score`, tech, { person_id: paperTarget.id, score: 88 });
  ok(r.status === 200 && r.json.result.passed, 'paper score entered');

  console.log('-- harvest cert check --');
  const plot4 = meta.plots.find(p => p.code === 'P-04');
  r = await api('POST', '/api/harvest/check-workers', tech, { plot_id: plot4.id, workers: [
    { person_id: 9, tag_id: meta.skill_tags.find(t => t.code === 'harvest').id },
    { person_id: 12, tag_id: meta.skill_tags.find(t => t.code === 'harvest').id } ] });
  ok(r.json.workers[0].certified && !r.json.workers[1].certified, 'certified/uncertified detected');
  r = await api('POST', '/api/harvest/batches', tech, { plot_id: plot4.id,
    workers: [{ person_id: 12, tag_id: meta.skill_tags.find(t => t.code === 'harvest').id }] });
  ok(r.status === 409, 'uncertified without reason rejected');
  r = await api('POST', '/api/harvest/batches', tech, { plot_id: plot4.id, workers: [
    { person_id: 9, tag_id: meta.skill_tags.find(t => t.code === 'harvest').id },
    { person_id: 12, tag_id: meta.skill_tags.find(t => t.code === 'harvest').id, warning_reason: '考核待考，仅做搬运辅助' } ] });
  ok(r.status === 200 && r.json.warnings === 1, 'batch recorded with warning');

  console.log('-- RBAC --');
  const ent = await login('qiye');
  const metaEnterprise = (await api('GET', '/api/meta', ent)).json;
  ok(metaEnterprise.bases.length >= 1, 'enterprise sees bases');
  const farmerCerts = (await api('GET', '/api/certificates', farmer)).json;
  ok(farmerCerts.every(c => c.person_name === '刘长贵'), 'farmer sees only own certs');

  console.log('-- stats & audit --');
  r = await api('GET', '/api/stats/overview', admin);
  ok(r.json.pass_rate !== undefined, 'overview pass rate');
  r = await api('GET', '/api/stats/pass-rate?dim=cooperative', admin);
  ok(Array.isArray(r.json) && r.json.length, 'cooperative pass rate');
  r = await api('GET', '/api/stats/annual-hours', admin);
  ok(r.json.some(x => x.hours > 0), 'annual hours');
  r = await api('GET', '/api/audit?entity=person', admin);
  ok(r.json.some(l => l.action === 'merge'), 'audit has merge log');

  console.log('-- cert expiry sweep --');
  r = await api('POST', '/api/certificates/sweep-expiry', tech);
  ok(r.status === 200, 'expiry sweep ok');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
