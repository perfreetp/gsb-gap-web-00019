async function renderPlots() {
  if (!state.org) state.org = await api('/api/org');
  if (!state.org._workers) { const w = await api('/api/workers'); state.org._workers = w.list; }
  const { bases, coops, plots } = state.org;
  document.getElementById('content').innerHTML = `
  <div class="toolbar"><div class="grow"></div>
    ${['enterprise','admin'].includes(state.user.role) ? '<button class="btn" id="pl-coop">＋ 合作社</button><button class="btn primary" id="pl-add">＋ 登记地块</button>' : ''}
  </div>
  <div class="panel"><h3>地块台账（“哪块地归谁管”）</h3>
  <div class="tbl-wrap"><table><tr><th>地块编码</th><th>名称</th><th>品种</th><th>面积(亩)</th><th>合作社</th><th>基地</th><th>管护人</th></tr>
  ${plots.map(p=>{
    const mgr = state.org._workers?.find(w=>w.id===p.manager_id);
    return `<tr><td><b>${p.code}</b></td><td>${esc(p.name||'—')}</td><td>${esc(p.herb_variety||'—')}</td>
      <td>${p.area_mu||'—'}</td><td>${esc(p.coop_name||'—')}</td>
      <td>${esc(bases.find(b=>b.id===p.base_id)?.name||'')}</td>
      <td>${['enterprise','admin'].includes(state.user.role)?`<select onchange="setManager(${p.id},this.value)" style="max-width:150px">
        <option value="">未指定</option>${(state.org._workers||[]).map(w=>`<option value="${w.id}" ${p.manager_id===w.id?'selected':''}>${esc(w.name)}（${esc(w.plot_code||'无地块')}）</option>`).join('')}
      </select>`:(mgr?esc(mgr.name):'—')}</td></tr>`;
  }).join('')}</table></div></div>`;
  document.getElementById('pl-add').onclick = plotForm;
  document.getElementById('pl-coop').onclick = coopForm;
}

function plotForm() {
  const { bases, coops } = state.org;
  const isEnt = state.user.role === 'enterprise';
  modal('登记地块',`<div class="form-grid">
    ${isEnt?`<label>所属基地<select id="p-base">${bases.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></label>`:''}
    <label>地块编码 *<input id="p-code" placeholder="如 A-03"></label>
    <label>地块名称<input id="p-name"></label>
    <label>药材品种<input id="p-var" placeholder="白芍/黄芪"></label>
    <label>面积(亩)<input id="p-area" type="number" step="0.1"></label>
    <label class="full">所属合作社<select id="p-coop"><option value="">无</option>${coops.filter(c=>!isEnt||c.base_id===state.user.base_id).map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
  </div>`,{footer:[{text:'取消'},{text:'保存',cls:'primary',onClick:async({body})=>{
    await api('/api/plots',{method:'POST',body:{
      base_id: isEnt?Number(body.querySelector('#p-base').value):state.user.base_id,
      code: body.querySelector('#p-code').value.trim(),
      name: body.querySelector('#p-name').value,
      herb_variety: body.querySelector('#p-var').value,
      area_mu: Number(body.querySelector('#p-area').value)||null,
      coop_id: body.querySelector('#p-coop').value||null,
    }});
    toast('地块已登记','ok'); state.org = await api('/api/org'); renderPlots();
  }}]});
}
function coopForm() {
  modal('新增合作社',`<label class="muted">合作社名称</label><input id="c-name" style="width:100%;margin-top:6px">`,
  {footer:[{text:'取消'},{text:'保存',cls:'primary',onClick:async({body})=>{
    await api('/api/coops',{method:'POST',body:{name:body.querySelector('#c-name').value.trim(),base_id:state.user.base_id}});
    toast('合作社已创建','ok'); state.org = await api('/api/org'); renderPlots();
  }}]});
}
async function setManager(plotId, workerId) {
  await api(`/api/plots/${plotId}/manager`,{method:'PUT',body:{worker_id:workerId?Number(workerId):null}});
  toast('地块管护人已指定','ok');
}
window.setManager = setManager;
