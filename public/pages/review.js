async function renderReview(examId) {
  const [{ list: pending }, { list: appeals }] = await Promise.all([
    api('/api/exams/review/pending'), api('/api/appeals'),
  ]);
  document.getElementById('content').innerHTML = `
  <div class="panel"><h3>待评阅试卷 <span class="tag">识图题、简答题；第二位不同技术员评分时自动双评取平均</span></h3>
    ${pending.length ? `<div class="tbl-wrap"><table><tr><th>考试</th><th>药农</th><th>卷型</th><th>第几次</th><th>客观题得分</th><th>操作</th></tr>
      ${pending.map(p=>`<tr><td>${esc(p.title)}</td><td>${esc(p.worker_name)}</td><td>${p.version} 卷</td><td>第${p.attempt_no}次</td>
        <td>${p.objective_score}</td><td><button class="btn sm primary" onclick="openReview(${p.attempt_id})">开始评阅</button></td></tr>`).join('')}
    </table></div>` : '<div class="empty">暂无待评阅试卷</div>'}
  </div>
  <div class="panel"><h3>成绩申诉复核</h3>
    ${appeals.length ? `<div class="tbl-wrap"><table><tr><th>药农</th><th>考试</th><th>申诉理由</th><th>状态</th><th>操作</th></tr>
      ${appeals.map(a=>`<tr><td>${esc(a.worker_name)}</td><td>${esc(a.exam_title)}</td><td style="max-width:280px">${esc(a.reason)}</td>
        <td><span class="badge-dot ${a.status==='pending'?'dot-amber':a.status==='approved'?'dot-green':'dot-red'}">${({pending:'待复核',approved:'申诉成立',rejected:'申诉驳回'})[a.status]}</span></td>
        <td>${a.status==='pending' && ['admin','tech'].includes(state.user.role) ? `<button class="btn sm" onclick="handleAppeal(${a.id})">复核处理</button>`:`<span class="muted">${esc(a.reply||'')}</span>`}</td></tr>`).join('')}
    </table></div>`:'<div class="empty">暂无申诉</div>'}
  </div>`;
}

async function openReview(attemptId) {
  const d = await api('/api/attempts/' + attemptId);
  const a = d.attempt;
  const subjective = d.questions.filter(q=>['image','short'].includes(q.type));
  modal(`评阅 · ${esc(a.worker_name)} · ${esc(a.exam_title)}（${a.version}卷）`, `
  <p class="muted">客观题得分已自动判出：<b>${a.objective_score}</b> 分。请评阅以下 ${subjective.length} 道主观题。</p>
  ${subjective.map((q,i)=>{
    const ans = q.answer_sheet;
    return `<div class="exam-q"><div class="stem">${i+1}. [${typeName(q.type)} ${q.paper_score}分] ${esc(q.stem)}</div>
      ${q.type==='image' ? `<div class="qr-box" style="margin-bottom:8px">🖼️ 图片判读位（演示：按考生选项与图示要点评阅）<div class="muted">参考正确项：${esc(q.answer)}</div></div>`:''}
      <p>考生作答：</p><div class="panel" style="background:#fafcf9;margin:6px 0">${esc(ans?.answer||'（未作答）')}</div>
      <p class="muted">评分要点：${esc(q.answer)}</p>
      <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
        <span>得分</span><input type="number" min="0" max="${q.paper_score}" value="${ans?.score ?? ''}" id="rv-${q.id}" style="width:90px">
        <span class="muted">/ ${q.paper_score}</span>
        ${ans?.review_round===1?`<span class="badge-dot dot-amber">已一评（${ans.score}分），再评即双评取平均</span>`:ans?.review_round===2?'<span class="badge-dot dot-green">已双评完成</span>':''}
      </div></div>`;
  }).join('')}`,
  {wide:true,footer:[{text:'取消'},{text:'提交评阅并出成绩',cls:'primary',onClick:async({body})=>{
    for(const q of subjective){
      const inp = body.querySelector('#rv-'+q.id);
      await api(`/api/attempts/${attemptId}/review`,{method:'POST',body:{qid:q.id,score:Number(inp.value)||0}});
    }
    toast('评阅已提交，总成绩已生成并通知药农','ok');
    renderReview();
  }}]});
}

function handleAppeal(id) {
  modal('复核申诉',`<div class="form-grid">
    <label>复核结论<select id="ap-status"><option value="approved">申诉成立（调整分数）</option><option value="rejected">申诉驳回（维持原分）</option></select></label>
    <label>调整后总分（成立时填写）<input id="ap-score" type="number" placeholder="如 62"></label>
    <label class="full">复核说明（留痕）<textarea id="ap-reply" rows="3" placeholder="复核依据、处理意见"></textarea></label>
  </div>`,{footer:[{text:'取消'},{text:'提交复核',cls:'primary',onClick:async({body})=>{
    const status = body.querySelector('#ap-status').value;
    await api(`/api/appeals/${id}/handle`,{method:'POST',body:{
      status, reply: body.querySelector('#ap-reply').value,
      adjust_score: status==='approved' ? Number(body.querySelector('#ap-score').value) : undefined,
    }});
    toast('复核完成并留痕，已通知药农','ok'); renderReview();
  }}]});
}
window.openReview = openReview;
window.handleAppeal = handleAppeal;
