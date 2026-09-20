// 通用工具
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function fmt(ts, withTime = true) {
  if (!ts) return '—';
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    (withTime ? ` ${p(d.getHours())}:${p(d.getMinutes())}` : '');
}
export function fmtMD(ts) {
  if (!ts) return '长期有效';
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function elapse(ms) {
  if (ms <= 0) return '00:00';
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

let toastTimer;
export function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

export function modal(contentNode, { width } = {}) {
  const root = $('#modal-root');
  root.innerHTML = '';
  const mask = h(`<div class="modal-mask"><div class="modal" ${width ? `style="width:${width}px"` : ''}></div></div>`);
  const box = mask.querySelector('.modal');
  box.appendChild(contentNode);
  mask.addEventListener('click', e => { if (e.target === mask) root.innerHTML = ''; });
  root.appendChild(mask);
  return {
    close: () => { root.innerHTML = ''; },
    node: box,
  };
}
export function closeModal() { $('#modal-root').innerHTML = ''; }

export function confirmDlg(text) {
  return new Promise(resolve => {
    const node = h(`<div>
      <h3>请确认</h3><p style="line-height:1.7">${esc(text)}</p>
      <div class="modal-foot">
        <button class="btn" data-act="no">取消</button>
        <button class="btn primary" data-act="yes">确认</button>
      </div></div>`);
    const m = modal(node);
    node.querySelector('[data-act=no]').onclick = () => { m.close(); resolve(false); };
    node.querySelector('[data-act=yes]').onclick = () => { m.close(); resolve(true); };
  });
}
