async function renderTraining() {
  if (!state.org) state.org = await api('/api/org');
  const { list } = await api('/api/sessions');
  document.getElementById('content').innerHTML = `
  <div class="toolbar">
    <div class="grow"></div>
    ${['admin', 'tech'].includes(state.user.role) ? '<button class="btn primary" id="se-add">＋ 安排培训场次</button>' : ''}
  </div>
  <div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">
    ${list.map(s => {
      const finished = s.status === 'finished';
      const absent = Math.max(0, s.enrolled - s.attended);
      return `<div class="panel" style="margin:0">
        <div style="display:flex;justify-content:space-between;align-items:start">
          <div><b>${esc(s.title)}</b><br><span class="badge-dot ${finished?'dot-gray':'dot-green'}">${finished?'已结束':'待开展'}</span></div>
          <div class="muted">评分 ${s.lecturer_score ? '⭐'+s.lecturer_score : '暂无'}</div>
        </div>
        <dl class="kv" style="margin-top:10px">
          <dt>时间</dt><dd>${fmtDate(s.train_time)}</dd>
          <dt>地点</dt><dd>${esc(s.location||'—')} ${s.plot_code ? '（地块 '+s.plot_code+'）' : ''}</dd>
          <dt>讲师</dt><dd>${esc(s.lecturer||'—')}</dd>
          <dt>科目</dt><dd>${esc(s.subject_name||'综合')} · ${s.credit_hours} 学时</dd>
          <dt>出勤</dt><dd>应到 ${s.enrolled} / 已签 ${s.attended} ${absent ? `<span class="badge-dot dot-red">缺 ${absent}</span>` : ''}</dd>
        </dl>
        <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn sm" onclick="go('session-detail',${s.id})">花名册/签到</button>
          ${!finished && ['admin','tech'].includes(state.user.role) ? `<button class="btn sm warn" onclick="finishSession(${s.id})">结训并提醒缺课</button>` : ''}
        </div>
      </div>`;
    }).join('') || '<div class="empty">暂无培训场次</div>'}
  </div>`;
  document.getElementById('se-add').onclick = sessionForm;
}

function sessionForm() {
  const { plots, subjects, skills } = state.org;
  modal('安排培训场次', `
    <div class="form-grid">
      <label class="full">培训主题 *<input id="s-title" placeholder="如：农药安全间隔期专题培训"></label>
      <label>培训时间 *<input id="s-time" type="datetime-local"></label>
      <label>关联科目<select id="s-subject"><option value="">不指定</option>${subjects.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>
      <label>地点<input id="s-location" placeholder="培训室 / 田头"></label>
      <label>地块<select id="s-plot"><option value="">不指定</option>${plots.map(p=>`<option value="${p.id}">${p.code} ${esc(p.name||'')}</option>`).join('')}</select></label>
      <label>讲师<input id="s-lecturer" value="${esc(state.user.real_name.replace(/^(技术指导员|基地管理员)-/,''))}"></label>
      <label>应到工种<select id="s-skill"><option value="">不限制（自由报名）</option>${skills.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>
      <label>学时<input id="s-hours" type="number" step="0.5" value="4"></label>
      <label class="full">培训内容<textarea id="s-content" rows="3" placeholder="培训要点、农时要求"></textarea></label>
    </div>
    <p class="muted" style="margin-top:8px">保存后系统按“工种技能标签”自动列出应到名单，季节性用工只匹配本地块。</p>`,
    { footer: [{text:'取消'},{text:'保存并生成应到名单',cls:'primary',onClick:async({body})=>{
      const payload = {
        title: body.querySelector('#s-title').value.trim(),
        train_time: (body.querySelector('#s-time').value||'').replace('T',' '),
        subject_id: body.querySelector('#s-subject').value || null,
        location: body.querySelector('#s-location').value,
        plot_id: body.querySelector('#s-plot').value || null,
        lecturer: body.querySelector('#s-lecturer').value,
        required_skill_id: body.querySelector('#s-skill').value || null,
        credit_hours: Number(body.querySelector('#s-hours').value)||0,
        content: body.querySelector('#s-content').value,
      };
      if(!payload.title || !payload.train_time) throw new Error('主题和时间必填');
      await api('/api/sessions',{method:'POST',body:payload});
      toast('场次已创建，应到名单已生成','ok'); renderTraining();
    }}]});
}

async function renderSessionDetail(id) {
  const d = await api('/api/sessions/' + id);
  const s = d.session;
  const payload = JSON.stringify({ sid: s.id });
  document.getElementById('content').innerHTML = `
  <button class="btn sm" onclick="go('training')">← 返回场次列表</button>
  <div class="panel" style="margin-top:12px">
    <h3>${esc(s.title)} <span class="tag">${fmtDate(s.train_time)} · ${esc(s.location||'—')} · 讲师 ${esc(s.lecturer||'—')}</span></h3>
    <p class="muted">${esc(s.content||'暂无培训内容说明')}</p>
    <div class="tags" style="margin:8px 0">
      <span class="mini-tag">${esc(s.subject_name||'综合培训')}</span>
      <span class="mini-tag">${s.credit_hours} 学时</span>
      <span class="mini-tag">${esc(s.skill_name||'不限工种')}</span>
      <span class="badge-dot ${s.status==='finished'?'dot-gray':'dot-green'}">${s.status==='finished'?'已结训':'待开展'}</span>
    </div>
    ${['admin','tech'].includes(state.user.role) ? `
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:10px">
      <div class="qr-box" style="flex:1;min-width:240px">
        <div class="muted">药农微信/浏览器扫码 — 报名二维码</div>
        <div class="code">SIGN-${s.id}-ENR</div>
        <button class="btn sm" onclick="copyCode('ENR-${s.id}')">复制报名码</button>
      </div>
      <div class="qr-box" style="flex:1;min-width:240px">
        <div class="muted">现场扫码 — 签到二维码（每分钟可轮换）</div>
        <div class="code">SIGN-${s.id}-CHK</div>
        <button class="btn sm" onclick="copyCode('CHK-${s.id}')">复制签到码</button>
      </div>
    </div>`:`
    <div style="margin-top:10px;display:flex;gap:8px">
      <button class="btn primary" onclick="selfEnroll(${s.id})">扫码报名</button>
      <button class="btn primary" onclick="selfCheckin(${s.id})">现场扫码签到${offlineStore.list().some(o=>o.op_type==='checkin')?' <span class="badge-dot dot-amber">有待补传</span>':''}</button>
    </div>`}
  </div>
  <div class="panel">
    <h3>应到花名册 <span class="tag">已签 ${d.roster.filter(r=>r.att_id).length}/${d.roster.length}</span></h3>
    <div class="tbl-wrap"><table><thead><tr><th>姓名</th><th>电话</th><th>用工</th><th>报名</th><th>签到状态</th><th>签到方式</th><th>${['admin','tech'].includes(state.user.role)?'操作':'反馈'}</th></tr></thead>
    <tbody>${d.roster.map(r=>`<tr>
      <td><b>${esc(r.name)}</b></td><td>${esc(r.phone||'')}</td>
      <td>${empName(r.employment_type)}</td>
      <td>${r.enroll_id?'<span class="badge-dot dot-blue">已报名</span>':'<span class="muted">未报名</span>'}</td>
      <td>${r.att_id ? `<span class="badge-dot dot-green">${fmtDate(r.check_in_at)}</span>` : '<span class="badge-dot dot-red">缺勤/未签</span>'}</td>
      <td>${r.att_id ? (r.method==='proxy'?'<span class="badge-dot dot-amber">代签/补录</span>':'扫码')+(r.source==='offline'?'(离线补传)':'') : '—'}</td>
      <td>${['admin','tech'].includes(state.user.role)
        ? (r.att_id ? '<span class="muted">已签到（幂等）</span>' : `<button class="btn sm warn" onclick="proxyCheckin(${s.id},${r.id})">代签/补录</button>`)
        : `<button class="btn sm" onclick="feedbackDlg(${s.id})">评价讲师</button>`}</td>
    </tr>`).join('')}</tbody></table></div>
  </div>
  ${d.feedback.length ? `<div class="panel"><h3>讲师授课评价（${d.feedback.length} 条，均分 ${(d.feedback.reduce((a,b)=>a+b.score,0)/d.feedback.length).toFixed(1)}）</h3>
    ${d.feedback.map(f=>`<div class="notif-item"><b>${'⭐'.repeat(f.score)}</b><p>${esc(f.comment||'（无文字评价）')} · ${esc(f.worker_name)}</p></div>`).join('')}</div>`:''}
  `;
}

function copyCode(code){ navigator.clipboard?.writeText(code); toast('签到码已复制（现场可投屏二维码）','ok'); }

async function selfEnroll(sid){
  try { await api(`/api/sessions/${sid}/enroll`,{method:'POST',body:{}}); toast('报名成功','ok'); }
  catch(e){ if(!navigator.onLine){ offlineStore.add({op_type:'enroll',worker_id:state.user.worker_id,payload:{session_id:sid}}); toast('当前弱网，报名已存本地，联网自动补传',''); } else throw e; }
  renderSessionDetail(sid);
}
async function selfCheckin(sid){
  try { await api(`/api/sessions/${sid}/checkin`,{method:'POST',body:{client_nonce:crypto.randomUUID()}}); toast('签到成功','ok'); }
  catch(e){ if(!navigator.onLine){ offlineStore.add({op_type:'checkin',worker_id:state.user.worker_id,payload:{session_id:sid,check_in_at:new Date().toISOString().slice(0,19).replace('T',' ')}}); toast('弱网：签到已存本地，联网自动补传去重',''); } else throw e; }
  renderSessionDetail(sid);
}
async function proxyCheckin(sid, wid){
  if(!await confirmDlg('确认为该药农代签/补录？将记录操作人与审计日志。')) return;
  await api(`/api/sessions/${sid}/checkin`,{method:'POST',body:{worker_id:wid,method:'proxy'}});
  toast('代签补录成功','ok'); renderSessionDetail(sid);
}
async function finishSession(sid){
  if(!await confirmDlg('确认结训？系统将自动列出应到未到人员并推送缺课提醒。')) return;
  const r = await api(`/api/sessions/${sid}/finish`,{method:'POST',body:{}});
  toast(`已结训，向 ${r.absent_count} 名缺课人员推送提醒`, r.absent_count?'':'ok');
  renderSessionDetail(sid);
}
function feedbackDlg(sid){
  modal('评价本次培训讲师',`<div class="form-grid">
    <label class="full">评分<select id="fb-score"><option value="5">⭐⭐⭐⭐⭐ 很满意</option><option value="4">⭐⭐⭐⭐ 满意</option><option value="3">⭐⭐⭐ 一般</option><option value="2">⭐⭐ 较差</option><option value="1">⭐ 差</option></select></label>
    <label class="full">评语<textarea id="fb-comment" rows="3"></textarea></label></div>`,
    {footer:[{text:'取消'},{text:'提交',cls:'primary',onClick:async({body})=>{
      await api(`/api/sessions/${sid}/feedback`,{method:'POST',body:{score:Number(body.querySelector('#fb-score').value),comment:body.querySelector('#fb-comment').value}});
      toast('感谢评价','ok'); renderSessionDetail(sid);
    }}]});
}
window.copyCode = copyCode;
window.selfEnroll = selfEnroll;
window.selfCheckin = selfCheckin;
window.proxyCheckin = proxyCheckin;
window.finishSession = finishSession;
window.feedbackDlg = feedbackDlg;
