let wFilter = { keyword: '', employment_type: '', coop_id: '', plot_id: '' };

async function renderWorkers() {
  if (!state.org) state.org = await api('/api/org');
  const qs = new URLSearchParams(Object.entries(wFilter).filter(([, v]) => v));
  const data = await api('/api/workers?' + qs);
  const { coops, plots, skills } = state.org;
  document.getElementById('content').innerHTML = `
  <div class="toolbar">
    <input placeholder="搜索姓名 / 身份证 / 手机" value="${esc(wFilter.keyword)}" id="wf-kw" style="width:220px">
    <select id="wf-emp"><option value="">全部用工类型</option><option value="long_term" ${wFilter.employment_type==='long_term'?'selected':''}>长期用工</option><option value="seasonal" ${wFilter.employment_type==='seasonal'?'selected':''}>季节性用工</option></select>
    <select id="wf-coop"><option value="">全部合作社</option>${coops.map(c=>`<option value="${c.id}" ${String(wFilter.coop_id)===String(c.id)?'selected':''}>${esc(c.name)}</option>`).join('')}</select>
    <select id="wf-plot"><option value="">全部地块</option>${plots.map(p=>`<option value="${p.id}" ${String(wFilter.plot_id)===String(p.id)?'selected':''}>${p.code} ${esc(p.name||'')}</option>`).join('')}</select>
    <button class="btn" id="wf-search">查询</button>
    <div class="grow"></div>
    <button class="btn warn" id="wf-dup">重复人员</button>
    <button class="btn" id="wf-import">批量导入</button>
    <button class="btn primary" id="wf-add">＋ 新增药农</button>
  </div>
  <div class="panel"><div class="tbl-wrap">
    <table><thead><tr><th>姓名</th><th>身份证</th><th>性别</th><th>联系方式</th><th>用工</th><th>合作社</th><th>地块</th><th>工种技能</th><th>操作</th></tr></thead>
    <tbody>${data.list.map(w => `<tr>
      <td><b>${esc(w.name)}</b></td><td class="muted">${esc(w.id_card)}</td><td>${esc(w.gender||'')}</td>
      <td>${esc(w.phone||'')}</td>
      <td><span class="badge-dot ${w.employment_type==='long_term'?'dot-green':'dot-amber'}">${empName(w.employment_type)}</span></td>
      <td>${esc(w.coop_name||'—')}</td><td>${w.plot_code ? w.plot_code+' '+esc(w.plot_name||'') : '—'}</td>
      <td><div class="tags">${(w.skill_names||'').split(',').filter(Boolean).map(s=>`<span class="mini-tag">${esc(s)}</span>`).join('')||'<span class="muted">未设置</span>'}</div></td>
      <td><button class="btn sm" onclick="editWorker(${w.id})">编辑/技能</button></td>
    </tr>`).join('') || `<tr><td colspan="9"><div class="empty">暂无数据</div></td></tr>`}</tbody></table>
  </div></div>`;
  document.getElementById('wf-kw').onkeydown = e => { if (e.key==='Enter') doSearch(); };
  document.getElementById('wf-search').onclick = doSearch;
  document.getElementById('wf-add').onclick = workerForm;
  document.getElementById('wf-import').onclick = importDlg;
  document.getElementById('wf-dup').onclick = duplicateDlg;
  function doSearch(){
    wFilter = { keyword: document.getElementById('wf-kw').value.trim(),
      employment_type: document.getElementById('wf-emp').value,
      coop_id: document.getElementById('wf-coop').value, plot_id: document.getElementById('wf-plot').value };
    renderWorkers();
  }
}

function workerForm(id) {
  if (id) return editWorker(id);
  const { coops, plots, skills } = state.org;
  const m = modal('新增药农', `
    <div class="form-grid">
      <label>姓名 *<input id="w-name" placeholder="真实姓名"></label>
      <label>身份证号<input id="w-card" maxlength="18" placeholder="18 位身份证"></label>
      <label>性别<select id="w-gender"><option value="">未填</option><option>男</option><option>女</option></select></label>
      <label>联系方式<input id="w-phone" placeholder="手机号"></label>
      <label>用工类型<select id="w-emp"><option value="seasonal">季节性用工</option><option value="long_term">长期用工</option></select></label>
      <label>所属合作社<select id="w-coop"><option value="">未分配</option>${coops.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <label>所属地块<select id="w-plot"><option value="">未分配</option>${plots.map(p=>`<option value="${p.id}">${p.code} ${esc(p.name||'')}（${esc(p.herb_variety||'')}）</option>`).join('')}</select></label>
      <label>工种技能（可多选）<div class="pill-list" id="w-skills">${skills.map(s=>
        `<label style="display:flex;gap:4px;align-items:center;font-size:12px;color:var(--txt)"><input type="checkbox" value="${s.id}"> ${esc(s.name)}</label>`).join('')}</div></label>
    </div>
    <p class="muted" style="margin-top:10px">提示：同基地身份证号相同，或姓名+手机号相同的人员，系统会自动识别为重复并合并档案。</p>`,
    { footer: [{ text: '取消' }, { text: '保存', cls: 'primary', onClick: async ({ body }) => {
      const skill_ids = [...body.querySelectorAll('#w-skills input:checked')].map(i => i.value);
      const payload = {
        name: body.querySelector('#w-name').value.trim(),
        id_card: body.querySelector('#w-card').value.trim(),
        gender: body.querySelector('#w-gender').value,
        phone: body.querySelector('#w-phone').value.trim(),
        employment_type: body.querySelector('#w-emp').value,
        coop_id: body.querySelector('#w-coop').value || null,
        plot_id: body.querySelector('#w-plot').value || null,
        skill_ids,
      };
      if (!payload.name) throw new Error('请填写姓名');
      const r = await api('/api/workers', { method: 'POST', body: payload });
      toast(r.duplicate ? '检测到重复人员，已自动合并到原档案' : '人员已录入', r.duplicate ? '' : 'ok');
      renderWorkers();
    } }] });
}

async function editWorker(id) {
  const [{ worker, skills }, org] = await Promise.all([api('/api/workers/' + id), state.org || api('/api/org')]);
  state.org = state.org || org;
  const selected = new Set(skills.map(s => s.id));
  const { coops, plots, skills: allSkills } = state.org;
  modal(`编辑档案 · ${worker.name}`, `
    <div class="form-grid">
      <label>姓名 *<input id="w-name" value="${esc(worker.name)}"></label>
      <label>身份证号<input id="w-card" value="${esc(worker.id_card_raw||'')}" placeholder="${esc(worker.id_card)}"></label>
      <label>性别<select id="w-gender"><option value="">未填</option><option ${worker.gender==='男'?'selected':''}>男</option><option ${worker.gender==='女'?'selected':''}>女</option></select></label>
      <label>联系方式<input id="w-phone" value="${esc(worker.phone||'')}"></label>
      <label>用工类型<select id="w-emp"><option value="seasonal" ${worker.employment_type==='seasonal'?'selected':''}>季节性用工</option><option value="long_term" ${worker.employment_type==='long_term'?'selected':''}>长期用工</option></select></label>
      <label>合作社<select id="w-coop"><option value="">未分配</option>${coops.map(c=>`<option value="${c.id}" ${worker.coop_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label>地块<select id="w-plot"><option value="">未分配</option>${plots.map(p=>`<option value="${p.id}" ${worker.plot_id===p.id?'selected':''}>${p.code} ${esc(p.name||'')}</option>`).join('')}</select></label>
      <label>工种技能（决定应培训科目）<div class="pill-list" id="w-skills">${allSkills.map(s=>
        `<label style="display:flex;gap:4px;align-items:center;font-size:12px;color:var(--txt)"><input type="checkbox" value="${s.id}" ${selected.has(s.id)?'checked':''}> ${esc(s.name)}</label>`).join('')}</div></label>
    </div>
    <div class="muted" style="margin-top:8px">档案编号 #${worker.id} · 创建于 ${fmtDate(worker.created_at)}</div>`,
    { footer: [{ text: '取消' }, { text: '保存修改', cls: 'primary', onClick: async ({ body }) => {
      const skill_ids = [...body.querySelectorAll('#w-skills input:checked')].map(i => i.value);
      await api('/api/workers/' + id, { method: 'PUT', body: {
        name: body.querySelector('#w-name').value.trim(),
        id_card: body.querySelector('#w-card').value.trim() || null,
        gender: body.querySelector('#w-gender').value || null,
        phone: body.querySelector('#w-phone').value.trim(),
        employment_type: body.querySelector('#w-emp').value,
        coop_id: body.querySelector('#w-coop').value || null,
        plot_id: body.querySelector('#w-plot').value || null,
        skill_ids,
      } });
      toast('档案已更新', 'ok'); renderWorkers();
    } }] });
}

function importDlg() {
  const template = '姓名,身份证号,性别,联系方式,用工类型,所属合作社,地块编码,工种\n王老五,341602199512120000,男,13800000888,季节性用工,华佗中药材种植合作社,A-01,采收/除草';
  modal('批量导入药农（自动查重合并）', `
    <p class="muted" style="margin-bottom:8px">粘贴 CSV（首行为表头），合作社名称与地块编码需已在本基地登记；工种用 / 或 、 分隔，多个写在一起。</p>
    <textarea id="imp-csv" style="width:100%;height:170px" placeholder="${esc(template)}"></textarea>
    <p><button class="btn sm" id="imp-tpl">填入示例行</button></p>
    <div id="imp-result"></div>`,
    { footer: [{ text: '取消' }, { text: '开始导入', cls: 'primary', onClick: async ({ body }) => {
      const csv = body.querySelector('#imp-csv').value.trim();
      if (!csv) throw new Error('请粘贴数据');
      const r = await api('/api/workers/import', { method: 'POST', body: { csv } });
      body.querySelector('#imp-result').innerHTML =
        `<div class="qr-box" style="margin-top:10px"><h3>导入完成</h3>
          <p>新增 <b>${r.created}</b> 人，自动识别合并重复 <b>${r.merged}</b> 人</p>
          ${r.errors.length ? `<p class="muted" style="color:var(--red)">${r.errors.length} 行失败：</p><div style="text-align:left;font-size:12px;max-height:120px;overflow:auto">${r.errors.map(esc).join('<br>')}</div>` : ''}
        </div>`;
      renderWorkers();
      return false;
    } }] });
  setTimeout(() => document.getElementById('imp-tpl').onclick = () => document.getElementById('imp-csv').value = template, 0);
}

async function duplicateDlg() {
  const { list } = await api('/api/workers/duplicates/list');
  modal('疑似重复人员', `
    <p class="muted" style="margin-bottom:10px">按身份证号或姓名+手机号自动识别，共 ${list.length} 组。合并会把培训、签到、成绩与证书归集到保留档案。</p>
    ${list.length ? `<div class="tbl-wrap"><table><tr><th>A</th><th>B</th><th>操作</th></tr>
      ${list.map(d => `<tr><td>#${d.a_id} ${esc(d.a_name)}<br><span class="muted">${esc(d.a_card||'')} ${esc(d.a_phone||'')}</span></td>
        <td>#${d.b_id} ${esc(d.b_name)}<br><span class="muted">${esc(d.b_card||'')} ${esc(d.b_phone||'')}</span></td>
        <td style="white-space:nowrap"><button class="btn sm primary" onclick="doMerge(${d.a_id},${d.b_id})">保留A合并B</button>
        <button class="btn sm" onclick="doMerge(${d.b_id},${d.a_id})">保留B合并A</button></td></tr>`).join('')}
    </table></div>` : '<div class="empty">未发现疑似重复</div>'}`,
    { wide: true, footer: [{ text: '关闭' }] });
}

async function doMerge(kept, removed) {
  if (!await confirmDlg(`确认保留 #${kept} 并合并 #${removed}？该操作会写入审计日志。`)) return;
  await api('/api/workers/merge', { method: 'POST', body: { kept_id: kept, removed_id: removed } });
  toast('人员档案已合并', 'ok');
  document.getElementById('modal-x')?.click();
  renderWorkers();
}
window.doMerge = doMerge;
window.editWorker = editWorker;
