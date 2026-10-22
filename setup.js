/* ProjectMedia Y — home + new-project flow.
   Loads after app.js and intentionally uses its existing editor state/storage. */
(function () {
  const KEY = 'pmy-setup-v2';
  const SHAPES = [
    { v: '16:9', name: 'YouTube', sub: 'Landscape', w: 48, h: 27 },
    { v: '9:16', name: 'Shorts & Reels', sub: 'Portrait', w: 27, h: 48 },
    { v: '1:1', name: 'Square', sub: 'Social post', w: 36, h: 36 }
  ];
  const QUALITY = [
    { v: 480, name: '480p', sub: 'Small file' }, { v: 720, name: '720p', sub: 'Fast' },
    { v: 1080, name: '1080p', sub: 'HD' }, { v: 1440, name: '2K', sub: 'Heavy' }, { v: 2160, name: '4K', sub: 'Very heavy' }
  ];
  const FPS = [{ v: 24, name: '24', sub: 'Cinematic' }, { v: 30, name: '30', sub: 'Standard' }, { v: 60, name: '60', sub: 'Smooth' }];
  let pick = { r: '9:16', res: 720, fps: 30 }, hasProject = false, projectInfo = null;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY)) || {};
    if (SHAPES.some(s => s.v === saved.r)) pick.r = saved.r;
    if (QUALITY.some(q => q.v === saved.res)) pick.res = saved.res;
    if (FPS.some(f => f.v === saved.fps)) pick.fps = saved.fps;
  } catch (e) {}

  const home = document.createElement('section');
  home.id = 'homeScreen'; home.setAttribute('aria-label', 'Project home');
  home.innerHTML = `
    <div class="hm-wrap">
      <header class="hm-brand"><span class="brand-icon">Y</span><span>ProjectMedia <b>Y</b></span><span class="hm-pill">VIDEO EDITOR</span></header>
      <div class="hm-hero"><p class="hm-eyebrow">YOUR CREATIVE SPACE</p><h1>Make something<br><span>that moves.</span></h1><p class="hm-sub">Pick up where you left off or start a fresh edit.</p></div>
      <section class="hm-recent" id="hmRecent">
        <div class="hm-section-head"><div><p class="hm-eyebrow">RECENT PROJECT</p><h2 id="hmProjectTitle">Your last edit</h2></div><span class="hm-project-icon">▶</span></div>
        <p id="hmProjectMeta" class="hm-meta">Saved on this device</p>
        <button id="hmContinue" class="hm-continue"><span class="hm-play">▶</span><span><b>Continue editing</b><small>Open your last project</small></span><span class="hm-arrow">↗</span></button>
        <p id="hmNoProject" class="hm-empty" hidden>No saved project yet. Start a new edit below and it will be saved on this device.</p>
      </section>
      <div class="hm-actions">
        <button id="hmNew" class="hm-new"><span class="hm-action-icon">＋</span><span><b>New project</b><small>Start with your own media</small></span><span class="hm-arrow">→</span></button>
        <button id="hmTemplates" class="hm-action"><span class="hm-action-icon">▧</span><span><b>My templates</b><small>Reuse an intro, logo or layout</small></span><span class="hm-arrow">→</span></button>
        <button id="hmExport" class="hm-export"><span>Export last project</span><span>↑</span></button>
      </div>
      <footer class="hm-footer">Projects and media are stored locally on this device.</footer>
    </div>`;
  document.body.appendChild(home);

  const setup = document.createElement('section'); setup.id = 'setup'; setup.setAttribute('aria-label', 'New project');
  setup.hidden = true;
  setup.innerHTML = `
    <div class="su-wrap">
      <button id="suBack" class="su-back">← Home</button>
      <div class="su-head"><div class="empty-logo">Y</div><h1>Set up your project</h1><p>Choose a format. You can change it later.</p></div>
      <div><p class="su-label">Video shape</p><div id="suShape" class="su-shapes"></div></div>
      <div><p class="su-label">Export quality</p><div id="suRes" class="su-row q5"></div><p id="suHint" class="su-hint"></p></div>
      <div><p class="su-label">Frames per second</p><div id="suFps" class="su-row"></div></div>
      <div class="su-foot"><p id="suSum"></p><button id="suStart" class="primary wide">Start editing <span aria-hidden="true">→</span></button></div>
    </div>`;
  document.body.appendChild(setup);
  const q = id => setup.querySelector('#' + id), on = (a, b) => a === b ? 'on' : '';

  function render() {
    q('suShape').innerHTML = SHAPES.map(s => `<button type="button" data-k="r" data-v="${s.v}" class="${on(s.v, pick.r)}"><i style="width:${s.w}px;height:${s.h}px"></i><b>${s.name}</b><small>${s.sub}</small></button>`).join('');
    q('suRes').innerHTML = QUALITY.map(o => `<button type="button" data-k="res" data-v="${o.v}" class="${on(o.v, pick.res)}"><b>${o.name}</b><small>${o.sub}</small></button>`).join('');
    q('suFps').innerHTML = FPS.map(o => `<button type="button" data-k="fps" data-v="${o.v}" class="${on(o.v, pick.fps)}"><b>${o.name}</b><small>${o.sub}</small></button>`).join('');
    q('suHint').textContent = pick.res >= 1440 ? '2K/4K exports can be slow or run out of memory on phones.' : pick.res === 1080 ? 'Recommended for a clear HD export.' : 'A smaller file and quicker export.';
    q('suSum').textContent = `${pick.r}  ·  ${QUALITY.find(o => o.v === pick.res).name}  ·  ${pick.fps} fps`;
  }
  setup.addEventListener('click', e => {
    const b = e.target.closest('button[data-k]'); if (!b) return;
    pick[b.dataset.k] = b.dataset.k === 'r' ? b.dataset.v : Number(b.dataset.v); render();
  });
  function apply() {
    try { localStorage.setItem(KEY, JSON.stringify(pick)); } catch (e) {}
    EXP.res = pick.res; EXP.fps = pick.fps;
    [['resList', pick.res], ['fpsList', pick.fps]].forEach(([id, v]) => { const b = $(id) && $(id).querySelector(`[data-v="${v}"]`); if (b) b.click(); });
    const ar = $('aspectRatio'); if (ar.value !== pick.r) { ar.value = pick.r; ar.dispatchEvent(new Event('change')); }
    setup.hidden = true; home.hidden = true;
    try { say(`${pick.r} · ${pick.res}p · ${pick.fps} fps. Add media to begin.`); } catch (e) {}
  }
  q('suStart').onclick = apply;
  q('suBack').onclick = () => { setup.hidden = true; home.hidden = false; };

  function showEditor() { home.hidden = true; setup.hidden = true; }
  $('hmContinue').onclick = showEditor;
  $('hmNew').onclick = async () => {
    if (hasProject && !confirm('Start a new project? This replaces the current saved project on this device. Export it first if you want to keep a finished copy.')) return;
    try { await restore(JSON.stringify({ ratio: pick.r, main: [], audio: [], overlays: [], nextLayer: 1 })); t = 0; commit(); await seek(0); refresh(0); }
    catch (e) { console.warn(e); }
    home.hidden = true; render(); setup.hidden = false;
  };
  $('hmTemplates').onclick = () => { showEditor(); openSheet('tpl'); };
  $('hmExport').onclick = () => {
    if (!hasProject) { say('Create a project and add a video before exporting.'); return; }
    showEditor(); $('exportBtn').click();
  };

  async function loadHome() {
    try {
      const row = await db.projects.get('current');
      if (row && row.state) {
        const s = JSON.parse(row.state);
        hasProject = !!((s.main || []).length || (s.overlays || []).length || (s.audio || []).length);
        if (hasProject) {
          projectInfo = s;
          const title = (s.main || []).find(c => c.name)?.name || (s.overlays || []).find(c => c.name)?.name || 'Untitled project';
          $('hmProjectTitle').textContent = title.replace(/\.[^.]+$/, '');
          $('hmProjectMeta').textContent = `${(s.main || []).length} video clip${(s.main || []).length === 1 ? '' : 's'} · ${(s.overlays || []).length} overlay${(s.overlays || []).length === 1 ? '' : 's'} · ${(s.audio || []).length} audio track${(s.audio || []).length === 1 ? '' : 's'} · Saved ${new Date(row.updated || Date.now()).toLocaleDateString()}`;
          pick.r = SHAPES.some(x => x.v === s.ratio) ? s.ratio : pick.r;
        }
      }
    } catch (e) { console.warn('Could not read recent project', e); }
    $('hmRecent').classList.toggle('is-empty', !hasProject);
    $('hmContinue').hidden = !hasProject; $('hmExport').hidden = !hasProject;
    $('hmNoProject').hidden = hasProject;
    home.hidden = false;
    render();
  }

  // Open the dashboard first; Continue opens the project already restored by app.js.
  loadHome();
  const brand = document.querySelector('.brand');
  if (brand) brand.onclick = () => { pick.r = $('aspectRatio').value || pick.r; pick.res = EXP.res; pick.fps = EXP.fps; render(); home.hidden = true; setup.hidden = false; };
  // Let the existing Templates button work from the editor and keep the dashboard reachable by tapping the brand.
})();
