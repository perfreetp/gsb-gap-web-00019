import { db, migrate } from './db.js';
import { hashPassword } from './util.js';

migrate();

const exists = db.prepare('SELECT COUNT(*) c FROM bases').get().c;
if (exists) {
  console.log('已存在数据，跳过种子。如需重建请删除 data/gap.db');
  process.exit(0);
}

const insBase = db.prepare('INSERT INTO bases(name, location) VALUES(?,?)');
const b1 = insBase.run('亳州绿色中药材种植基地', '安徽省亳州市谯城区').lastInsertRowid;
const b2 = insBase.run('陇西道地药材示范基地', '甘肃省陇西县首阳镇').lastInsertRowid;

const insCoop = db.prepare('INSERT INTO cooperatives(base_id, name) VALUES(?,?)');
const coops1 = ['华佗中药材种植合作社', '药乡源种植合作社', '绿丰种植合作社'].map(n =>
  insCoop.run(b1, n).lastInsertRowid);
const coops2 = ['渭水源种植合作社', '首阳药农合作社'].map(n =>
  insCoop.run(b2, n).lastInsertRowid);

const insPlot = db.prepare(`INSERT INTO plots(base_id, coop_id, code, name, herb_variety, area_mu)
                            VALUES(?,?,?,?,?,?)`);
const plots1 = [
  [coops1[0], 'A-01', '东片区一号地', '白芍', 32],
  [coops1[0], 'A-02', '东片区二号地', '白术', 28],
  [coops1[1], 'B-01', '南坡地', '丹参', 45],
  [coops1[2], 'C-01', '河湾地', '菊花', 20],
].map(p => insPlot.run(b1, ...p).lastInsertRowid);
const plots2 = [
  [coops2[0], 'D-01', '北塬一号地', '黄芪', 60],
  [coops2[1], 'D-02', '北塬二号地', '党参', 38],
].map(p => insPlot.run(b2, ...p).lastInsertRowid);

console.log('基地/合作社/地块完成');

// 工种与科目
const skills = [
  ['seedling', '育苗', 1],
  ['transplant', '移栽', 2],
  ['weeding', '除草', 3],
  ['fertilizing', '施肥', 4],
  ['harvest', '采收', 5],
  ['primary', '初加工', 6],
  ['storage', '仓储', 7],
];
const insSkill = db.prepare('INSERT INTO skills(code, name, sort_no) VALUES(?,?,?)');
const skillIds = {};
for (const [code, name, no] of skills) skillIds[code] = insSkill.run(code, name, no).lastInsertRowid;

const subjects = [
  ['GAP', '中药材 GAP 通用规范', '基础规范', 0, 4],
  ['PEST', '农药安全使用与安全间隔期', '质量安全', 24, 6],
  ['BAN', '禁用限用农药清单', '质量安全', 12, 2],
  ['HARVEST_STD', '中药材采收与初加工标准', '采收加工', 0, 4],
  ['STORE', '中药材仓储养护规范', '仓储', 0, 3],
  ['FERT', '科学施肥与肥料管理', '田间管理', 12, 3],
];
const insSub = db.prepare('INSERT INTO subjects(code, name, category, valid_months, credit_hours) VALUES(?,?,?,?,?)');
const subIds = {};
for (const s of subjects) subIds[s[0]] = insSub.run(...s).lastInsertRowid;

const mapping = {
  seedling: ['GAP'],
  transplant: ['GAP', 'FERT'],
  weeding: ['GAP', 'BAN'],
  fertilizing: ['GAP', 'FERT', 'PEST'],
  harvest: ['GAP', 'PEST', 'BAN', 'HARVEST_STD'],
  primary: ['GAP', 'HARVEST_STD'],
  storage: ['GAP', 'STORE', 'PEST'],
};
const insSS = db.prepare('INSERT OR IGNORE INTO skill_subjects(skill_id, subject_id) VALUES(?,?)');
for (const [sk, subs] of Object.entries(mapping))
  for (const su of subs) insSS.run(skillIds[sk], subIds[su]);

console.log('工种/科目完成');

// 人员台账
const workerRows = [
  [b1, '王大山', '341602198503141234', '男', '13800000001', 'long_term', coops1[0], plots1[0]],
  [b1, '李秀英', '341602198607255678', '女', '13800000002', 'long_term', coops1[0], plots1[0]],
  [b1, '张铁柱', '341602199001129012', '男', '13800000003', 'seasonal', coops1[1], plots1[2]],
  [b1, '赵敏', '341602199205083456', '女', '13800000004', 'seasonal', coops1[2], plots1[3]],
  [b1, '陈志强', '341602197811207890', '男', '13800000005', 'long_term', coops1[1], plots1[2]],
  [b1, '孙桂芳', '341602198302152345', '女', '13800000006', 'seasonal', coops1[0], plots1[1]],
  [b2, '马国栋', '622425198406084567', '男', '13900000001', 'long_term', coops2[0], plots2[0]],
  [b2, '何春花', '622425199109138901', '女', '13900000002', 'seasonal', coops2[1], plots2[1]],
];
const insW = db.prepare(`INSERT INTO workers(base_id, name, id_card, gender, phone, employment_type, coop_id, plot_id)
                         VALUES(?,?,?,?,?,?,?,?)`);
const wIds = workerRows.map(r => insW.run(...r).lastInsertRowid);

const workerSkills = {
  0: ['seedling', 'transplant', 'harvest'],
  1: ['weeding', 'fertilizing', 'harvest'],
  2: ['harvest', 'primary'],
  3: ['harvest'],
  4: ['fertilizing', 'weeding', 'harvest', 'storage'],
  5: ['harvest', 'primary'],
  6: ['transplant', 'harvest', 'storage'],
  7: ['harvest', 'primary'],
};
const insWS = db.prepare('INSERT OR IGNORE INTO worker_skills(worker_id, skill_id) VALUES(?,?)');
for (const [idx, sks] of Object.entries(workerSkills))
  for (const sk of sks) insWS.run(wIds[idx], skillIds[sk]);

// 账号
function addUser(username, pwd, realName, role, baseId = null, workerId = null) {
  const { salt, hash } = hashPassword(pwd);
  return db.prepare(`INSERT INTO users(username, password_hash, salt, real_name, role, base_id, worker_id)
                     VALUES(?,?,?,?,?,?,?)`).run(username, hash, salt, realName, role, baseId, workerId).lastInsertRowid;
}
addUser('qiye', 'qiye123', '企业质控-周经理', 'enterprise');
addUser('admin1', 'admin1123', '基地管理员-刘主任', 'admin', b1);
addUser('admin2', 'admin2123', '基地管理员-甘肃刘主任', 'admin', b2);
addUser('tech1', 'tech1123', '技术指导员-杨老师', 'tech', b1);
addUser('tech2', 'tech2123', '技术指导员-甘肃杨老师', 'tech', b2);
addUser('farmer1', 'farmer123', '王大山', 'farmer', b1, wIds[0]);
addUser('farmer2', 'farmer123', '赵敏', 'farmer', b1, wIds[3]);
addUser('farmer3', 'farmer123', '马国栋', 'farmer', b2, wIds[6]);

console.log('人员台账与账号完成');

// 课程课件（含章节，短视频以占位视频地址表示）
const insCourse = db.prepare(`INSERT INTO courses(subject_id, title, type, duration_sec, chapters, content)
                              VALUES(?,?,?,?,?,?)`);
function addCourse(subjectCode, title, type, mins, chapters, content) {
  return insCourse.run(subIds[subjectCode], title, type, mins * 60,
    JSON.stringify(chapters.map((c, i) => ({ no: i + 1, title: c, dur: Math.round(mins * 60 / chapters.length) }))),
    content).lastInsertRowid;
}
addCourse('GAP', 'GAP 通用规范解读（课件）', 'doc', 30,
  ['总则与质量管理', '产地环境', '种植管理', '采收与初加工', '包装、放行与追溯'],
  '《中药材生产质量管理规范》（GAP）要求中药材生产全过程可追溯，质量可控制……');
addCourse('PEST', '农药安全使用与安全间隔期（短视频）', 'video', 25,
  ['农药标签怎么看', '安全间隔期计算', '施药防护', '中毒应急处置'],
  '安全间隔期：最后一次施药到采收之间必须间隔的最短天数，严禁提前采收。');
addCourse('BAN', '禁用限用农药清单解读', 'doc', 15,
  ['国家禁限用目录', '药材上禁用品种', '违规后果'],
  '甲胺磷、对硫磷、甲基对硫磷、久效磷、磷胺等为国家明令禁止使用农药。');
addCourse('HARVEST_STD', '采收与初加工标准（短视频）', 'video', 20,
  ['适宜采收期判定', '采收卫生要求', '趁鲜加工', '干燥与净制'],
  '应按药材质量要求在适宜采收期采收，采收器械应清洁，避免二次污染。');
addCourse('STORE', '中药材仓储养护规范', 'doc', 18,
  ['仓库条件', '分类分区存放', '防霉防虫防鼠', '养护记录'],
  '仓库应通风、干燥、避光，定期监测温湿度并记录。');
addCourse('FERT', '科学施肥与肥料管理', 'video', 22,
  ['需肥规律', '有机肥腐熟', '化肥减量增效', '施肥记录'],
  '有机肥应充分腐熟达标后使用，推广测土配方施肥。');

console.log('课件完成');

// 题库：每个科目若干客观题 + 识图/简答题
const insQ = db.prepare(`INSERT INTO question_bank(subject_id, variety, chapter, difficulty, type, stem, options, answer, score)
                         VALUES(?,?,?,?,?,?,?,?,?)`);
const QB = {
  GAP: [
    ['single', 'GAP 的中文全称是？', '["药品生产质量管理规范","中药材生产质量管理规范","中药材种植技术规程"]', 'B', 10],
    ['judge', 'GAP 要求中药材生产全过程可追溯。', null, 'T', 5],
    ['single', '种植基地土壤环境质量应符合什么要求？', '["无要求","符合相应国家标准且定期监测","只要产量高即可"]', 'B', 10],
    ['multi', '以下属于 GAP 质量管理环节的有？', '["产地环境","种植管理","采收加工","包装放行"]', 'A,B,C,D', 15],
    ['image', '识图：图中哪种是符合要求的采收周转筐（清洁/专用/破损）？', '["清洁专用筐","就地堆放","装过农药的筐"]', 'A', 15],
    ['short', '简述实现药材质量可追溯至少应记录哪些信息？', null, '地块、品种、农事操作、投入品、采收批次、责任人', 15],
  ],
  PEST: [
    ['single', '安全间隔期是指？', '["施药到下雨的时间","最后一次施药到采收的最短间隔天数","购药到用药的时间"]', 'B', 10],
    ['judge', '只要药效好，采收前一天也可以施药。', null, 'F', 5],
    ['multi', '施药时应做好哪些防护？', '["戴口罩","穿防护服","戴手套","逆风连续作业"]', 'A,B,C', 15],
    ['single', '农药标签上红色“安全间隔期 XX 天”表示？', '["建议天数，可灵活掌握","必须严格遵守","与采收无关"]', 'B', 10],
    ['image', '识图：下列防护穿戴正确的是？', '["赤膊喷药","口罩手套防护服齐全","仅戴草帽"]', 'B', 15],
    ['short', '发现有人农药中毒，现场处置要点有哪些？', null, '脱离现场、脱去污染衣物、清洗皮肤、携带标签送医', 15],
  ],
  BAN: [
    ['multi', '以下属于国家明令禁止使用的农药有？', '["甲胺磷","对硫磷","久效磷","磷胺"]', 'A,B,C,D', 20],
    ['judge', '禁用农药即使效果好也不得在药材上使用。', null, 'T', 10],
    ['single', '使用禁用农药最直接的后果是？', '["产量略降","药材农残超标并追究责任","无后果"]', 'B', 10],
    ['image', '识图：哪种包装标识代表高毒限用？', '["骷髅头/高毒标识","绿色食品标志","可回收标志"]', 'A', 20],
    ['short', '采购农药时应核验哪些信息以避免购入禁限用农药？', null, '登记证号、标签、适用作物、生产厂家、购销票据', 20],
  ],
  HARVEST_STD: [
    ['single', '中药材适宜采收期主要依据什么确定？', '["农闲时间","药材质量与有效成分积累规律","天气是否凉爽"]', 'B', 10],
    ['judge', '采收器械可以与施肥、施药器械混用。', null, 'F', 5],
    ['multi', '趁鲜加工的目的包括？', '["防止霉变","保留有效成分","便于干燥","美观好看"]', 'A,B,C', 15],
    ['image', '识图：哪种干燥方式更符合卫生要求？', '["地面直接摊晒","清洁晾晒架/网","柏油马路晾晒"]', 'B', 15],
    ['short', '简述采收环节防止二次污染的措施。', null, '清洁容器、专人专用、剔除霉烂、避免地面堆放、随批记录', 15],
  ],
  STORE: [
    ['single', '药材仓库相对湿度一般应控制在？', '[' + "'" + '越高越好' + "'" + ',"适宜范围并定期记录","不必监测"]', 'B', 10],
    ['judge', '药材可与农药、化肥同库存放。', null, 'F', 5],
    ['multi', '仓储养护要做到的“几防”包括？', '["防霉","防虫","防鼠","防混淆"]', 'A,B,C,D', 15],
    ['image', '识图：哪张图是合规的分区存放？', '["药材与杂物混堆","挂牌分区离地离墙","直接靠墙落地"]', 'B', 15],
    ['short', '温湿度异常时应采取哪些养护措施？', null, '通风、翻垛、除湿、记录并追溯处理', 15],
  ],
  FERT: [
    ['single', '有机肥在施用前应？', '["直接施用","充分腐熟达标","与农药混合"]', 'B', 10],
    ['judge', '测土配方施肥有助于化肥减量增效。', null, 'T', 5],
    ['multi', '施肥记录应包含哪些内容？', '["肥料名称","施用时间与地块","施用量","操作人"]', 'A,B,C,D', 15],
    ['image', '识图：哪种是腐熟达标的有机肥？', '["散发恶臭生粪","深褐色无异味松散","夹杂塑料垃圾"]', 'B', 15],
    ['short', '简述盲目过量施肥的危害。', null, '土壤板结、养分失衡、农残/重金属风险、成本上升', 15],
  ],
};
for (const [subCode, qs] of Object.entries(QB)) {
  qs.forEach((q, i) => {
    const [type, stem, options, answer, score] = q;
    const difficulty = i < 2 ? 1 : i < 4 ? 2 : 3;
    const varieties = ['白芍', '黄芪', null];
    insQ.run(subIds[subCode], varieties[i % 3], `第${(i % 5) + 1}章`, difficulty,
      type, stem, options, answer, score);
  });
}

console.log('题库完成');

// 演示培训场次（一场已结束、一场即将开始），统一本地时间
const daysAgo = n => {
  const d = new Date(Date.now() + 8*3600*1000 - n*86400000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};
const daysAhead = n => {
  const d = new Date(Date.now() + 8*3600*1000 + n*86400000);
  return d.toISOString().slice(0, 10) + ' 09:30:00';
};
const tech1 = db.prepare("SELECT id FROM users WHERE username='tech1'").get().id;
const insSession = db.prepare(`INSERT INTO sessions(base_id, subject_id, title, train_time, location, plot_id,
    lecturer, content, required_skill_id, credit_hours, status, created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
const sPast = insSession.run(b1, subIds.PEST, '农药安全间隔期专题培训', daysAgo(10),
  '基地培训室', plots1[0], '杨老师', '安全间隔期计算、禁限用农药、施药防护', skillIds.harvest, 6, 'finished', tech1).lastInsertRowid;
const sSoon = insSession.run(b1, subIds.HARVEST_STD, '白芍采收与初加工标准培训', daysAhead(2),
  '东片区一号地田头', plots1[0], '杨老师', '适宜采收期、趁鲜加工、卫生要求', skillIds.harvest, 4, 'scheduled', tech1).lastInsertRowid;

// 采收工种全部应到
const harvestWorkers = wIds.slice(0, 6);
const insEnr = db.prepare('INSERT OR IGNORE INTO enrollments(session_id, worker_id) VALUES(?,?)');
const insAtt = db.prepare(`INSERT OR IGNORE INTO attendance(session_id, worker_id, check_in_at, method, proxy_by, source)
                           VALUES(?,?,?,?,?,?)`);
harvestWorkers.forEach((w, i) => {
  insEnr.run(sPast, w);
  insEnr.run(sSoon, w);
  if (i < 4) insAtt.run(sPast, w, daysAgo(10), i === 3 ? 'proxy' : 'qrcode', i === 3 ? tech1 : null, i === 3 ? 'proxy' : 'online');
});
db.prepare("INSERT OR IGNORE INTO session_feedback(session_id, worker_id, score, comment) VALUES(?,?,?,?)")
  .run(sPast, wIds[0], 5, '案例清楚，间隔期一讲就懂');
db.prepare("INSERT OR IGNORE INTO session_feedback(session_id, worker_id, score, comment) VALUES(?,?,?,?)")
  .run(sPast, wIds[1], 4, '希望多发图文资料');

// 课程进度：王大山完成 PEST 全部课件，赵敏只完成一半（演示未学完不能报考）
const pestCourse = db.prepare("SELECT id, duration_sec FROM courses WHERE subject_id=?").all(subIds.PEST);
pestCourse.forEach((c, i) => {
  db.prepare(`INSERT INTO course_progress(worker_id, course_id, watched_sec, finished_chapters, completed, updated_at)
              VALUES(?,?,?,?,?,?)`)
    .run(wIds[0], c.id, c.duration_sec, JSON.stringify([1, 2, 3, 4]), 1, daysAgo(9));
  if (i === 0) db.prepare(`INSERT INTO course_progress(worker_id, course_id, watched_sec, finished_chapters, completed, updated_at)
              VALUES(?,?,?,?,?,?)`)
    .run(wIds[3], c.id, Math.round(c.duration_sec * 0.4), JSON.stringify([1]), 0, daysAgo(2));
});

console.log('培训场次/签到/学习进度完成');

// 演示一场已结束的农药安全考试（A/B 卷，王大山合格拿证、赵敏不合格）
import { generatePapers, issueCertificate } from './exam-core.js';
const examStart = (() => { const d = new Date(Date.now() + 8*3600*1000 - 7*86400000);
  return d.toISOString().slice(0,10) + ' 09:00:00'; })();
const blueprint = [
  { type: 'single', count: 2, score: 10 },
  { type: 'judge', count: 1, score: 5 },
  { type: 'multi', count: 1, score: 15 },
  { type: 'image', count: 1, score: 15 },
  { type: 'short', count: 1, score: 15 },
];
const examId = db.prepare(`INSERT INTO exams(base_id, subject_id, variety, title, start_time, duration_min,
    pass_score, max_retakes, blueprint, status, created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
  .run(b1, subIds.PEST, '白芍', '农药安全使用考核（白芍）', examStart, 45, 60, 1,
    JSON.stringify(blueprint), 'finished', tech1).lastInsertRowid;
const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(examId);
const papers = generatePapers(exam);

function mockAttempt(workerId, paper, attemptNo, total, passed) {
  const start = daysAgo(7);
  const r = db.prepare(`INSERT INTO exam_attempts(exam_id, paper_id, worker_id, attempt_no, status,
      started_at, deadline_at, submitted_at, objective_score, subjective_score, total_score, passed, source)
      VALUES(?,?,?,?, 'graded',?,?,?,?,?,?,?, 'online')`)
    .run(examId, paper.id, workerId, attemptNo, start, start, start,
      total - 30, 30, total, passed ? 1 : 0).lastInsertRowid;
  if (passed) {
    const w = db.prepare('SELECT * FROM workers WHERE id=?').get(workerId);
    issueCertificate(exam, db.prepare('SELECT * FROM exam_attempts WHERE id=?').get(r), total, w);
  }
  return r;
}
mockAttempt(wIds[0], papers[0], 1, 85, true);
mockAttempt(wIds[1], papers[1], 1, 55, false);

// 演示一个即将到期提醒（BAN 科目先造一张快到期证书给王大山）——直接构造
const banSub = subIds.BAN;
const soonExpire = (() => { const d = new Date(); d.setDate(d.getDate() + 20); return d.toISOString().slice(0,19).replace('T',' '); })();
db.prepare(`INSERT INTO certificates(cert_no, worker_id, subject_id, score, issued_at, expire_at, status)
            VALUES(?,?,?,?,?,?, 'valid')`)
  .run(`GAP-BAN-00001-DEMO`, wIds[0], banSub, 78, daysAgo(350), soonExpire);

// 采收批次：白芍采收，王大山持证、赵敏缺证（演示校验警示+原因留痕）
const harvestDay = (() => { const d = new Date(Date.now() + 8*3600*1000 - 3*86400000); return d.toISOString().slice(0,10) + ' 10:30:00'; })();
const batchNo = 'HB' + harvestDay.slice(0, 10).replace(/-/g, '') + '01';
const batchId = db.prepare(`INSERT INTO harvest_batches(batch_no, base_id, plot_id, variety, harvest_time, remark, created_by)
                            VALUES(?,?,?,?,?,?,?)`)
  .run(batchNo, b1, plots1[0], '白芍', daysAgo(3), '随批记录，可供下游客户调阅',
    db.prepare("SELECT id FROM users WHERE username='admin1'").get().id).lastInsertRowid;
db.prepare(`INSERT INTO harvest_workers(batch_id, worker_id, certified, required_subject, reason)
            VALUES(?,?,?,?,?)`).run(batchId, wIds[0], 1, 'PEST;BAN;HARVEST_STD', null);
db.prepare(`INSERT INTO harvest_workers(batch_id, worker_id, certified, required_subject, reason)
            VALUES(?,?,?,?,?)`).run(batchId, wIds[3], 0, 'PEST;BAN;HARVEST_STD', '季节性抢收临时用工，已承诺一周内补训补考，技术员现场旁站监督');

// 通知
db.prepare(`INSERT INTO notifications(worker_id, title, body, type, ref_id)
            VALUES(?,?,?,?,?)`).run(wIds[0], '培训提醒：白芍采收与初加工标准培训', '2 天后 09:30 在东片区一号地田头举行，请准时参加', 'training', 0);
db.prepare(`INSERT INTO notifications(worker_id, title, body, type, ref_id)
            VALUES(?,?,?,?,?)`).run(wIds[3], '课程未完成提醒', '《农药安全使用与安全间隔期》课件尚未学完，学完方可报考', 'course', 0);

console.log('考试/证书/采收批次完成，种子数据就绪。');
