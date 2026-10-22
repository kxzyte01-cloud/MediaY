/* ProjectMedia Y — setup.js
   "New project" screen: pick shape, quality and frame rate, then open the editor.
   Load AFTER app.js (uses its globals: $, EXP, db, say). */
(function () {
  const KEY = 'pmy-setup-v1';
  const SHAPES = [
    { v: '16:9', name: 'YouTube', sub: 'wide 16:9', w: 48, h: 27 },
    { v: '9:16', name: 'Shorts & Reels', sub: 'tall 9:16', w: 27, h: 48 },
    { v: '1:1', name: 'Square', sub: '1:1', w: 36, h: 36 }
  ];
  const QUALITY = [
    { v: 480, name: '480p', sub: 'Smallest' },
    { v: 720, name: '720p', sub: 'Fast' },
    { v: 1080, name: '1080p', sub: 'HD' },
    { v: 1440, name: '2K', sub: 'Heavy' },
    { v: 2160, name: '4K', sub: 'Very heavy' }
  ];
  const FPS = [
    { v: 24, name: '24', sub: 'Cinematic' },
    { v: 30, name: '30', sub: 'Standard' },
    { v: 60, name: '60', sub: 'Smooth' }
  ];

  let pick = { r: '9:16', res: 720, fps: 30 };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY)) || {};
    if (SHAPES.some(s => s.v === saved.r)) pick.r = saved.r;
    if (QUALITY.some(q => q.v === saved.res)) pick.res = saved.res;
    if (FPS.some(f => f.v === saved.fps)) pick.fps = saved.fps;
  } catch (e) {}

  const el = document.createElement('section');
  el.id = 'setup';
  el.setAttribute('aria-label', 'New project');
  el.innerHTML = `
    <button id="suClose" aria-label="Close" hidden>✕</button>
    <div class="su-wrap">
      <div class="su-head"><div class="empty-logo">Y</div><h1>What are you making?</h1><p>Pick your settings. You can change them later.</p></div>
      <div><p class="su-label">Video shape</p><div id="suShape" class="su-shapes"></div></div>
      <div><p class="su-label">Quality</p><div id="suRes" class="su-row q5"></div><p id="suHint" class="su-hint"></p></div>
      <div><p class="su-label">Frames per second</p><div id="suFps" class="su-row"></div></div>
      <div class="su-foot"><p id="suSum"></p><button id="suStart" class="primary wide">Start editing</button></div>
    </div>`;
  document.body.appendChild(el);

  const q = id => el.querySelector('#' + id);
  const on = (a, b) => (a === b ? 'on' : '');

  function render() {
    q('suShape').innerHTML = SHAPES.map(s =>
      `<button data-k="r" data-v="${s.v}" class="${on(s.v, pick.r)}"><i style="width:${s.w}px;height:${s.h}px"></i><b>${s.name}</b><small>${s.sub}</small></button>`).join('');
    q('suRes').innerHTML = QUALITY.map(o =>
      `<button data-k="res" data-v="${o.v}" class="${on(o.v, pick.res)}"><b>${o.name}</b><small>${o.sub}</small></button>`).join('');
    q('suFps').innerHTML = FPS.map(o =>
      `<button data-k="fps" data-v="${o.v}" class="${on(o.v, pick.fps)}"><b>${o.name}</b><small>${o.sub}</small></button>`).join('');
    q('suHint').textContent = pick.res >= 1440
      ? 'Very heavy for a phone. The app drops to 1080p if it runs out of memory.'
      : pick.res === 1080 ? 'Best choice for YouTube.' : 'Quick to export.';
    const label = QUALITY.find(o => o.v === pick.res).name;
    q('suSum').textContent = `${pick.r} · ${label} · ${pick.fps} fps`;
  }

  el.addEventListener('click', e => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    pick[k] = k === 'r' ? b.dataset.v : +b.dataset.v;
    render();
  });

  function apply() {
    try { localStorage.setItem(KEY, JSON.stringify(pick)); } catch (e) {}
    EXP.res = pick.res; EXP.fps = pick.fps;
    // keep the Export sheet's pills highlighted to match
    [['resList', pick.res], ['fpsList', pick.fps]].forEach(([id, v]) => {
      const b = $(id) && $(id).querySelector(`[data-v="${v}"]`); if (b) b.click();
    });
    const ar = $('aspectRatio');
    if (ar.value !== pick.r) { ar.value = pick.r; ar.dispatchEvent(new Event('change')); }
    el.hidden = true;
    try { say(`${pick.r} · ${q('suSum').textContent.split(' · ')[1]} · ${pick.fps} fps. Tap Media to add clips.`); } catch (e) {}
  }
  q('suStart').onclick = apply;
  q('suClose').onclick = () => { el.hidden = true; };

  // Tap the Y logo in the editor to reopen this screen.
  const brand = document.querySelector('.brand');
  if (brand) brand.onclick = () => {
    if ($('aspectRatio').value) pick.r = $('aspectRatio').value;
    pick.res = EXP.res; pick.fps = EXP.fps;
    render(); q('suClose').hidden = false; el.hidden = false;
  };

  // If a project was restored, go straight to the editor.
  db.projects.get('current').then(row => {
    if (!row) return;
    const s = JSON.parse(row.state);
    if ((s.main || []).length || (s.overlays || []).length || (s.audio || []).length) el.hidden = true;
  }).catch(() => {});

  render();
})();
