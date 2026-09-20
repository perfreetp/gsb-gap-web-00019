async function renderExams() {
  if (!state.org) state.org = await api('/api/org');
  const { list } = await api('/api/exams');
  document.getElementById('content').innerHTML = `
  <div class="toolbar"><div class="grow"></div>
    <button class="btn" id="ex-qbank">题库管理</button>
    <button class="btn" id="ex-paper">纸质成绩回录</button>
    <button class="btn primary" id="ex-add">＋ 组织考试</button>
  </div>
  <div class="panel"><div class="tbl-wrap"><table><thead><tr>
    <th>考试名称</th><th>科目/品种</th><th>开考时间</th><th>时长</th><th>及格线</th><th>补考</th><th>合格/参考</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>${list.map(e=>`<tr>
      <td><b>${esc(e.title)}</b></td><td>${esc(e.subject_name)}${e.variety?' · '+esc(e.variety):''}</td>
      <td>${fmtDate(e.start_time)}</td><td>${e.duration_min} 分钟</td><td>${e.pass_score} 分</td><td>${e.max_retakes} 次</td>
      <td>${e.passed_count}/${e.attempt_count}</td>
      <td><span class="badge-dot ${e.status==='finished'?'dot-gray':'dot-green'}">${e.status==='finished'?'已结束':'进行中'}</span></td>
      <td style="white-space:nowrap">
        <button class="btn sm" onclick="previewPapers(${e.id})">A/B 卷</button>
        <button class="btn sm" onclick="examAttempts(${e.id})">成绩</button>
      </td></tr>`).join('')}</tbody></table></div></div>`;
  document.getElementById('ex-add').onclick = examForm;
  document.getElementById('ex-qbank').onclick = qbankPage;
  document.getElementById('ex-paper').onclick = paperScoreDlg;
}

function examForm() {
  const { subjects } = state.org;
  const types = [['single','单选题'],['multi','多选题'],['judge','判断题'],['image','识图题'],['short','简答题']];
  modal('组织考试（按品种/章节/难度抽题，自动生成 A/B 卷）', `
  <div class="form-grid">
    <label class="full">考试名称 *<input id="e-title" placeholder="如：农药安全使用考核（白芍）"></label>
    <label>科目 *<select id="e-subject">${subjects.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
    <label>药材品种<input id="e-variety" placeholder="如 白芍 / 黄芪，可空"></label>
    <label>开考时间 *<input id="e-start" type="datetime-local"></label>
    <label>考试时长(分钟) *<input id="e-dur" type="number" value="45"></label>
    <label>及格线 *<input id="e-pass" type="number" value="60"></label>
    <label>允许补考次数<input id="e-retake" type="number" value="1"></label>
  </div>
  <h3 style="margin:14px 0 8px;font-size:13px">抽题蓝图（题型 / 数量 / 每题分值）</h3>
  <table><thead><tr><th>题型</th><th>抽题数</th><th>每题分</th><th></th></tr></thead><tbody id="bp-body">
    ${types.map(([code,name],i)=>`<tr>
      <td>${name}</td><td><input type="number" min="0" value="${[2,1,1,1,1][i]}" data-bp="${code}" style="width:70px"></td>
      <td><input type="number" min="0" value="${[10,15,5,15,15][i]}" data-ps="${code}" style="width:70px"></td>
      <td class="muted">识图/简答交技术员评阅，可双评</td></tr>`).join('')}
  </tbody></table>
  <p class="muted" style="margin-top:8px">系统从题库随机抽题，分别生成题目顺序不同的 A、B 卷；同科课件未学完的药农无法开考。`,
  {wide:true,footer:[{text:'取消'},{text:'发布并生成 A/B 卷',cls:'primary',onClick:async({body})=>{
    const types2 = ['single','multi','judge','image','short'];
    const bp = types2.map(t=>({type:t,count:Number(body.querySelector(`[data-bp="${t}"]`).value)||0,score:Number(body.querySelector(`[data-ps="${t}"]`).value)||0}))
      .filter(x=>x.count>0);
    const total = bp.reduce((a,b)=>a+b.count*b.score,0);
    if(total!==100 && !confirm(`当前卷面总分 ${total}（通常为 100），确认继续？`)) return false;
    const payload = {
      title: body.querySelector('#e-title').value.trim(),
      subject_id: body.querySelector('#e-subject').value,
      variety: body.querySelector('#e-variety').value.trim(),
      start_time: body.querySelector('#e-start').value.replace('T',' '),
      duration_min: Number(body.querySelector('#e-dur').value),
      pass_score: Number(body.querySelector('#e-pass').value),
      max_retakes: Number(body.querySelector('#e-retake').value),
      blueprint: bp,
    };
    if(!payload.title||!payload.start_time) throw new Error('名称与开考时间必填');
    await api('/api/exams',{method:'POST',body:payload});
    toast('考试已发布，A/B 卷已生成','ok'); renderExams();
  }}]});
}

async function previewPapers(id) {
  const { papers } = await api(`/api/exams/${id}/papers`);
  modal('A/B 卷预览', `
    <p class="muted" style="margin-bottom:10px">同一场次两套试卷题目顺序不同，防止邻座抄袭。</p>
    ${papers.map(p=>`<div class="panel"><h3>${p.version} 卷 <span class="tag">满分 ${p.total_score} · ${p.questions.length} 题</span></h3>
      ${p.questions.map((q,i)=>`<p style="padding:4px 0;font-size:13px">${i+1}. [${typeName(q.type)} ${q.paper_score}分] ${esc(q.stem)}</p>`).join('')}
    </div>`).join('')}`,{wide:true,footer:[{text:'关闭'}]});
}

async function examAttempts(id) {
  const { exam, list } = await api(`/api/exams/${id}/attempts`);
  const stName = { ongoing: '进行中', submitted: '待评阅', graded: '已出分', absent: '缺考' };
  modal(`成绩明细 · ${exam.title}`, `
  <p class="muted" style="margin-bottom:8px">及格线 ${exam.pass_score} · 时长 ${exam.duration_min} 分钟 · 允许补考 ${exam.max_retakes} 次 · A/B 卷随机分配</p>
  <div class="tbl-wrap"><table><tr><th>药农</th><th>卷型</th><th>第几次</th><th>客观</th><th>主观</th><th>总分</th><th>结果</th><th>来源</th><th>申诉</th></tr>
  ${list.map(a=>`<tr><td>${esc(a.worker_name)}</td><td>${a.version}</td><td>${a.attempt_no}</td>
    <td>${a.objective_score ?? '—'}</td><td>${a.subjective_score ?? (a.status==='submitted'?'评阅中':'—')}</td>
    <td><b>${a.total_score ?? '—'}</b></td>
    <td>${a.status==='graded' ? (a.passed?'<span class="badge-dot dot-green">合格</span>':'<span class="badge-dot dot-red">不合格</span>') : `<span class="badge-dot dot-amber">${stName[a.status]}</span>`}</td>
    <td>${a.source==='paper'?'纸质回录':'手机在线'}</td>
    <td>${a.appeal_status ? ({pending:'<span class="badge-dot dot-amber">待复核</span>',approved:'<span class="badge-dot dot-green">成立</span>',rejected:'驳回'})[a.appeal_status] : '—'}</td></tr>`).join('')}
  </table></div>
  <p style="margin-top:10px"><button class="btn" onclick="document.getElementById('modal-x').click();go('review')">前往评阅/申诉处理</button></p>`,
  {wide:true,footer:[{text:'关闭'}]});
}

function paperScoreDlg() {
  const workers = [];
  modal('纸质卷成绩回录', `
  <p class="muted">适用于线下纸质考试：录入成绩后系统同样判定及格、发证并记入档案与审计。</p>
  <div class="form-grid" style="margin-top:10px">
    <label>选择考试<select id="ps-exam"></select></label>
    <label>药农<select id="ps-worker"></select></label>
    <label>卷面版本<select id="ps-ver"><option>A</option><option>B</option></select></label>
    <label>总分<input id="ps-score" type="number" placeholder="0-100"></label>
  </div><div id="ps-msg"></div>`,
  {footer:[{text:'取消'},{text:'回录成绩',cls:'primary',onClick:async({body})=>{
    const exam_id = body.querySelector('#ps-exam').value;
    const r = await api(`/api/exams/${exam_id}/paper-score`,{method:'POST',body:{
      worker_id: Number(body.querySelector('#ps-worker').value),
      total_score: Number(body.querySelector('#ps-score').value),
      paper_version: body.querySelector('#ps-ver').value,
    }});
    body.querySelector('#ps-msg').innerHTML = r.passed
      ? '<p class="badge-dot dot-green" style="margin-top:10px">成绩合格，电子合格证已生成</p>'
      : '<p class="badge-dot dot-red" style="margin-top:10px">成绩未达及格线，可参加补考</p>';
    toast('纸质成绩已回录','ok');
    return false;
  }}]});
  (async()=>{
    const [{list:exs},{list:wks}] = await Promise.all([api('/api/exams'),api('/api/workers')]);
    const exSel = document.querySelector('#ps-exam'); const wSel = document.querySelector('#ps-worker');
    exSel.innerHTML = exs.map(x=>`<option value="${x.id}">${esc(x.title)}</option>`).join('');
    wSel.innerHTML = wks.map(x=>`<option value="${x.id}">${esc(x.name)}（${esc(x.coop_name||'')}）</option>`).join('');
  })();
}

async function qbankPage() {
  const { subjects } = state.org;
  const { list } = await api('/api/questions');
  const typeColor = {single:'dot-blue',multi:'dot-green',judge:'dot-gray',image:'dot-amber',short:'dot-red'};
  modal(`题库管理（${list.length} 题）`, `
  <div class="toolbar"><div class="grow"></div><button class="btn primary" id="qb-add">＋ 新增题目</button></div>
  <div class="tbl-wrap"><table><thead><tr><th>科目</th><th>题型</th><th>难度</th><th>题干</th><th>分值</th></tr></thead>
  <tbody>${list.map(q=>`<tr><td>${esc(q.subject_name)}</td><td><span class="badge-dot ${typeColor[q.type]}">${typeName(q.type)}</span></td>
    <td>${diffName(q.difficulty)}</td><td style="max-width:340px">${esc(q.stem)}</td><td>${q.score}</td></tr>`).join('')}</tbody></table></div>`,
  {wide:true,footer:[{text:'关闭'}]});
  setTimeout(()=>document.getElementById('qb-add').onclick = questionForm,0);
}

function questionForm() {
  const { subjects } = state.org;
  modal('新增题目', `
  <div class="form-grid">
    <label>科目<select id="q-subject">${subjects.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
    <label>题型<select id="q-type"><option value="single">单选</option><option value="multi">多选</option><option value="judge">判断</option><option value="image">识图</option><option value="short">简答</option></select></label>
    <label>难度<select id="q-diff"><option value="1">易</option><option value="2" selected>中</option><option value="3">难</option></select></label>
    <label>品种(可空)<input id="q-variety" placeholder="白芍/黄芪"></label>
    <label>章节<input id="q-chapter" placeholder="如 第3章"></label>
    <label>分值<input id="q-score" type="number" value="10"></label>
    <label class="full">题干 *<textarea id="q-stem" rows="2"></textarea></label>
    <label class="full">选项（每行一个，仅选择题填写）<textarea id="q-options" rows="4" placeholder="选项A&#10;选项B&#10;选项C"></textarea></label>
    <label class="full">参考答案（选择填 A / A,B,C；判断填 T/F；识图填正确项；简答填评分要点）<textarea id="q-answer" rows="2"></textarea></label>
  </div>`,{footer:[{text:'取消'},{text:'保存',cls:'primary',onClick:async({body})=>{
    const optsText = body.querySelector('#q-options').value.trim();
    await api('/api/questions',{method:'POST',body:{
      subject_id:Number(body.querySelector('#q-subject').value),
      type:body.querySelector('#q-type').value,
      difficulty:Number(body.querySelector('#q-diff').value),
      variety:body.querySelector('#q-variety').value || null,
      chapter:body.querySelector('#q-chapter').value || null,
      score:Number(body.querySelector('#q-score').value),
      stem:body.querySelector('#q-stem').value.trim(),
      options: optsText ? optsText.split('\n').map(s=>s.trim()).filter(Boolean) : null,
      answer: body.querySelector('#q-answer').value.trim(),
    }});
    toast('题目已入库','ok'); qbankPage();
  }}]});
}
window.previewPapers = previewPapers;
window.examAttempts = examAttempts;
