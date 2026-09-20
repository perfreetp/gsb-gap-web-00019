// 双评取均、申诉复核改分、证书重签 专项
const base = 'http://localhost:3000';
let pass = 0, fail = 0;
async function api(method, path, token, body) {
  const r = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? '  PASS ' + m : '  FAIL ' + m); };
const login = async u => (await api('POST', '/auth/login', null, { username: u, password: '123456' })).json.token;

(async () => {
  const tech = await login('tech');
  const admin = await login('admin');
  const farmer = await login('farmer');

  // 种子中刘长贵 reg_id=1 已双评完成（8/10 -> 9 均分），验证成绩 85
  let d = await api("GET", "/grading/registration/1", tech);
  const shortQ = d.json.questions.find(q => q.type === 'short');
  ok(shortQ.grades.length === 2, '简答题已有 2 名评阅（双评）');
  const avg = (shortQ.grades[0].score + shortQ.grades[1].score) / 2;
  ok(Math.abs(avg - 9) < 0.01, `双评均分=${avg}（应为 9）`);
  const reg1 = d.json.registration;
  ok(reg1.total_score === 85, `总分 85（客观60 + 主观9/100*100/3≈... 实际=${reg1.total_score}）`);

  // 杨有才 reg_id=2 有一条 adjusted 申诉
  const appeals = await api('GET', '/grading/appeals', tech);
  ok(appeals.json.some(a => a.status === 'adjusted'), '存在已调分申诉');

  // 新流程：技术员给待评试卷打分 -> 双评 -> 证书；这里用纸质卷快速造一个合格者再申诉复核
  // 取赵桂芳 people[3]=id 4? 用名单接口查一个无证书的人
  const people = await api('GET', '/people', admin);
  const target = people.json.find(p => p.name === '冯小兰');

  // 找一个 GAP 科目建场，纸质录 55（不合格，无证书）-> 申诉 -> 复核调分到 70 -> 证书签发
  const meta = await api('GET', '/meta', tech);
  const gapSubj = meta.json.subjects.find(s => s.code === 'gap_general').id;
  const exam = (await api('POST', '/exams', tech, { title: '申诉复核专项卷', subject_id: gapSubj,
    start_at: Date.now() - 3600000, duration_min: 30, pass_score: 60, paper_question_count: 2,
    require_course_completion: false })).json;
  let r = await api('POST', `/exams/${exam.id}/paper-score`, tech, { person_id: target.id, score: 55 });
  ok(r.json.result.passed === false, '纸质录 55 不合格');
  const regs = (await api('GET', `/exams/${exam.id}`, tech)).json.registrations;
  const regId = regs.find(x => x.person_id === target.id).id;

  // 无证
  let certs = await api('GET', `/certificates?person_id=${target.id}`, admin);
  ok(!certs.json.some(c => c.exam_id === exam.id), '55 分未发证书');

  // 药农只能对本人申诉（farmer=刘长贵，对冯小兰的记录应 403）
  const cross = await api('POST', `/exams/registration/${regId}/appeal`, farmer,
    { reason: '越权申诉' });
  ok(cross.status === 403, '药农不能对他人成绩申诉');
  // 技术员代药农录入线下申诉
  const a2 = await api('POST', `/exams/registration/${regId}/appeal`, tech,
    { reason: '冯小兰线下提出复核申请' });
  ok(a2.json.ok, '技术员代提申诉');
  const appealList = await api('GET', '/grading/appeals', tech);
  var appealId = appealList.json.find(a => a.reg_id === regId).id;

  // 复核调分到 70
  r = await api('POST', `/grading/appeal/${appealId}/review`, tech,
    { status: 'adjusted', reply: '复核后调整为 70 分', adjust_score: 70 });
  certs = await api('GET', `/certificates?person_id=${target.id}`, admin);
  ok(certs.json.some(c => c.exam_id === exam.id), '调分及格后补发证书');

  // 审计含 appeal_review 与 paper_score_entry
  const logs = await api('GET', '/audit?entity=appeal', admin);
  ok(logs.json.some(l => l.action === 'appeal_review'), '审计含 appeal_review');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
