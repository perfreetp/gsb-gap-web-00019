import { h, esc, fmt, modal, toast } from '../core.js';
import { api } from '../api.js';
import { getState } from '../app.js';

export async function coursesPage(view) {
  const { user, meta } = getState();
  const canEdit = ['tech', 'base_admin', 'enterprise'].includes(user.role);
  const courses = await api('/courses');
  const personId = user.role === 'farmer' ? user.person_id : null;
  const progress = personId ? await api('/courses/progress/' + personId) : null;
  const progMap = progress ? Object.fromEntries(progress.map(p => [p.course_id, p])) : {};

  const subjName = id => meta.subjects.find(s => s.id === id)?.name || '';
  const card = h(`<div class="card">
    <div class="toolbar">
      <select id="f-subject"><option value="">全部科目</option>
        ${meta.subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <span style="flex:1"></span>
      ${canEdit ? '<button class="btn primary" id="new">＋ 上传课件</button>' : ''}
    </div>
    <div class="grid c2" id="grid"></div></div>`);
  view.appendChild(card);

  function render() {
    const f = card.querySelector('#f-subject').value;
    const rows = f ? courses.filter(c => c.subject_id == f) : courses;
    card.querySelector('#grid').innerHTML = rows.map(c => {
      const p = progMap[c.id];
      const pct = c.duration_sec && p ? Math.min(100, Math.round(p.watched_sec / c.duration_sec * 100)) : (p?.completed ? 100 : 0);
      return `<div class="qa-box">
        <div style="display:flex;justify-content:space-between">
          <div class="stem">${c.type === 'video' ? '🎬' : '📄'} ${esc(c.title)}</div>
          ${p?.completed ? '<span class="pill green">已完成</span>' : p ? '<span class="pill amber">学习中</span>' : '<span class="pill gray">未学习</span>'}
        </div>
        <div class="muted">${esc(subjName(c.subject_id))} · ${c.type === 'video' ? Math.round(c.duration_sec / 60) + ' 分钟视频' : '文档课件'}</div>
        ${user.role === 'farmer' ? `<div class="progress" style="margin:8px 0"><span style="width:${pct}%"></span></div>
          <div style="display:flex;gap:8px;align-items:center">
            ${c.type === 'video' && p && !p.completed ? `<button class="btn small" data-watch="${c.id}" data-sec="${c.duration_sec}">模拟观看 ${Math.round(c.duration_sec / 60)} 分钟</button>` : ''}
            <button class="btn small primary" data-open="${c.id}">${p?.completed ? '复习' : '开始学习'}</button>
            ${p ? `<span class="muted">已学 ${p.watched_sec}s / 章节${p.completed ? '已完成' : '未完成'}</span>` : ''}
          </div>` : `<button class="btn small" data-open="${c.id}">预览内容</button>`}
      </div>`;
    }).join('') || '<p class="muted">暂无课件</p>';

    card.querySelector('#grid').querySelectorAll('[data-open]').forEach(b =>
      b.onclick = () => openCourse(courses.find(x => x.id == b.dataset.open), progMap));
    card.querySelector('#grid').querySelectorAll('[data-watch]').forEach(b =>
      b.onclick = async () => {
        await api('/courses/progress', { method: 'POST',
          body: { course_id: Number(b.dataset.watch), watched_sec: Number(b.dataset.sec) } });
        toast('观看时长已记录，章节完成', 'ok'); coursesPageReload();
      });
  }
  card.querySelector('#f-subject').onchange = render;
  render();

  if (canEdit) card.querySelector('#new').onclick = () => uploadDlg(meta, () => location.reload());

  function coursesPageReload() { view.innerHTML = ''; coursesPage(view); }

  async function openCourse(c, progMap) {
    const p = progMap[c.id];
    const node = h(`<div><h3>${c.type === 'video' ? '🎬' : '📄'} ${esc(c.title)}</h3>
      <div class="muted" style="margin-bottom:10px">${esc(subjName(c.subject_id))} · ${esc(c.chapter || '') || ''}
        ${c.type === 'video' ? '时长约 ' + Math.round(c.duration_sec / 60) + ' 分钟' : ''}</div>
      ${c.type === 'video'
        ? `<div style="background:#111;color:#9ad7b0;border-radius:10px;height:170px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px">
            <div style="font-size:40px">▶</div><div class="muted" style="color:#8fb89e">短视频课件播放区（演示，记录观看时长）</div></div>
          ${user.role === 'farmer' ? `<div class="form-row" style="margin-top:12px;justify-content:center">
            <button class="btn" data-add="300">模拟看 5 分钟</button>
            <button class="btn" data-add="${c.duration_sec}">看完整段</button></div>` : ''}`
        : `<div style="background:var(--green-ll);border-radius:10px;padding:16px;line-height:1.9;white-space:pre-wrap">${esc(c.content || '（文档正文）')}</div>`}
      ${user.role === 'farmer' && !p?.completed ? `<div style="text-align:center;margin-top:14px">
        <button class="btn primary" id="mark-done">我已学完本章节</button></div>` : ''}
      ${p?.completed ? '<p class="muted" style="text-align:center;margin-top:10px">✅ 本章节已完成，可报考对应科目</p>' : ''}
      <div class="modal-foot"><button class="btn" id="close">关闭</button></div></div>`);
    const m = modal(node, { width: 620 });
    node.querySelector('#close').onclick = m.close;
    node.querySelectorAll('[data-add]').forEach(b => b.onclick = async () => {
      await api('/courses/progress', { method: 'POST',
        body: { course_id: c.id, watched_sec: (p?.watched_sec || 0) + Number(b.dataset.add) } });
      toast('观看进度已记录', 'ok'); m.close(); coursesPageReload();
    });
    node.querySelector('#mark-done')?.addEventListener('click', async () => {
      await api('/courses/progress', { method: 'POST',
        body: { course_id: c.id, watched_sec: c.duration_sec || Math.max(p?.watched_sec || 0, 1), completed: true } });
      toast('章节完成，已解锁报考', 'ok'); m.close(); coursesPageReload();
    });
  }
}

function uploadDlg(meta, onDone) {
  const node = h(`<div><h3>上传课件</h3>
    <div class="form-row">
      <div class="field" style="flex:2"><label>标题 *</label><input id="c-title"></div>
      <div class="field"><label>类型</label><select id="c-type"><option value="doc">文档/规范</option><option value="video">短视频</option></select></div>
      <div class="field"><label>视频时长(秒)</label><input id="c-sec" type="number" value="600"></div>
    </div>
    <div class="form-row"><div class="field" style="flex:1"><label>所属科目 *</label><select id="c-subject">
      ${meta.subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div></div>
    <div class="field"><label id="c-lbl">正文内容</label><textarea id="c-content" style="min-height:140px"></textarea></div>
    <div class="modal-foot"><button class="btn" id="cancel">取消</button><button class="btn primary" id="save">保存</button></div></div>`);
  const m = modal(node, { width: 660 });
  node.querySelector('#cancel').onclick = m.close;
  node.querySelector('#save').onclick = async () => {
    try {
      await api('/courses', { method: 'POST', body: {
        title: node.querySelector('#c-title').value.trim(),
        type: node.querySelector('#c-type').value,
        duration_sec: Number(node.querySelector('#c-sec').value) || 0,
        subject_id: Number(node.querySelector('#c-subject').value),
        content: node.querySelector('#c-content').value,
      } });
      toast('课件已入库', 'ok'); m.close(); onDone();
    } catch (e) { toast(e.message, 'error'); }
  };
}
