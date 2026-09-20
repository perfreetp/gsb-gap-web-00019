let examTimer = null;
async function renderExamEntry() {
  const { list } = await api('/api/exams/my');
  document.getElementById('content').innerHTML = `
  <div class="panel" style="background:#f7fbf8"><h3>我的考试</h3>
    <p class="muted">同一考场采用 A/B 卷，可手机答题；异常退出可断线续考，计时不暂停，超时自动交卷。识图与简答题由技术员评阅。</p></div>
  ${list.map(e => {
    const finished = e.status === 'finished' || e.attempts.some(a=>a.status==='graded');
    const ongoing = e.attempts.find(a=>a.status==='ongoing');
    const best = e.attempts.filter(a=>a.total_score!=null).sort((a,b)=>b.total_score-a.total_score)[0];
    return `<div class="panel"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div><b>${esc(e.title)}</b>
        <div class="muted" style="margin-top:4px">${esc(e.subject_name)} · 开考 ${fmtDate(e.start_time)} · ${e.duration_min} 分钟 · 及格 ${e.pass_score} 分 · 允许补考 ${e.max_retakes} 次</div></div>
      <div style="text-align:right">
        ${ongoing ? '<button class="btn primary" onclick="startExam('+e.id+')">断线续考（继续答题）</button>'
          : e.eligible ? `<button class="btn primary" onclick="startExam(${e.id})">${e.attempts.length?'再次考试/补考':'进入考试'}</button>`
          : '<button class="btn" disabled>课件未学完，不可报考</button>'}
      </div></div>
      ${e.attempts.length ? `<div style="margin-top:10px">${e.attempts.map(a=>`
        <span class="badge-dot ${a.passed?'dot-green':a.total_score==null?'dot-amber':'dot-red'}" style="margin-right:6px">
          第${a.attempt_no}次：${a.total_score!=null?a.total_score+' 分 '+(a.passed?'合格':'不合格'):a.status==='submitted'?'待评阅':'进行中'}
          ${a.source==='paper'?'（纸质）':''} ${a.passed?'':''}
        </span>`).join('')}
        ${best?`<button class="btn sm" onclick="appealDlg(${best.id})" style="margin-left:8px">对成绩申诉</button>`:''}
      </div>` : `<p class="muted" style="margin-top:8px">学习进度：${e.course_done}/${e.course_total} 个课件已完成${e.eligible?'，已具备报考资格':''}</p>`}
    </div>`;
  }).join('') || '<div class="empty">暂无考试安排</div>'}`;
}

async function startExam(examId) {
  let data;
  try { data = await api(`/api/exams/${examId}/start`, { method: 'POST', body: { client_nonce: localStorage.getItem('exam_'+examId) || (localStorage.setItem('exam_'+examId, crypto.randomUUID()), localStorage.getItem('exam_'+examId)) } }); }
  catch (e) { return toast(e.message, 'err'); }
  if (data.attempt.status === 'graded') { renderAttemptResult(data.attempt.id); return; }
  const answers = { ...data.saved };
  const m = modal(`考试中 · ${data.attempt.version} 卷（第 ${data.attempt.attempt_no} 次）`, `
    <div class="muted" style="margin-bottom:10px">${data.resumed?'<span class="badge-dot dot-amber">已恢复断线前的作答</span>':'计时已开始'} · 交卷后客观题即时判分，识图/简答待评阅</div>
    <div id="exam-qs">${data.questions.map((q,idx)=>renderQuestion(q,idx,answers)).join('')}</div>
    <div class="exam-timer">剩余 <span id="exam-clock">--:--</span></div>`,
    {wide:true,footer:[
      {text:'暂存并退出（续考）',onClick:()=>{clearInterval(examTimer);toast('作答已保存，可随时断线续考');}},
      {text:'交卷',cls:'primary',onClick:async()=>{
        const unanswered = data.questions.filter(q=>answers[q.id]==null||answers[q.id]==='').length;
        if(unanswered && !confirm(`还有 ${unanswered} 题未作答，确认交卷？`)) return false;
        clearInterval(examTimer);
        const r = await api(`/api/attempts/${data.attempt.id}/submit`,{method:'POST',body:{}});
        if(r.attempt.status==='graded'){ toast(`交卷成功，得分 ${r.attempt.total_score}（${r.attempt.passed?'合格':'未合格'}）`,'ok'); renderAttemptResult(data.attempt.id); }
        else { toast('交卷成功，识图/简答题待技术员评阅','ok'); go('exam'); }
      }},
    ]});
  const body = document.getElementById('modal-body');
  // 绑定输入
  body.querySelectorAll('[data-qid]').forEach(el=>{
    const qid = Number(el.dataset.qid);
    const q = data.questions.find(x=>x.id===qid);
    if(q.type==='short'){ el.querySelector('textarea').oninput = e => saveAns(qid,e.target.value); }
    else el.querySelectorAll('input').forEach(inp=>inp.onchange=()=>{
      if(q.type==='multi'){
        answers[qid] = q.options.map((o,i)=>({el:body.querySelector(`[data-opt="${qid}-${i}"]`),i}))
          .filter(x=>x.el.checked).map(x=>'ABCDE'[x.i]).join(',');
      } else answers[qid] = inp.value;
    });
  });
  async function saveAns(qid,val){ answers[qid]=val;
    try{ await api(`/api/attempts/${data.attempt.id}/answer`,{method:'POST',body:{qid,answer:val,client_nonce:crypto.randomUUID()}}); }
    catch(e){ if(!navigator.onLine){ offlineStore.add({op_type:'answer',payload:{attempt_id:data.attempt.id,qid,answer:val}}); toast('弱网：答案暂存本地',''); } }
  }
  const deadline = new Date(data.attempt.deadline_at.replace(' ','T')).getTime();
  clearInterval(examTimer);
  const tick = () => {
    const left = Math.max(0, deadline - Date.now());
    const mm = String(Math.floor(left/60000)).padStart(2,'0');
    const ss = String(Math.floor(left%60000/1000)).padStart(2,'0');
    const clk = document.getElementById('exam-clock'); if(!clk){clearInterval(examTimer);return;}
    clk.textContent = `${mm}:${ss}`;
    if(left<=0){ clearInterval(examTimer); toast('考试时间到，系统自动交卷',''); document.querySelector('.modal-foot .primary')?.click(); }
  };
  tick(); examTimer = setInterval(tick,1000);
}

function renderQuestion(q, idx, answers) {
  const cur = answers[q.id];
  const letters = 'ABCDEFGH';
  let input = '';
  if(q.type==='single' || q.type==='image'){
    input = `<div class="opts">${(q.options||[]).map((o,i)=>`
      <label><input type="radio" name="q${q.id}" data-opt="${q.id}-${i}" value="${letters[i]}" ${cur===letters[i]?'checked':''}> ${letters[i]}. ${esc(o)}</label>`).join('')}</div>`;
  } else if(q.type==='multi'){
    const sel = (cur||'').split(',');
    input = `<div class="opts">${(q.options||[]).map((o,i)=>`
      <label><input type="checkbox" data-opt="${q.id}-${i}" ${sel.includes(letters[i])?'checked':''}> ${letters[i]}. ${esc(o)}</label>`).join('')}</div>`;
  } else if(q.type==='judge'){
    input = `<div class="opts">
      <label><input type="radio" name="q${q.id}" value="T" ${cur==='T'?'checked':''}> 正确 / ✓</label>
      <label><input type="radio" name="q${q.id}" value="F" ${cur==='F'?'checked':''}> 错误 / ✗</label></div>`;
  } else {
    input = `<textarea rows="4" style="width:100%" placeholder="请按要点作答…">${esc(cur||'')}</textarea>
      <p class="muted" style="margin-top:4px">简答题由技术员人工评阅，必要时双评取平均。</p>`;
  }
  return `<div class="exam-q" data-qid="${q.id}">
    <div class="stem">${idx+1}. <span class="badge-dot dot-blue" style="margin-right:4px">${typeName(q.type)} ${q.paper_score}分</span>${esc(q.stem)}</div>
    ${input}</div>`;
}

async function renderAttemptResult(id) {
  const d = await api('/api/attempts/' + id);
  const a = d.attempt;
  modal(`${a.exam_title} · 成绩详情`, `
  <div class="qr-box" style="margin-bottom:12px">
    <div class="muted">${a.version} 卷 · 第 ${a.attempt_no} 次${a.source==='paper'?' · 纸质回录':''}</div>
    <div style="font-size:42px;font-weight:700;color:${a.passed?'var(--green-d)':'var(--red)'};margin:6px 0">${a.total_score ?? '评阅中'} 分</div>
    <div class="muted">及格线 ${a.pass_score} · 客观 ${a.objective_score ?? 0} + 主观 ${a.subjective_score ?? 0}</div>
    ${a.passed ? '<span class="badge-dot dot-green" style="margin-top:8px">合格，电子合格证已签发</span>' : '<span class="badge-dot dot-red">未合格，可参加补考</span>'}
  </div>
  ${d.questions.map((q,i)=>{
    const ans = q.answer_sheet;
    const isObj = ['single','multi','judge'].includes(q.type);
    return `<div class="exam-q"><div class="stem">${i+1}. [${typeName(q.type)}] ${esc(q.stem)}</div>
      <p class="muted">你的作答：${esc(ans?.answer||'未作答')}</p>
      ${isObj ? `<p>${ans?.score?'✅ 正确（'+ans.score+'分）':'❌ 不得分'}</p>` : `<p class="muted">评阅得分：${ans?.score ?? '待评阅'}${ans?.review_round===2?'（双评平均）':''}</p>`}
    </div>`;
  }).join('')}`,
  {wide:true,footer:[
    {text:'申请成绩复核/申诉',cls:'warn',onClick:()=>appealDlg(id)},
    {text:'关闭',cls:'primary'},
  ]});
}

function appealDlg(attemptId) {
  modal('成绩申诉',`<label class="muted">申诉理由（技术员复核后留痕，必要时可调整分数）</label>
    <textarea id="ap-reason" rows="5" style="width:100%;margin-top:6px" placeholder="请说明异议点，如疑似误判、评分偏差等"></textarea>`,
  {footer:[{text:'取消'},{text:'提交申诉',cls:'primary',onClick:async({body})=>{
    const reason = body.querySelector('#ap-reason').value.trim();
    if(!reason) throw new Error('请填写申诉理由');
    await api(`/api/attempts/${attemptId}/appeal`,{method:'POST',body:{reason}});
    toast('申诉已提交，请等待技术员复核','ok');
  }}]});
}
window.startExam = startExam;
window.appealDlg = appealDlg;
