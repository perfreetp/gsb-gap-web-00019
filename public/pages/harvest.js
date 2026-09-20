async function renderHarvest() {
  if (!state.org) state.org = await api('/api/org');
  const { list } = await api('/api/harvest/batches');
  document.getElementById('content').innerHTML = `
  <div class="toolbar"><div class="grow"></div>
    ${['admin','tech'].includes(state.user.role) ? '<button class="btn primary" id="hb-add">＋ 采收登记（持证校验）</button>' : ''}
  </div>
  <div class="panel"><h3>采收批次留痕 <span class="tag">可导出给下游客户 / 检查方调阅</span></h3>
    <div class="tbl-wrap"><table><tr><th>批次号</th><th>基地</th><th>地块</th><th>品种</th><th>采收时间</th><th>作业人数</th><th>未持证</th><th>操作</th></tr>
    ${list.map(b=>`<tr><td><b>${esc(b.batch_no)}</b></td><td>${esc(b.base_name)}</td><td>${b.plot_code} ${esc(b.plot_name||'')}</td>
      <td>${esc(b.variety||'')}</td><td>${fmtDate(b.harvest_time)}</td><td>${b.worker_count}</td>
      <td>${b.uncertified_count?`<span class="badge-dot dot-red">${b.uncertified_count} 人（已填原因）</span>`:'<span class="badge-dot dot-green">全部持证</span>'}</td>
      <td style="white-space:nowrap"><button class="btn sm" onclick="viewBatch(${b.id})">留痕明细</button>
        <a class="btn sm" href="/api/export/harvest/${b.id}.csv" target="_blank">导出CSV</a></td></tr>`).join('')
      || '<tr><td colspan="8"><div class="empty">暂无采收批次</div></td></tr>'}
    </table></div></div>`;
  document.getElementById('hb-add').onclick = harvestForm;
}

function harvestForm() {
  const { plots } = state.org;
  const myPlots = state.user.role === 'enterprise' ? plots : plots.filter(p=>p.base_id===state.user.base_id);
  const m = modal('采收登记 · 持证上岗校验', `
  <div class="form-grid">
    <label>采收地块 *<select id="h-plot">${myPlots.map(p=>`<option value="${p.id}">${p.code} ${esc(p.name||'')}（${esc(p.herb_variety||'')}）</option>`).join('')}</select></label>
    <label>采收时间 *<input id="h-time" type="datetime-local"></label>
    <label class="full">当期作业人员（多选）<div id="h-workers" style="max-height:160px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px"></div></label>
  </div>
  <div id="h-check" style="margin-top:12px"></div>
  <label class="full" style="display:none" id="h-reason-wrap">备注<textarea id="h-remark" rows="2" style="width:100%"></textarea></label>`,
  {wide:true,footer:[
    {text:'校验持证情况',cls:'',onClick:async({body})=>{ await runCheck(body); return false; }},
    {text:'确认登记（留痕）',cls:'primary',onClick:async({body})=>{
      const checked = body.__checked;
      if(!checked) throw new Error('请先点击“校验持证情况”');
      const payload = {
        plot_id: Number(body.querySelector('#h-plot').value),
        harvest_time: body.querySelector('#h-time').value.replace('T',' '),
        variety: myPlots.find(p=>p.id==Number(body.querySelector('#h-plot').value))?.herb_variety,
        remark: body.querySelector('#h-remark').value,
        workers: checked.results.map(r=>({worker_id:r.worker_id, reason: body.querySelector(`[data-reason="${r.worker_id}"]`)?.value || null})),
      };
      if(!payload.harvest_time) throw new Error('请填写采收时间');
      await api('/api/harvest/batches',{method:'POST',body:payload});
      toast('采收批次已登记并留痕','ok'); renderHarvest();
    }},
  ]});
  const body = document.getElementById('modal-body');
  body.querySelector('#h-time').value = new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
  async function loadWorkers(){
    const plotId = Number(body.querySelector('#h-plot').value);
    const { list } = await api('/api/workers?plot_id=' + plotId);
    const all = list.length ? list : (await api('/api/workers')).list;
    body.querySelector('#h-workers').innerHTML = all.map(w=>`
      <label style="display:flex;gap:6px;align-items:center;padding:3px 0;font-size:13px">
        <input type="checkbox" value="${w.id}"> ${esc(w.name)} <span class="muted">${esc(w.coop_name||'')} · ${empName(w.employment_type)}</span></label>`).join('') || '<span class="muted">该地块暂无人员，请先在台账中分配</span>';
    body.__checked = null;
    body.querySelector('#h-check').innerHTML = '';
  }
  body.querySelector('#h-plot').onchange = loadWorkers;
  loadWorkers();

  async function runCheck(bodyEl){
    const ids = [...bodyEl.querySelectorAll('#h-workers input:checked')].map(x=>Number(x.value));
    if(!ids.length) throw new Error('请至少选择一名作业人员');
    const r = await api('/api/harvest/check',{method:'POST',body:{plot_id:Number(bodyEl.querySelector('#h-plot').value),worker_ids:ids}});
    bodyEl.__checked = r;
    bodyEl.querySelector('#h-check').innerHTML = `
      <div class="panel" style="${r.warning?'border-color:#e0b4ad;background:#fdf6f5':'background:#f4faf5'}">
        <h3>${r.warning?'⚠️ 持证校验警示':'✅ 持证校验通过'}</h3>
        <p class="muted">采收作业必需科目：${r.required_subjects.map(s=>esc(s.name)).join('、')}</p>
        <table style="margin-top:8px"><tr><th>人员</th><th>结果</th><th>缺证科目/原因填写</th></tr>
        ${r.results.map(x=>`<tr><td>${esc(x.name)}</td>
          <td>${x.certified?'<span class="badge-dot dot-green">持证齐全</span>':'<span class="badge-dot dot-red">未持证</span>'}</td>
          <td>${x.certified?'<span class="muted">—</span>':`<div style="color:var(--red);font-size:12px">缺：${x.missing.map(esc).join('、')}</div>
            <input data-reason="${x.worker_id}" placeholder="*必填：未持证上岗原因（如抢收/补训承诺）" style="width:100%;margin-top:4px">`}</td></tr>`).join('')}
        </table>
        ${r.warning?'<p class="muted" style="margin-top:8px;color:var(--red)">未持证人员必须逐人填写原因后方可登记，系统将推送补训提醒并随批次永久留痕。</p>':''}
      </div>`;
  }
}

async function viewBatch(id) {
  const d = await api('/api/harvest/batches/' + id);
  modal(`批次留痕 · ${d.batch.batch_no}`, `
  <dl class="kv">
    <dt>批次号</dt><dd>${esc(d.batch.batch_no)}</dd>
    <dt>基地/地块</dt><dd>${esc(d.batch.base_name)} · ${d.batch.plot_code}</dd>
    <dt>品种</dt><dd>${esc(d.batch.variety||'—')}</dd>
    <dt>采收时间</dt><dd>${fmtDate(d.batch.harvest_time)}</dd>
    <dt>备注</dt><dd>${esc(d.batch.remark||'—')}</dd>
  </dl>
  <h3 style="margin:14px 0 8px;font-size:14px">作业人员持证情况</h3>
  <table><tr><th>姓名</th><th>电话</th><th>合作社</th><th>持证</th><th>要求科目</th><th>未持证原因</th></tr>
  ${d.workers.map(w=>`<tr><td>${esc(w.name)}</td><td>${esc(w.phone||'')}</td><td>${esc(w.coop_name||'—')}</td>
    <td>${w.certified?'<span class="badge-dot dot-green">是</span>':'<span class="badge-dot dot-red">否</span>'}</td>
    <td style="max-width:200px">${esc(w.required_subject||'')}</td><td>${esc(w.reason||'—')}</td></tr>`).join('')}
  </table>
  <p style="margin-top:12px"><a class="btn primary" href="/api/export/harvest/${d.batch.id}.csv" target="_blank">下载 CSV 留痕单（供检查方调阅）</a></p>`,
  {wide:true,footer:[{text:'关闭'}]});
}
window.viewBatch = viewBatch;
