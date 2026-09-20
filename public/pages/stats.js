async function renderStats() {
  if (!state.org) state.org = await api('/api/org');
  document.getElementById('content').innerHTML = `
  <div class="panel"><div class="toolbar">
    <b>合格率分析</b>
    <select id="st-dim"><option value="plot">按地块</option><option value="coop">按合作社</option><option value="subject">按科目</option></select>
    <select id="st-subject"><option value="">全部科目</option>${state.org.subjects.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
  </div><div id="st-rate"></div></div>
  <div class="panel"><div class="toolbar"><b>缺训/缺证名单</b>
    <select id="st-skill"><option value="">全部工种</option>${state.org.skills.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
    <select id="st-subject2"><option value="">按工种应训科目</option>${state.org.subjects.map(s=>`<option value="${s.id}">仅看：${esc(s.name)}</option>`).join('')}</select>
  </div><div id="st-missing"></div></div>
  <div class="panel"><h3>药农年度学时</h3><div id="st-hours"></div></div>
  <div class="panel"><h3>讲师授课评分</h3><div id="st-lecturer"></div></div>`;
  const loadRate = async () => {
    const dim = document.getElementById('st-dim').value;
    const sid = document.getElementById('st-subject').value;
    const { list } = await api(`/api/stats/pass-rate?dimension=${dim}${sid?'&subject_id='+sid:''}`);
    document.getElementById('st-rate').innerHTML = list.length ? `<table><tr><th>${({plot:'地块',coop:'合作社',subject:'科目'})[dim]}</th><th>参考人数(人次)</th><th>合格</th><th>合格率</th></tr>
      ${list.map(r=>`<tr><td><b>${esc(r.label)}</b></td><td>${r.person_count}</td><td>${r.pass_count}</td>
        <td style="min-width:180px"><div class="bar"><i style="width:${r.pass_rate}%;background:${r.pass_rate>=80?'var(--green)':r.pass_rate>=60?'var(--amber)':'var(--red)'}">${r.pass_rate}%</i></div></td></tr>`).join('')}</table>`
      : '<div class="empty">暂无成绩数据</div>';
  };
  const loadMissing = async () => {
    const skill = document.getElementById('st-skill').value;
    const subject = document.getElementById('st-subject2').value;
    const { list } = await api(`/api/stats/missing-training?${skill?'skill_id='+skill+'&':''}${subject?'subject_id='+subject:''}`);
    document.getElementById('st-missing').innerHTML = list.length ? `
      <p class="muted">共 ${list.length} 人需补训补考</p>
      <table><tr><th>姓名</th><th>电话</th><th>合作社</th><th>地块</th><th>缺失科目</th></tr>
      ${list.map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.phone||'')}</td><td>${esc(x.coop_name||'—')}</td><td>${x.plot_code||'—'}</td>
        <td><div class="tags">${x.missing_subjects.map(s=>`<span class="mini-tag" style="background:#fdf3e0;color:var(--amber)">${esc(s)}</span>`).join('')}</div></td></tr>`).join('')}</table>`
      : '<div class="empty">🎉 应训人员均已持证</div>';
  };
  const loadHours = async () => {
    const { list } = await api('/api/stats/worker-hours');
    document.getElementById('st-hours').innerHTML = `<table><tr><th>姓名</th><th>用工</th><th>合作社/地块</th><th>线下学时</th><th>线上学时</th><th>年度总学时</th><th>有效证书</th></tr>
      ${list.map(r=>`<tr><td><b>${esc(r.name)}</b></td><td>${empName(r.employment_type)}</td><td>${esc(r.coop_name||'')} ${r.plot_code||''}</td>
        <td>${r.train_hours}</td><td>${r.online_hours}</td><td><b>${r.total_hours}</b></td><td>${r.cert_count} 本</td></tr>`).join('')}</table>`;
  };
  const loadLect = async () => {
    const { list } = await api('/api/stats/lecturer-scores');
    document.getElementById('st-lecturer').innerHTML = list.length ? `<table><tr><th>讲师</th><th>授课场次</th><th>评价数</th><th>平均分</th></tr>
      ${list.map(r=>`<tr><td>${esc(r.lecturer)}</td><td>${r.session_count}</td><td>${r.feedback_count}</td>
        <td>${r.avg_score ? '⭐'+r.avg_score : '<span class="muted">暂无评价</span>'}</td></tr>`).join('')}</table>`
      : '<div class="empty">暂无数据</div>';
  };
  document.getElementById('st-dim').onchange = loadRate;
  document.getElementById('st-subject').onchange = loadRate;
  document.getElementById('st-skill').onchange = loadMissing;
  document.getElementById('st-subject2').onchange = loadMissing;
  loadRate(); loadMissing(); loadHours(); loadLect();
}

async function renderAudit() {
  document.getElementById('content').innerHTML = `
  <div class="toolbar">
    <input id="au-kw" placeholder="搜索操作 / 操作人 / 内容" style="width:240px">
    <select id="au-entity"><option value="">全部对象</option>
      <option value="worker">人员</option><option value="session">培训/签到</option>
      <option value="exam_attempt">成绩/考试</option><option value="appeal">申诉</option>
      <option value="harvest_batch">采收批次</option><option value="certificate">证书</option></select>
    <button class="btn" id="au-search">查询</button>
  </div>
  <div class="panel"><div id="au-list" class="tbl-wrap"></div></div>`;
  const load = async () => {
    const kw = document.getElementById('au-kw').value.trim();
    const entity = document.getElementById('au-entity').value;
    const { list } = await api(`/api/audit-logs?${entity?'entity='+entity+'&':''}${kw?'keyword='+encodeURIComponent(kw):''}`);
    document.getElementById('au-list').innerHTML = `<table><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th></tr>
      ${list.map(l=>`<tr><td class="muted" style="white-space:nowrap">${fmtDate(l.created_at)}</td><td>${esc(l.actor_name||'系统')}</td>
        <td><span class="badge-dot dot-blue">${esc(l.action)}</span></td><td>${esc(l.entity||'—')}${l.entity_id?'#'+l.entity_id:''}</td>
        <td style="max-width:420px;font-size:12px;color:var(--muted);word-break:break-all">${esc(l.detail||'')}</td></tr>`).join('')}</table>`;
  };
  document.getElementById('au-search').onclick = load;
  document.getElementById('au-kw').onkeydown = e => e.key==='Enter' && load();
  load();
}
