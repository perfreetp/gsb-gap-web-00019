const puppeteer = require('puppeteer-core');
const CHROME = '/usr/bin/google-chrome';
let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg); } };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    userDataDir: '/tmp/gap-puppeteer-' + Date.now(),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-zygote'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('dialog', async d => { try { await d.accept(); } catch (e) {} });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // 管理员登录
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('#login-form button[type=submit]');
  await page.evaluate(() => document.querySelector('#login-form button[type=submit]').click());
  await page.waitForSelector('#app-view:not(.hidden)', { timeout: 5000 });
  assert(true, 'admin login renders app');
  await page.waitForFunction(() => document.querySelector('#view .stat'), { timeout: 5000 });
  assert((await page.$$('#view .stat')).length >= 4, 'dashboard stats rendered');

  // 遍历所有导航页面，确保无 JS 报错
  const navKeys = await page.$$eval('#nav .nav-item', els => els.map(e => e.dataset.key));
  console.log('  nav pages:', navKeys.join(','));
  const titleMap = { dashboard: '工作台', people: '人员台账', trainings: '培训场次', courses: '课程内容库',
    exams: '考核管理', grading: '评阅与申诉', certificates: '培训合格证', harvest: '采收登记',
    stats: '统计分析', audit: '审计日志' };
  for (const key of navKeys) {
    await page.waitForSelector(`.nav-item[data-key="${key}"]`);
    await page.evaluate(k => document.querySelector(`.nav-item[data-key="${k}"]`).click(), key);
    await page.waitForFunction((t) => document.querySelector('#page-title').textContent === t,
      { timeout: 6000 }, titleMap[key]);
    await new Promise(r => setTimeout(r, 300));
  }
  // 人员页
  await page.evaluate(() => document.querySelector('.nav-item[data-key="people"]').click());
  await page.waitForFunction(() => document.querySelector('#page-title').textContent === '人员台账');
  await page.waitForSelector('#view table', { timeout: 5000 });
  const peopleRows = await page.$$eval('#view tbody tr', t => t.length);
  assert(peopleRows >= 12, `roster lists ${peopleRows} people`);
  await page.type('#view #q', '刘长贵');
  await page.click('#view #search');
  await new Promise(r => setTimeout(r, 400));
  assert((await page.$$eval('#view tbody tr', t => t.length)) === 1, 'search filters by name');

  // 培训页
  await page.evaluate(() => document.querySelector('.nav-item[data-key="trainings"]').click());
  await page.waitForFunction(() => document.querySelector('#page-title').textContent === '培训场次');
  await new Promise(r => setTimeout(r, 500));
  assert((await page.$$('#view [data-detail]')).length >= 3, 'training sessions listed');
  await page.evaluate(() => document.querySelector('#view [data-detail="1"]').click());
  await page.waitForSelector('.modal', { timeout: 3000 });
  const absentText = await page.$eval('.modal', el => el.textContent);
  assert(/缺课\s*2/.test(absentText.replace(/\s/g, ' ')), 'past training shows 2 absent');
  await page.click('.modal #close');
  await new Promise(r => setTimeout(r, 300));

  // 审计页
  await page.evaluate(() => document.querySelector('.nav-item[data-key="audit"]').click());
  await page.waitForFunction(() => document.querySelector('#page-title').textContent === '审计日志');
  await new Promise(r => setTimeout(r, 500));
  const auditRows = await page.$$eval('#view tbody tr', t => t.length);
  assert(auditRows > 0, `audit log has ${auditRows} entries`);

  // 证书页
  await page.evaluate(() => document.querySelector('.nav-item[data-key="certificates"]').click());
  await page.waitForFunction(() => document.querySelector('#page-title').textContent === '培训合格证');
  await new Promise(r => setTimeout(r, 500));
  assert((await page.$$('#view .cert')).length >= 3, 'certificates rendered');

  // 采收页
  await page.evaluate(() => document.querySelector('.nav-item[data-key="harvest"]').click());
  await page.waitForFunction(() => document.querySelector('#page-title').textContent === '采收登记');
  await new Promise(r => setTimeout(r, 500));
  await page.evaluate(() => document.querySelector('#view [data-view="1"]').click());
  await page.waitForSelector('.modal', { timeout: 3000 });
  const trace = await page.$eval('.modal', el => el.textContent);
  assert(trace.includes('未持证') && trace.includes('考核待考'), 'batch trace shows warning reason');
  await page.click('.modal #close');

  // 切换药农
  await page.click('#logout');
  await page.waitForSelector('#login-view:not(.hidden)');
  await page.evaluate(() => { document.querySelector('input[name=username]').value = 'farmer';
    document.querySelector('input[name=password]').value = '123456'; });
  await page.click('button[type=submit]');
  await page.waitForSelector('#app-view:not(.hidden)');
  await new Promise(r => setTimeout(r, 600));
  assert(true, 'farmer login');
  const farmerNav = await page.$$eval('#nav .nav-item', els => els.map(e => e.dataset.key));
  assert(!farmerNav.includes('audit') && !farmerNav.includes('harvest'), 'farmer RBAC hides admin menus');

  // 药农课程页
  await page.evaluate(() => document.querySelector('.nav-item[data-key="courses"]').click());
  await page.waitForFunction(() => document.querySelector('#page-title').textContent === '课程内容库');
  await page.waitForSelector('#view .qa-box', { timeout: 5000 });
  assert((await page.$$('#view .qa-box')).length >= 5, 'course library visible to farmer');

  // 药农证书只见本人
  await page.evaluate(() => document.querySelector('.nav-item[data-key="certificates"]').click());
  await page.waitForFunction(() => document.querySelector('#page-title').textContent === '培训合格证');
  await page.waitForSelector('#view .cert', { timeout: 5000 });
  const certNames = await page.$$eval('#view .cert dd b', els => [...new Set(els.map(e => e.textContent))]);
  assert(certNames.length === 1 && certNames[0] === '刘长贵', `farmer only sees own certs: ${certNames}`);

  // 药农考核：进入已报名的未来采收考试，答题交卷
  await page.evaluate(() => document.querySelector('.nav-item[data-key="exams"]').click());
  await page.waitForFunction(() => document.querySelector('#page-title').textContent === '考核管理');
  await page.waitForSelector('#view .qa-box', { timeout: 5000 });
  // 只选“未开考”的未来场次（避免进入历史已评阅场次）
  let card = await page.$$eval('#view .qa-box', els => els.find(el => el.textContent.includes('未开考')));
  const startSel = '#view .qa-box';
  let startBtn = await page.evaluateHandle(() => {
    const box = [...document.querySelectorAll('#view .qa-box')].find(el => el.textContent.includes('未开考'));
    return box?.querySelector('[data-start]') || box?.querySelector('[data-register]');
  });
  let isRegister = await page.evaluate(el => el?.hasAttribute('data-register'), startBtn);
  assert(!!startBtn, 'future exam has action button');
  if (isRegister) {
    await page.evaluate(el => el.click(), startBtn);
    await page.waitForSelector('#view .qa-box [data-start]', { timeout: 5000 });
  }
  {
    await page.evaluate(() => {
      const box = [...document.querySelectorAll('#view .qa-box')].find(el => el.textContent.includes('未开考'));
      box.querySelector('[data-start]').click();
    });
    await page.waitForSelector('#view .qa-box .stem', { timeout: 4000 });
    const qCount = await page.$$eval('#view .qa-box', els => els.length);
    assert(qCount >= 3, `exam runner shows ${qCount} questions`);
    // 作答所有客观题（change 事件触发立即保存）
    const qas = await page.$$('#view .qa-box');
    for (const qa of qas) {
      const ta = await qa.$('textarea');
      if (ta) await ta.type('适期采挖，净制去杂，低温干燥，防止混淆与霉变。');
      else await qa.evaluate(el => { const inp = el.querySelector('.opt input'); if (inp) inp.click(); });
    }
    try {
      await page.waitForFunction(() => /已自动保存/.test(document.querySelector('#save-state').textContent),
        { timeout: 8000, polling: 300 });
    } catch (e) {
      console.log('DEBUG view:', (await page.$eval('#view', el => el.innerText)).slice(0, 300));
      console.log('DEBUG save-state:', await page.$('#save-state') ? await page.$eval('#save-state', el => el.textContent) : 'MISSING');
      console.log('DEBUG checked:', await page.$$eval('#view .opt input:checked', els => els.length));
      console.log('DEBUG textarea val len:', await page.$eval('#view textarea', el => el.value.length).catch(() => 'no-ta'));
    }
    // 刷新页面验证断线续考恢复
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#app-view:not(.hidden)');
    await page.evaluate(() => document.querySelector('.nav-item[data-key="exams"]').click());
    await page.waitForFunction(() => document.querySelector('#page-title').textContent === '考核管理');
    await page.waitForSelector('#view .qa-box [data-start]', { timeout: 5000 });
    await page.evaluate(() => {
      const box = [...document.querySelectorAll('#view .qa-box')].find(el => el.textContent.includes('未开考'));
      box.querySelector('[data-start]').click();
    });
    await page.waitForSelector('#view .qa-box .stem', { timeout: 5000 });
    await new Promise(r => setTimeout(r, 400));
    const restored = await page.$$eval('#view .opt input:checked', els => els.length);
    assert(restored >= 1, `resume restored ${restored} answered objective questions`);
    // 交卷（绕过 confirm 弹窗，直接调用交卷逻辑）
    await page.evaluate(() => window.__gapDoSubmit());
    await new Promise(r => setTimeout(r, 1500));
    let resultVisible = false, modalText = '', viewText = '';
    try {
      await page.waitForFunction(() => document.querySelector('#modal-root').textContent.includes('考核结果'), { timeout: 6000, polling: 200 });
      resultVisible = true;
    } catch (e) {
      modalText = (await page.$eval('#modal-root', el => el.textContent).catch(() => '')).slice(0, 200);
      viewText = (await page.$eval('#view', el => el.innerText).catch(() => '')).slice(0, 200);
    }
    assert(resultVisible, 'submit shows result modal | modal:' + modalText + ' | view:' + viewText);
  }

  const seriousErrors = errors.filter(e => !/favicon|Failed to load resource/i.test(e));
  if (seriousErrors.length) {
    console.log('BROWSER ERRORS:\n' + seriousErrors.slice(0, 10).join('\n'));
    fail += seriousErrors.length;
  } else console.log('  no browser JS errors');

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
