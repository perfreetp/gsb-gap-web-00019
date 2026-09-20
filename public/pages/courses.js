async function renderCourses() {
  if (!state.org) state.org = await api('/api/org');
  const wid = state.user.role === 'farmer' ? state.user.worker_id : '';
  const { list } = await api('/api/courses' + (wid ? '' : ''));
  const subjects = state.org.subjects;
  const groups = {};
  for (const c of list) (groups[c.subject_name] ||= []).push(c);
  document.getElementById('content').innerHTML = `
  <div class="panel" style="background:#f7fbf8">
    <h3>课程内容库</h3>
    <p class="muted">GAP 规范、农药安全间隔期、禁用农药清单、采收加工标准等课件与短视频。系统逐人记录观看时长与章节完成度，对应科目全部学完后方可报考。</p>
  </div>
  ${Object.entries(groups).map(([sub, cs]) => `
    <div class="panel"><h3>${esc(sub)} <span class="tag">${cs.length} 个课件</span></h3>
      <div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">
      ${cs.map(c => {
        const pct = c.duration_sec ? Math.min(100, Math.round(c.progress.watched_sec / c.duration_sec * 100)) : (c.progress.completed ? 100 : 0);
        return `<div style="border:1px solid var(--line);border-radius:10px;padding:14px">
          <div style="font-size:22px">${c.type==='video'?'🎬':'📄'}</div>
          <b>${esc(c.title)}</b>
          <div class="muted" style="margin:4px 0 8px">${Math.round(c.duration_sec/60)} 分钟 · ${c.chapters.length} 章节</div>
          <div class="progress"><i style="width:${c.progress.completed?100:pct}%"></i></div>
          <div style="display:flex;justify-content:space-between;margin-top:8px">
            <span class="${c.progress.completed?'':'muted'}">${c.progress.completed?'<span class="badge-dot dot-green">已完成</span>':`已学 ${pct}%`}</span>
            <button class="btn sm primary" onclick="openCourse(${c.id})">${c.progress.completed?'复习':'开始学习'}</button>
          </div>
        </div>`;
      }).join('')}
      </div>
    </div>`).join('')}`;
}

let learningTimer = null;
async function openCourse(id) {
  const { course, progress } = await api('/api/courses/' + id);
  const chapters = course.chapters;
  let watched = progress?.watched_sec || 0;
  const finished = new Set(progress?.finished_chapters || []);
  const m = modal(course.type === 'video' ? '🎬 ' + course.title : '📄 ' + course.title, `
    <div class="qr-box" style="margin-bottom:12px">
      <div class="muted">${course.type==='video'?'短视频播放区（演示环境用播放进度模拟真实观看）':'课件正文'}</div>
      <div style="font-size:40px;margin:10px 0">${course.type==='video'?'▶️':'📑'}</div>
      <div class="muted">总时长 ${Math.round(course.duration_sec/60)} 分钟 · 防拖拽：观看满 90% 且章节全部完成才算学完</div>
    </div>
    <div id="player-bar" class="muted">已观看 <b id="watch-sec">${watched}</b> / ${course.duration_sec} 秒</div>
    <div class="progress" style="margin:6px 0 12px"><i id="watch-bar" style="width:${Math.min(100,watched/course.duration_sec*100)}%"></i></div>
    <h3 style="margin-bottom:8px">章节目录</h3>
    <div id="chapters">${chapters.map(ch=>`
      <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 6px;border-bottom:1px solid #f0f2f0">
        <span>${finished.has(ch.no)?'✅':'⬜'} 第${ch.no}节 ${esc(ch.title)} <span class="muted">(${ch.dur}s)</span></span>
        <button class="btn sm" data-ch="${ch.no}">${finished.has(ch.no)?'已完成':'标记学完'}</button>
      </div>`).join('')}</div>
    ${course.content ? `<div class="panel" style="margin-top:12px;background:#fafcf9"><b>内容摘要：</b><p style="margin-top:6px;line-height:1.7">${esc(course.content)}</p></div>`:''}
    <p class="muted" id="study-status" style="margin-top:10px"></p>`,
    {wide:true,footer:[{text:'关闭并保存进度',cls:'primary',onClick:()=>{stopLearn();}}]});

  const body = document.getElementById('modal-body');
  async function report() {
    try {
      const r = await api(`/api/courses/${id}/progress`, { method: 'POST', body: { watched_sec: watched, finished_chapters: [...finished] } });
      body.querySelector('#study-status').innerHTML = r.completed
        ? '<span class="badge-dot dot-green">本科目已完成，可参加对应考试</span>'
        : '学习进度已保存';
      return r.completed;
    } catch (e) {
      if (!navigator.onLine) body.querySelector('#study-status').textContent = '弱网：进度暂存，恢复网络后补传';
    }
  }
  // 模拟真实播放：每秒 +3 秒学习时长
  stopLearn();
  learningTimer = setInterval(async () => {
    watched = Math.min(course.duration_sec, watched + 3);
    body.querySelector('#watch-sec').textContent = watched;
    body.querySelector('#watch-bar').style.width = Math.min(100, watched / course.duration_sec * 100) + '%';
    if (watched % 15 < 3) await report();
  }, 1000);

  body.querySelectorAll('#chapters button').forEach(btn => {
    btn.onclick = async () => {
      const ch = Number(btn.dataset.ch);
      finished.add(ch);
      btn.textContent = '已完成'; btn.disabled = true;
      btn.parentElement.querySelector('span').innerHTML = btn.parentElement.querySelector('span').innerHTML.replace('⬜','✅');
      const done = await report();
      if (done) { toast('全部章节完成，课件学完！','ok'); stopLearn(); renderCourses(); }
    };
  });
}
function stopLearn(){ if(learningTimer){clearInterval(learningTimer);learningTimer=null;} }
window.openCourse = openCourse;
