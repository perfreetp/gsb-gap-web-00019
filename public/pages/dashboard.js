async function renderDashboard() {
  const ov = await api('/api/stats/overview');
  const cards = [
    { lbl: '在册药农', num: ov.workers, icon: '👥' },
    { lbl: '培训场次', num: ov.sessions, icon: '📚' },
    { lbl: '考核场次', num: ov.exams, icon: '📝' },
    { lbl: '有效证书', num: ov.certs, icon: '🏅' },
    { lbl: '30天内到期', num: ov.expire_soon, icon: '⏰', warn: ov.expire_soon > 0 },
    { lbl: '待评阅试卷', num: ov.pending_review, icon: '✍️', danger: ov.pending_review > 0 },
    { lbl: '采收未持证记录', num: ov.uncertified_harvest, icon: '⚠️', danger: ov.uncertified_harvest > 0 },
  ];
  const roleTips = {
    enterprise: '企业质控视角：可查看所有基地的培训、考核、持证与批次留痕数据。',
    admin: '基地管理员视角：管理本基地人员台账、合作社/地块、培训考核与统计。',
    tech: '技术指导员视角：按农时排课、扫码签到、组卷监考、评阅与复核。',
    farmer: '药农视角：报名培训、在线学习、手机考试、查看证书。',
  };
  document.getElementById('content').innerHTML = `
    <div class="panel" style="background:linear-gradient(120deg,#e8f4ec,#f7fbf8)">
      <h3>你好，${esc(state.user.real_name)} 👋</h3>
      <p class="muted">${roleTips[state.user.role]}</p>
    </div>
    <div class="cards">${cards.map(c => `
      <div class="stat-card ${c.danger ? 'danger' : c.warn ? 'warn' : ''}">
        <div class="lbl">${c.icon} ${c.lbl}</div><div class="num">${c.num}</div>
      </div>`).join('')}
    </div>
    ${state.user.role === 'farmer' ? await farmerDashExtra() : await staffDashExtra()}`;
}

async function farmerDashExtra() {
  const [exams, certs, notes] = await Promise.all([
    api('/api/exams/my'), api('/api/certificates'), api('/api/notifications'),
  ]);
  const now = new Date();
  const active = exams.list.filter(e => new Date(e.start_time.replace(' ', 'T')) <= now && e.status !== 'finished');
  return `
  <div class="panel"><h3>待办 <span class="tag">最近通知 ${notes.list.filter(n=>!n.is_read).length} 条未读</span></h3>
    ${notes.list.slice(0, 5).map(n => `<div class="notif-item ${n.is_read ? '' : 'unread'}">
      <b>${esc(n.title)}</b><p>${esc(n.body || '')}</p></div>`).join('') || '<div class="empty">暂无通知</div>'}
  </div>
  <div class="panel"><h3>可参加的考试</h3>
    ${active.map(e => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f0f2f0">
        <div><b>${esc(e.title)}</b>
          <div class="muted">${esc(e.subject_name)} · 及格 ${e.pass_score} 分 · ${e.duration_min} 分钟 · ${e.eligible ? '课件已学完' : `课件 ${e.course_done}/${e.course_total} 未完成`}</div></div>
        <button class="btn ${e.eligible ? 'primary' : ''} btn-sm" ${e.eligible ? '' : 'disabled'} onclick="go('exam-taking',${e.id})">${e.eligible ? '进入考试' : '未达报考条件'}</button>
      </div>`).join('') || '<div class="empty">当前没有进行中的考试</div>'}
  </div>
  <div class="panel"><h3>我的证书</h3>
    <div class="tbl-wrap"><table><tr><th>科目</th><th>证书编号</th><th>发证日期</th><th>有效期至</th><th>状态</th></tr>
    ${certs.list.map(c => `<tr><td>${esc(c.subject_name)}</td><td>${esc(c.cert_no)}</td><td>${fmtDay(c.issued_at)}</td>
      <td>${c.expire_at ? fmtDay(c.expire_at) : '长期有效'}</td>
      <td>${c.is_expired ? '<span class="badge-dot dot-red">已过期</span>' : c.days_left != null && c.days_left <= 30 ? '<span class="badge-dot dot-amber">即将到期</span>' : '<span class="badge-dot dot-green">有效</span>'}</td></tr>`).join('')}
    </table></div>
  </div>`;
}

async function staffDashExtra() {
  const sessions = await api('/api/sessions');
  const next = sessions.list.filter(s => s.status === 'scheduled').slice(0, 5);
  const reviewCount = (await api('/api/stats/overview')).pending_review;
  return `
  <div class="panel"><h3>近期培训 <span class="tag">扫码/代签入口在“培训管理”</span></h3>
    ${next.map(s => `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f2f0">
      <div><b>${esc(s.title)}</b><div class="muted">${fmtDate(s.train_time)} · ${esc(s.location || '—')} · 讲师 ${esc(s.lecturer || '—')} · 应到 ${s.enrolled} / 已签 ${s.attended}</div></div>
      <button class="btn btn-sm" onclick="go('session-detail',${s.id})">查看</button></div>`).join('') || '<div class="empty">暂无排期</div>'}
  </div>`;
}
