async function renderCertificates() {
  const { list } = await api('/api/certificates');
  const expiring = list.filter(c => !c.is_expired && c.days_left != null && c.days_left <= 30);
  document.getElementById('content').innerHTML = `
  <div class="toolbar"><div class="grow"></div>
    ${['admin','tech','enterprise'].includes(state.user.role) ? '<button class="btn" id="ce-scan">立即扫描到期证书并推送复训</button>' : ''}
  </div>
  ${expiring.length ? `<div class="panel" style="border-color:#ecd7ad;background:#fdf9ef">
    <h3>⏰ 30 天内到期（自动提醒复训）</h3>${expiring.map(c=>`
      <span class="badge-dot dot-amber" style="margin:4px">${esc(c.worker_name||'')} · ${esc(c.subject_name)} · 剩 ${c.days_left} 天</span>`).join('')}
  </div>`:''}
  <div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">
    ${list.map(c=>`
    <div class="cert-card">
      <h2>培训合格证</h2>
      <div class="muted">CERTIFICATE OF TRAINING</div>
      <div class="name">${esc(c.worker_name || state.user.real_name)}</div>
      <div>已通过 <b>${esc(c.subject_name)}</b> 科目考核</div>
      <div class="muted" style="margin-top:6px">成绩 ${c.score} 分 · 发证日期 ${fmtDay(c.issued_at)}</div>
      ${c.expire_at ? `<div class="${c.is_expired?'':''}" style="margin-top:4px">有效期至 <b>${fmtDay(c.expire_at)}</b></div>` : '<div style="margin-top:4px">长期有效</div>'}
      <div style="margin-top:10px">
        ${c.is_expired ? '<span class="badge-dot dot-red">已过期·需复训</span>' : c.days_left!=null&&c.days_left<=30 ? '<span class="badge-dot dot-amber">即将到期</span>' : '<span class="badge-dot dot-green">有效</span>'}
      </div>
      <div class="no">${esc(c.cert_no)}</div>
    </div>`).join('') || '<div class="empty">暂无证书</div>'}
  </div>`;
  document.getElementById('ce-scan').onclick = async () => {
    const r = await api('/api/certificates/renew-scan',{method:'POST',body:{}});
    toast(r.notified ? `已向 ${r.notified} 人推送到期复训提醒` : '暂无新增到期提醒', r.notified?'ok':'');
  };
}
