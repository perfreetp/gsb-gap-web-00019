// 演示数据初始化
const fs = require('fs');
const path = require('path');
const { db, now, hashPassword, audit } = require('./db');

const T = now();
const DAY = 86400000;

if (db.prepare('SELECT COUNT(*) c FROM bases').get().c > 0) {
  console.log('seed skipped (data exists)');
  process.exit(0);
}

const tx = db.transaction(() => {
  const insBase = db.prepare('INSERT INTO bases (name, created_at) VALUES (?,?)');
  const baseId = insBase.run('云岭中药材 GAP 种植基地', T).lastInsertRowid;

  const insCoop = db.prepare('INSERT INTO cooperatives (base_id, name) VALUES (?,?)');
  const coop1 = insCoop.run(baseId, '青山药农专业合作社').lastInsertRowid;
  const coop2 = insCoop.run(baseId, '黄柏沟种植合作社').lastInsertRowid;

  const insPlot = db.prepare(`INSERT INTO plots (base_id, cooperative_id, code, name, crop_variety, area_mu)
                              VALUES (?,?,?,?,?,?)`);
  const plots = [
    [coop1, 'P-01', '东坡育苗田', '三七', 12.5],
    [coop1, 'P-02', '东坡移栽区', '三七', 38.0],
    [coop2, 'P-03', '西梁黄柏林', '黄柏', 60.0],
    [coop2, 'P-04', '沟口采收田', '滇重楼', 18.2],
  ].map(p => insPlot.run(baseId, ...p, ).lastInsertRowid);

  // 科目
  const insSub = db.prepare(`INSERT INTO subjects (code, name, pesticide_safety, valid_months) VALUES (?,?,?,?)`);
  const subjects = [
    ['gap_general', 'GAP 规范总则', 0, 0],
    ['seedling', '育苗技术', 0, 0],
    ['transplant', '移栽技术', 0, 0],
    ['field_mgmt', '田间管理（除草施肥）', 0, 0],
    ['pesticide', '农药安全使用与间隔期', 1, 24],
    ['banned_pesticide', '禁用高毒农药识别', 1, 24],
    ['harvest_std', '采收与初加工标准', 0, 0],
    ['processing', '产地初加工', 0, 0],
    ['storage', '仓储养护', 0, 0],
  ];
  const subIds = subjects.map(s => insSub.run(...s).lastInsertRowid);
  const SID = Object.fromEntries(subjects.map((s, i) => [s[0], subIds[i]]));

  // 工种技能标签 -> 必需科目
  const insTag = db.prepare('INSERT INTO skill_tags (code, name, required_subject_ids) VALUES (?,?,?)');
  const tags = [
    ['seedling', '育苗工', ['gap_general', 'seedling']],
    ['transplant', '移栽工', ['gap_general', 'transplant']],
    ['weeding', '除草工', ['gap_general', 'field_mgmt']],
    ['fertilizing', '施肥工', ['gap_general', 'field_mgmt']],
    ['spraying', '植保打药工', ['gap_general', 'pesticide', 'banned_pesticide']],
    ['harvest', '采收工', ['gap_general', 'harvest_std']],
    ['processing', '初加工工', ['gap_general', 'harvest_std', 'processing']],
    ['storage', '仓储工', ['gap_general', 'storage']],
  ];
  const tagIds = tags.map(t => insTag.run(t[0], t[1], JSON.stringify(t[2].map(c => SID[c]))).lastInsertRowid);
  const TAG = Object.fromEntries(tags.map((t, i) => [t[0], tagIds[i]]));

  // 讲师
  const insTrainer = db.prepare('INSERT INTO trainers (name, title, phone) VALUES (?,?,?)');
  const trainer1 = insTrainer.run('周德厚', '高级农艺师', '13900001111').lastInsertRowid;
  const trainer2 = insTrainer.run('林慧敏', 'GAP 质量负责人', '13900001222').lastInsertRowid;

  // 人员台账
  const insPerson = db.prepare(`INSERT INTO people
    (base_id, name, id_card, phone, cooperative_id, plot_id, employment_type, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const roster = [
    ['张大山', '530102198503121234', '13811110001', coop1, plots[0], 'long_term', ['seedling']],
    ['李秀英', '530102198707234521', '13811110002', coop1, plots[0], 'long_term', ['seedling', 'transplant']],
    ['王建国', '530102199001153417', '13811110003', coop1, plots[1], 'long_term', ['transplant', 'weeding']],
    ['赵桂芳', '530102198211098826', '13811110004', coop1, plots[1], 'seasonal', ['weeding', 'fertilizing', 'harvest']],
    ['刘长贵', '530102197905276613', '13811110005', coop1, plots[1], 'seasonal', ['spraying']],
    ['陈美玲', '530102199212084425', '13811110006', coop2, plots[2], 'long_term', ['weeding', 'fertilizing']],
    ['杨有才', '530102198804192310', '13811110007', coop2, plots[2], 'long_term', ['spraying', 'harvest']],
    ['黄秋萍', '530102199509307742', '13811110008', coop2, plots[2], 'seasonal', ['harvest', 'processing']],
    ['周铁生', '530102197606115518', '13811110009', coop2, plots[3], 'long_term', ['harvest', 'processing', 'storage']],
    ['吴春燕', '53010219911225664X', '13811110010', coop2, plots[3], 'seasonal', ['processing', 'storage']],
    ['郑有福', '530102198403079931', '13811110011', coop1, plots[1], 'seasonal', ['weeding']],
    ['冯小兰', '530102199308142248', '13811110012', coop2, plots[3], 'seasonal', ['harvest']],
  ];
  const personIds = roster.map(r =>
    insPerson.run(baseId, r[0], r[1], r[2], r[3], r[4], r[5], T - 30 * DAY, T).lastInsertRowid);
  const insPS = db.prepare('INSERT OR IGNORE INTO person_skills (person_id, tag_id) VALUES (?,?)');
  roster.forEach((r, i) => r[6].forEach(tc => insPS.run(personIds[i], TAG[tc])));

  // 地块责任人
  db.prepare('UPDATE plots SET manager_id=? WHERE id=?').run(personIds[0], plots[0]);
  db.prepare('UPDATE plots SET manager_id=? WHERE id=?').run(personIds[6], plots[2]);

  // 课件
  const insCourse = db.prepare(`INSERT INTO courses (subject_id, title, type, duration_sec, content, created_at)
                                VALUES (?,?,?,?,?,?)`);
  const courses = [
    ['gap_general', '中药材 GAP 规范总则解读', 'doc', 0,
      '中药材生产质量管理规范（GAP）要求产地环境、种质、投入品、生产过程、采收加工全过程可追溯，记录至少保存五年。'],
    ['pesticide', '农药安全间隔期与科学用药', 'video', 900,
      '讲解安全间隔期概念：最后一次施药到采收的间隔天数。三七常用药剂间隔期多为 14-21 天，严禁超范围、超剂量用药。'],
    ['banned_pesticide', '禁限用高毒农药清单', 'doc', 0,
      '禁用：甲胺磷、对硫磷、甲基对硫磷、久效磷、磷胺、克百威、涕灭威、灭多威等 39 种；限用：甲拌磷、氧乐果等仅限特定作物。'],
    ['harvest_std', '中药材采收与加工标准', 'video', 720,
      '适期采收、避免机械损伤；净制去杂、按规格分级；干燥温度一般不超过 60℃，防止有效成分降解。'],
    ['storage', '中药材仓储养护要点', 'doc', 0,
      '库房温度≤30℃、相对湿度≤70%；离地离墙 10cm 以上；定期检查霉变、虫蛀，优先物理防治，严禁硫磺熏蒸。'],
    ['seedling', '三七育苗技术规范', 'video', 600, '种子精选消毒、苗床遮阴 70%、控水防根腐；起垄条播，覆土 1-2cm。'],
    ['transplant', '三七移栽操作规程', 'doc', 0, '一年生休眠芽移栽，行距 15cm、株距 12cm；蘸根消毒、浇透定根水。'],
    ['field_mgmt', '田间除草与施肥管理', 'video', 660, '人工除草为主、覆盖抑草；有机肥充分腐熟，测土配方、分期追肥。'],
    ['processing', '产地初加工规范', 'doc', 0, '清洗、趁鲜切制、干燥、包装标识；不同品种分开加工防混淆，记录批批可追溯。'],
  ];
  const courseIds = courses.map(c => insCourse.run(SID[c[0]], c[1], c[2], c[3], c[4], T).lastInsertRowid);
  const COURSE = Object.fromEntries(courses.map((c, i) => [c[1], courseIds[i]]));

  // 部分药农已学完部分课件
  const insProg = db.prepare(`INSERT INTO course_progress (person_id, course_id, watched_sec, completed, updated_at)
                              VALUES (?,?,?,?,?) ON CONFLICT(person_id, course_id) DO UPDATE SET
                              watched_sec=excluded.watched_sec, completed=excluded.completed, updated_at=excluded.updated_at`);
  // 前 6 名药农学完 GAP 总则；打药工学完两门农药课
  personIds.slice(0, 6).forEach(pid => insProg.run(pid, courseIds[0], 300, 1, T - 10 * DAY));
  [personIds[4], personIds[6]].forEach(pid => {
    insProg.run(pid, courseIds[0], 300, 1, T - 10 * DAY);
    insProg.run(pid, courseIds[1], 900, 1, T - 9 * DAY);
    insProg.run(pid, courseIds[2], 200, 1, T - 8 * DAY);
  });

  // 题库
  const insQ = db.prepare(`INSERT INTO question_bank
    (subject_id, variety, chapter, difficulty, type, stem, image_url, options, answer, analysis)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const O = a => JSON.stringify(a);
  const questions = [
    ['gap_general', null, '第一章 总则', 1, 'single', 'GAP 要求中药材生产记录至少保存几年？', null,
      O(['1 年', '2 年', '5 年', '永久保存']), O([2]), '规范要求批记录至少保存 5 年。'],
    ['gap_general', null, '第二章 质量管理', 1, 'judge', '中药材生产允许使用硫磺熏蒸以防虫防霉。', null,
      O(['正确', '错误']), O([1]), '硫磺熏蒸已被明令禁止。'],
    ['seedling', '三七', '第三章 育苗', 1, 'single', '三七育苗苗床遮阴度一般要求约为多少？', null,
      O(['30%', '50%', '70%', '95%']), O([2]), '三七喜阴，苗期遮阴约 70%。'],
    ['transplant', '三七', '第四章 移栽', 2, 'single', '三七移栽蘸根的主要目的是什么？', null,
      O(['增加肥料', '消毒防病、促进成活', '加速开花', '防止鼠害']), O([1]), '多菌灵等蘸根可防根腐。'],
    ['field_mgmt', null, '第五章 田间管理', 1, 'single', 'GAP 基地除草优先采用什么方式？', null,
      O(['化学除草剂全面喷施', '人工除草与覆盖抑草', '火烧', '不除草']), O([1]), '以农艺与人工措施为主。'],
    ['field_mgmt', null, '第五章 田间管理', 2, 'multi', '关于有机肥使用，正确的做法有哪些？', null,
      O(['必须充分腐熟', '可直接施用生粪', '测土配方分期追肥', '与化肥随意混施']), O([0, 2]), '生粪带菌烧根。'],
    ['pesticide', null, '第六章 投入品', 2, 'single', '“农药安全间隔期”指的是？', null,
      O(['两次喷药之间的时间', '最后一次施药到采收的间隔时间', '农药保质期', '拌种时间']), O([1]), '间隔期内禁止采收。'],
    ['pesticide', null, '第六章 投入品', 2, 'multi', '科学用药要求包括下列哪些？', null,
      O(['对症选药', '按登记范围与剂量使用', '采收前严格执行间隔期', '多种农药随意混用增效']),
      O([0, 1, 2]), '随意混用易产生药害与残留。'],
    ['pesticide', null, '第六章 投入品', 3, 'short', '简述发现作物临近采收但农药间隔期未满时应如何处理。', null,
      null, '停止采收，登记挂警示牌，待间隔期满并检测合格后再采收；上报技术员。', '关键：延期采收+标识+上报。'],
    ['banned_pesticide', null, '第六章 投入品', 1, 'single', '下列属于国家禁用高毒农药的是？', null,
      O(['苦参碱', '甲胺磷', '吡虫啉', '波尔多液']), O([1]), '甲胺磷为禁用高毒有机磷。'],
    ['banned_pesticide', null, '第六章 投入品', 2, 'multi', '下列属于禁用/严禁使用的农药有？', null,
      O(['克百威（呋喃丹）', '涕灭威', '久效磷', '苏云金杆菌(Bt)']), O([0, 1, 2]), 'Bt 为允许的生物农药。'],
    ['banned_pesticide', null, '第六章 投入品', 2, 'image', '根据农药标签识别：下图所示成分能否在中药材上使用？',
      '/assets/img/q-pesticide-label.svg', O(['可以使用', '禁止使用', '采收当天使用', '加倍剂量使用']),
      O([1]), '标签为禁用高毒农药成分。'],
    ['harvest_std', '三七', '第七章 采收', 1, 'single', '中药材干燥温度一般不宜超过？', null,
      O(['40℃', '60℃', '80℃', '100℃']), O([1]), '高温会破坏皂苷等有效成分。'],
    ['harvest_std', null, '第七章 采收', 1, 'judge', '不同品种中药材可以在同一场地同时加工以提高效率。', null,
      O(['正确', '错误']), O([1]), '应分开加工防止混淆与串味。'],
    ['harvest_std', '滇重楼', '第七章 采收', 3, 'short', '简述滇重楼采挖后初加工的主要步骤与注意事项。', null,
      null, '去净泥土与须根，除去残茎，洗净后晒干或低温烘干；防止机械损伤、霉变与品种混淆。',
      '净制→清洗→干燥→防混淆。'],
    ['processing', null, '第八章 初加工', 2, 'single', '产地初加工批记录的作用是？', null,
      O(['应付检查即可', '保证批次可追溯', '增加产量', '替代检验报告']), O([1]), '批批可追溯是 GAP 核心。'],
    ['storage', null, '第九章 仓储', 1, 'single', '中药材质储仓库相对湿度宜控制在多少以下？', null,
      O(['50%', '60%', '70%', '90%']), O([2]), '相对湿度≤70% 防霉蛀。'],
    ['storage', null, '第九章 仓储', 2, 'multi', '仓储养护正确的措施有哪些？', null,
      O(['离地离墙 10cm 以上', '定期检查霉变虫蛀', '发现虫害优先物理防治', '密闭库房从不通风']),
      O([0, 1, 2]), '应适时通风除湿。'],
  ];
  // q[7]/q[8] 已是 JSON 字符串（客观题）或纯文本（简答题参考答案），直接入库
  questions.forEach(q => insQ.run(SID[q[0]], q[1], q[2], q[3], q[4], q[5], q[6],
    q[7] || null, q[8], q[9]));

  // ---- 历史培训：GAP 总则，全员应到，2 人缺课 ----
  const insTrain = db.prepare(`INSERT INTO trainings
    (base_id, title, subject_id, tag_id, plot_id, location, trainer_id, start_at, duration_min, content, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const t0 = insTrain.run(baseId, 'GAP 规范总则年度培训', SID.gap_general, null, plots[0], '基地培训室',
    trainer2, T - 20 * DAY, 120, 'GAP 框架、记录与追溯要求', null, T - 22 * DAY).lastInsertRowid;
  const insAtt0 = db.prepare('INSERT OR IGNORE INTO training_attendees (training_id, person_id) VALUES (?,?)');
  personIds.forEach(pid => insAtt0.run(t0, pid));
  const insSign = db.prepare(`INSERT INTO attendance
    (training_id, person_id, method, proxy_user_id, client_event_id, signed_at, created_at)
    VALUES (?,?,?,?,?,?,?)`);
  personIds.slice(0, 10).forEach((pid, i) =>
    insSign.run(t0, pid, i < 8 ? 'scan' : 'proxy', null,
      i < 8 ? `seed-evt-t0-${i}` : null, T - 20 * DAY + 300000, T - 20 * DAY));
  const insFb = db.prepare('INSERT OR IGNORE INTO training_feedback (training_id, person_id, score) VALUES (?,?,?)');
  personIds.slice(0, 8).forEach((pid, i) => insFb.run(t0, pid, 4 + (i % 2)));

  // ---- 历史培训：农药安全，打药工应到全勤 ----
  const t1 = insTrain.run(baseId, '农药安全使用与禁用清单培训', SID.pesticide, TAG.spraying, plots[1],
    '西梁田头教学点', trainer1, T - 12 * DAY, 150, '安全间隔期、禁用清单、标签识别与防护', null, T - 14 * DAY).lastInsertRowid;
  [personIds[4], personIds[6]].forEach((pid, i) => {
    insAtt0.run(t1, pid);
    insSign.run(t1, pid, 'scan', null, `seed-evt-t1-${i}`, T - 12 * DAY + 240000, T - 12 * DAY);
    insFb.run(t1, pid, 5);
  });

  // ---- 即将开始：采收标准培训（定向采收工，应到名单用于缺课提醒）----
  insTrain.run(baseId, '秋季采收与初加工标准培训', SID.harvest_std, TAG.harvest, plots[3],
    '沟口采收田现场', trainer1, T + 3 * DAY, 180, '适期采收、干燥温度、分级与批记录', null, T - DAY);
});

tx();

// ---- 需要查询 ID 的数据 ----
const qid = {};
db.prepare("SELECT id, subject_id, type FROM question_bank").all().forEach(q => {
  (qid[q.subject_id] ||= {})[q.type] ? qid[q.subject_id][q.type].push(q.id) : (qid[q.subject_id][q.type] = [q.id]);
});
const subjIdByCode = id => db.prepare('SELECT id FROM subjects WHERE code=?').get(id).id;
const tagByCode = code => db.prepare('SELECT id FROM skill_tags WHERE code=?').get(code).id;
const plotsRows = db.prepare('SELECT id FROM plots ORDER BY id').all().map(r => r.id);
const people = db.prepare('SELECT id FROM people ORDER BY id').all().map(r => r.id);
const trainings = db.prepare('SELECT id FROM trainings ORDER BY id').all().map(r => r.id);
const baseId = db.prepare('SELECT id FROM bases ORDER BY id LIMIT 1').get().id;

const tx2 = db.transaction(() => {
  // 用户账号（先建，ID 自增为 1-4，供下方记录引用）
  const insUser = db.prepare(`INSERT INTO users (username, password_hash, role, base_id, person_id, name, created_at)
                              VALUES (?,?,?,?,?,?,?)`);
  const pw = hashPassword('123456');
  insUser.run('qiye', pw, 'enterprise', null, null, '企业质控-陈总', T);
  insUser.run('admin', pw, 'base_admin', baseId, null, '基地管理员-马国栋', T);
  insUser.run('tech', pw, 'tech', baseId, null, '技术指导员-孙文涛', T);
  insUser.run('farmer', pw, 'farmer', baseId, people[4], '刘长贵', T);

  // 已结束的农药安全考核：打药工 2 人（含一场已评阅，含申诉）
  const exam1 = db.prepare(`INSERT INTO exams
    (base_id, title, subject_id, variety, chapter, start_at, duration_min, pass_score, max_retakes,
     paper_question_count, require_course_completion, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(baseId, '农药安全使用考核（第一场）', subjIdByCode('pesticide'), null, '第六章 投入品',
      T - 11 * DAY, 45, 80, 1, 3, 1, 3, T - 13 * DAY).lastInsertRowid;
  const pestQs = [...qid[subjIdByCode('pesticide')].single, ...qid[subjIdByCode('pesticide')].multi,
    ...qid[subjIdByCode('pesticide')].short];
  db.prepare('INSERT INTO exam_papers (exam_id, version, question_ids) VALUES (?,?,?)')
    .run(exam1, 'A', JSON.stringify(pestQs));

  const insReg = db.prepare(`INSERT INTO exam_registrations
    (exam_id, person_id, attempt, paper_version, status, started_at, submitted_at, auto_submitted,
     objective_score, subjective_score, total_score, graded, client_event_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insAns = db.prepare(`INSERT INTO exam_answers (reg_id, question_id, answer, score, updated_at)
                             VALUES (?,?,?,?,?)`);
  const insGrade = db.prepare(`INSERT INTO answer_grades (answer_id, grader_id, score, comment, created_at)
                               VALUES (?,?,?,?,?)`);

  // 刘长贵：客观题 60 分满分、简答双评（8/10 平均 9）→ 85 合格
  const r1 = insReg.run(exam1, people[4], 0, 'A', 'graded', T - 11 * DAY, T - 11 * DAY + 40 * 60000, 0,
    60, 9, 85, 1, 'seed-reg-1').lastInsertRowid;
  pestQs.forEach((q, i) => {
    const qrow = db.prepare('SELECT type, answer FROM question_bank WHERE id=?').get(q);
    if (qrow.type === 'short') {
      const a = insAns.run(r1, q, '停止采收并挂警示牌，间隔期满、检测合格后再采，及时上报技术员。', 9, T - 11 * DAY).lastInsertRowid;
      insGrade.run(a, 3, 8, '要点基本完整', T - 11 * DAY + 3600000);
      insGrade.run(a, 2, 10, '表述规范', T - 11 * DAY + 3600000);
    } else {
      insAns.run(r1, q, qrow.answer, qrow.type === 'multi' ? 20 : 40, T - 11 * DAY);
    }
  });

  // 杨有才：客观全对 60，简答双评 5/7 平均 6 → 78 不合格（及格线 80），示范补考
  const r2 = insReg.run(exam1, people[6], 0, 'A', 'graded', T - 11 * DAY, T - 11 * DAY + 44 * 60000, 1,
    60, 6, 78, 1, 'seed-reg-2').lastInsertRowid;
  pestQs.forEach(q => {
    const qrow = db.prepare('SELECT type, answer FROM question_bank WHERE id=?').get(q);
    if (qrow.type === 'short') {
      const a = insAns.run(r2, q, '先不采，问问技术员再说。', 6, T - 11 * DAY).lastInsertRowid;
      insGrade.run(a, 3, 5, '缺少标识与检测环节', T - 11 * DAY + 3600000);
      insGrade.run(a, 2, 7, '方向正确', T - 11 * DAY + 3600000);
    } else {
      insAns.run(r2, q, qrow.answer, qrow.type === 'multi' ? 20 : 40, T - 11 * DAY);
    }
  });
  db.prepare(`INSERT INTO appeals (reg_id, reason, status, reply, reviewer_id, created_at, reviewed_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(r2, '我认为简答题给分偏低，现场就是按技术员要求做的。', 'adjusted',
      '复核维持原评分标准，分数调整为 78，仍低于及格线 80，可参加补考。', 3, T - 10 * DAY, T - 9 * DAY);

  // 即将开考的采收标准考核
  const exam2 = db.prepare(`INSERT INTO exams
    (base_id, title, subject_id, variety, chapter, start_at, duration_min, pass_score, max_retakes,
     paper_question_count, require_course_completion, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(baseId, '秋季采收与初加工标准考核', subjIdByCode('harvest_std'), '三七', '第七章 采收',
      T + 4 * DAY, 40, 60, 2, 5, 0, 3, T - DAY).lastInsertRowid;
  const hvSingle = qid[subjIdByCode('harvest_std')].single[0];
  const hvJudge = qid[subjIdByCode('harvest_std')].judge[0];
  const hvShort = qid[subjIdByCode('harvest_std')].short[0];
  db.prepare('INSERT INTO exam_papers (exam_id, version, question_ids) VALUES (?,?,?)')
    .run(exam2, 'A', JSON.stringify([hvSingle, hvJudge, hvShort]));
  db.prepare('INSERT INTO exam_papers (exam_id, version, question_ids) VALUES (?,?,?)')
    .run(exam2, 'B', JSON.stringify([hvJudge, hvSingle, hvShort]));
  // 赵桂芳、冯小兰已报名
  const insReg2 = db.prepare(`INSERT INTO exam_registrations
    (exam_id, person_id, attempt, paper_version, status, client_event_id) VALUES (?,?,?,?,'registered',?)`);
  insReg2.run(exam2, people[3], 0, 'A', 'seed-reg-3');
  insReg2.run(exam2, people[11], 0, 'B', 'seed-reg-4');

  // 证书：刘长贵（农药安全，24 个月有效）；周铁生/黄秋萍（采收标准，长期）
  const certNo = (code, pid) => `GAP-${code.toUpperCase()}-${String(pid).padStart(4, '0')}-${String(T).slice(-6)}`;
  const insCert = db.prepare(`INSERT INTO certificates
    (person_id, subject_id, exam_id, reg_id, cert_no, score, issued_at, valid_until)
    VALUES (?,?,?,?,?,?,?,?)`);
  const pestSubj = subjIdByCode('pesticide');
  const hvSubj = subjIdByCode('harvest_std');
  insCert.run(people[4], pestSubj, exam1, r1, certNo('PS', people[4]), 85, T - 9 * DAY, T - 9 * DAY + 730 * DAY);
  // 历史采收证书（直接造 exam/reg 记录较重，采用同 exam1 关联不合语义，另建内部结业 exam）
  const examOld = db.prepare(`INSERT INTO exams
    (base_id, title, subject_id, variety, chapter, start_at, duration_min, pass_score, max_retakes,
     paper_question_count, require_course_completion, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(baseId, '上年度采收标准结业考核', hvSubj, null, '第七章 采收',
      T - 200 * DAY, 40, 60, 1, 3, 0, 3, T - 202 * DAY).lastInsertRowid;
  const gapSubj = subjIdByCode('gap_general');
  const examGap = db.prepare(`INSERT INTO exams
    (base_id, title, subject_id, variety, chapter, start_at, duration_min, pass_score, max_retakes,
     paper_question_count, require_course_completion, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(baseId, '上年度 GAP 总则结业考核', gapSubj, null, '第一章 总则',
      T - 210 * DAY, 30, 60, 1, 2, 0, 3, T - 212 * DAY).lastInsertRowid;
  [people[8], people[7]].forEach((pid, i) => {
    const rr = db.prepare(`INSERT INTO exam_registrations
      (exam_id, person_id, attempt, paper_version, status, started_at, submitted_at, graded, total_score)
      VALUES (?,?,?,?,'graded',?,?,1,?)`)
      .run(examOld, pid, 0, 'A', T - 200 * DAY, T - 200 * DAY + 35 * 60000, i === 0 ? 90 : 76).lastInsertRowid;
    insCert.run(pid, hvSubj, examOld, rr, certNo('HV', pid), i === 0 ? 90 : 76, T - 199 * DAY, null);
    const rg = db.prepare(`INSERT INTO exam_registrations
      (exam_id, person_id, attempt, paper_version, status, started_at, submitted_at, graded, total_score)
      VALUES (?,?,?,?,'graded',?,?,1,?)`)
      .run(examGap, pid, 0, 'A', T - 210 * DAY, T - 210 * DAY + 25 * 60000, i === 0 ? 95 : 82).lastInsertRowid;
    insCert.run(pid, gapSubj, examGap, rg, certNo('GAP', pid), i === 0 ? 95 : 82, T - 209 * DAY, null);
  });

  // 采收批次：沟口地块，1 名无证人员（冯小兰）填原因留痕
  const batch = db.prepare(`INSERT INTO harvest_batches
    (base_id, plot_id, batch_no, variety, harvested_at, created_by, created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(baseId, plotsRows[3], 'HV20260901-03', '滇重楼', T - 2 * DAY, 1, T - 2 * DAY).lastInsertRowid;
  const insHW = db.prepare(`INSERT INTO harvest_workers (batch_id, person_id, tag_id, certified, warning_reason)
                            VALUES (?,?,?,?,?)`);
  insHW.run(batch, people[8], tagByCode('harvest'), 1, null);   // 周铁生 有证
  insHW.run(batch, people[7], tagByCode('processing'), 1, null); // 黄秋萍 有采收证
  insHW.run(batch, people[11], tagByCode('harvest'), 0,
    '该采收工证书考核待考（4 天后开考），本次仅承担搬运辅助，已由周铁生现场带教。');

  // 通知
  const insN = db.prepare(`INSERT INTO notifications (user_id, base_id, person_id, type, title, body, ref_type, ref_id, created_at)
                           VALUES (?,?,?,?,?,?,?,?,?)`);
  insN.run(null, baseId, people[10], 'training_absent', '缺课提醒：GAP 规范总则年度培训',
    '系统记录您缺席了本场培训，请联系技术员安排补训。', 'training', trainings[0], T - 20 * DAY + 2 * 3600000);
  insN.run(null, baseId, people[11], 'training_absent', '缺课提醒：GAP 规范总则年度培训',
    '系统记录您缺席了本场培训，请联系技术员安排补训。', 'training', trainings[0], T - 20 * DAY + 2 * 3600000);
  insN.run(null, baseId, people[6], 'exam_fail', '考核结果：农药安全使用考核（第一场）',
    '您的成绩为 78 分，未达及格线 80 分，可参加补考。', 'exam', exam1, T - 9 * DAY);
  insN.run(null, baseId, people[6], 'appeal_result', '申诉复核结果',
    '您的成绩申诉已复核：维持评分标准，可参加补考。', 'appeal', r2, T - 9 * DAY);
  insN.run(null, baseId, people[4], 'training_notice', '培训通知：秋季采收与初加工标准培训',
    '培训将于 3 天后在沟口采收田开展，请提前安排时间并扫码签到。', 'training', trainings[2], T - DAY);

  audit({ id: 1, name: '系统初始化' }, 'seed', 'system', null, { demo: true });
});
tx2();

console.log('seed done');
