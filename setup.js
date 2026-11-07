/* ProjectMedia Y — persistent mobile home, project library and new-project flow. */
(function () {
  'use strict';
  const PREFKEY = 'pmy-setup-v3';
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
  let pick = { r: '9:16', res: 1080, fps: 30 }, loadingHome = false;
  try {
    const stored = JSON.parse(localStorage.getItem(PREFKEY) || '{}');
    if (SHAPES.some(s => s.v === stored.r)) pick.r = stored.r;
    if (QUALITY.some(q => q.v === stored.res)) pick.res = stored.res;
    if (FPS.some(f => f.v === stored.fps)) pick.fps = stored.fps;
  } catch (_) {}

  const home = document.createElement('section');
  home.id = 'homeScreen'; home.setAttribute('aria-label', 'Project home');
  home.innerHTML = `
    <div class="hm-wrap">
      <header class="hm-brand">
        <img class="brand-mark" src="./favicon.svg" alt="" aria-hidden="true">
        <span class="hm-wordmark"><strong>MediaY</strong><small>VIDEO STUDIO</small></span>
        <span class="hm-pill">EDITOR</span>
      </header>
      <section class="hm-hero">
        <p class="hm-eyebrow">YOUR CREATIVE WORKSPACE</p>
        <h1>A clearer space<br>to shape <em>your video.</em></h1>
        <p class="hm-sub">Pick up an edit or start with a clean timeline. Your projects stay on this device.</p>
      </section>
      <section class="hm-recent" id="hmRecent" aria-labelledby="hmRecentHeading">
        <div class="hm-section-head">
          <div><p class="hm-eyebrow">RECENT PROJECT</p><h2 id="hmProjectTitle">Your last edit</h2></div>
          <span class="hm-project-icon" aria-hidden="true"><i data-lucide="film"></i></span>
        </div>
        <p id="hmProjectMeta" class="hm-meta">Saved on this device</p>
        <button id="hmContinue" class="hm-continue" type="button">
          <span class="hm-play" aria-hidden="true"><i data-lucide="play"></i></span>
          <span class="hm-continue-copy"><b>Continue editing</b><small>Return to your last project</small></span>
          <span class="hm-arrow" aria-hidden="true"><i data-lucide="arrow-right"></i></span>
        </button>
        <p id="hmNoProject" class="hm-empty" hidden>No saved project yet. Start a new edit below; your work will appear here.</p>
      </section>
      <section class="hm-actions" aria-label="Project actions">
        <button id="hmNew" class="hm-new" type="button">
          <span class="hm-action-icon" aria-hidden="true"><i data-lucide="plus"></i></span>
          <span><b>New project</b><small>Start with your own media</small></span>
          <span class="hm-arrow" aria-hidden="true"><i data-lucide="arrow-right"></i></span>
        </button>
        <button id="hmTemplates" class="hm-action" type="button">
          <span class="hm-action-icon" aria-hidden="true"><i data-lucide="layers"></i></span>
          <span><b>My templates</b><small>Reuse a saved layout</small></span>
          <span class="hm-arrow" aria-hidden="true"><i data-lucide="arrow-right"></i></span>
        </button>
        <button id="hmExport" class="hm-export" type="button"><span>Export last project</span><i data-lucide="arrow-up-right" aria-hidden="true"></i></button>
      </section>
      <section class="hm-library" aria-labelledby="hmLibraryHeading">
        <div class="hm-library-head"><h2 id="hmLibraryHeading">My projects</h2><span id="hmProjectCount">0 saved</span></div>
        <div id="hmProjectList"></div>
      </section>
      <footer class="hm-footer"><span>Stored locally on this device.</span><a href="./legal.html">Terms, privacy &amp; licenses</a></footer>
    </div>`;
  document.body.appendChild(home);
  if (window.MediaYIcons) MediaYIcons.render(document);

  const setup = document.createElement('section'); setup.id = 'setup'; setup.setAttribute('aria-label', 'New project'); setup.hidden = true;
  setup.innerHTML = `
    <div class="su-wrap">
      <button id="suBack" class="su-back">← Home</button>
      <div class="su-head"><div class="empty-logo"><img src="./favicon.svg" alt="" aria-hidden="true"></div><h1>Set up your project</h1><p>Choose a format and export settings.</p></div>
      <div><p class="su-label">Video shape</p><div id="suShape" class="su-shapes"></div></div>
      <div><p class="su-label">Export quality</p><div id="suRes" class="su-row q5"></div><p id="suHint" class="su-hint"></p></div>
      <div><p class="su-label">Frames per second</p><div id="suFps" class="su-row"></div></div>
      <div class="su-foot"><p id="suSum"></p><button id="suStart" class="primary wide">Start editing <span aria-hidden="true">→</span></button></div>
    </div>`;
  document.body.appendChild(setup);

  const q = id => setup.querySelector('#' + id);
  const hasContent = (st = S) => !!(st && ((st.main || []).length || (st.overlays || []).length || (st.audio || []).length));
  const hasVideo = (st = S) => !!(st && (st.main || []).length);
  const visibleName = st => {
    const clip = (st.main || []).find(c => c && c.name) || (st.overlays || []).find(c => c && c.name) || (st.audio || []).find(c => c && c.name);
    return clip && clip.name ? clip.name.replace(/\.[^.]+$/, '').slice(0, 80) : 'Untitled project';
  };
  const niceName = v => String(v || 'Untitled project').replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 80) || 'Untitled project';

  function renderSetup() {
    q('suShape').innerHTML = SHAPES.map(s => `<button type="button" data-k="r" data-v="${s.v}" class="${s.v === pick.r ? 'on' : ''}"><i style="width:${s.w}px;height:${s.h}px"></i><b>${s.name}</b><small>${s.sub}</small></button>`).join('');
    q('suRes').innerHTML = QUALITY.map(o => `<button type="button" data-k="res" data-v="${o.v}" class="${o.v === pick.res ? 'on' : ''}"><b>${o.name}</b><small>${o.sub}</small></button>`).join('');
    q('suFps').innerHTML = FPS.map(o => `<button type="button" data-k="fps" data-v="${o.v}" class="${o.v === pick.fps ? 'on' : ''}"><b>${o.name}</b><small>${o.sub}</small></button>`).join('');
    q('suHint').textContent = pick.res >= 1440 ? '2K/4K exports can be slow or run out of memory on phones.' : pick.res === 1080 ? 'Recommended for a clear HD export.' : 'A smaller file and quicker export.';
    q('suSum').textContent = `${pick.r}  ·  ${QUALITY.find(o => o.v === pick.res).name}  ·  ${pick.fps} fps`;
  }
  setup.addEventListener('click', e => {
    const b = e.target.closest('button[data-k]'); if (!b) return;
    pick[b.dataset.k] = b.dataset.k === 'r' ? b.dataset.v : Number(b.dataset.v); renderSetup();
  });

  function showEditor() {
    home.hidden = true; setup.hidden = true;
    const brand = $('brandHome'); if (brand) brand.setAttribute('aria-expanded', 'false');
  }
  function showSetup() {
    pick.r = SHAPES.some(s => s.v === (S.ratio || $('aspectRatio').value)) ? (S.ratio || $('aspectRatio').value) : pick.r;
    home.hidden = true; setup.hidden = false; renderSetup();
  }
  async function applySetup() {
    try { localStorage.setItem(PREFKEY, JSON.stringify(pick)); } catch (_) {}
    EXP.res = pick.res; EXP.fps = pick.fps;
    [['resList', pick.res], ['fpsList', pick.fps]].forEach(([id, v]) => {
      const root = $(id), b = root && root.querySelector(`[data-v="${v}"]`); if (b) b.click();
    });
    const ratio = $('aspectRatio');
    if (ratio && ratio.value !== pick.r) { ratio.value = pick.r; ratio.dispatchEvent(new Event('change')); }
    else if (S.ratio !== pick.r) { S.ratio = pick.r; await rebuildCanvas(); commit(); }
    await saveProject();
    showEditor();
    try { say(`${pick.r} · ${pick.res}p · ${pick.fps} fps. Add media to begin.`); } catch (_) {}
  }
  q('suStart').onclick = applySetup;
  q('suBack').onclick = async () => { await openHome(); };

  // If the user switches away from an unnamed session, give it a real project record first.
  async function preserveCurrentProject() {
    if (activeProjectId === 'current' && hasContent(S)) {
      const id = `project-${uid()}`, name = niceName(visibleName(S)), state = snap(), updated = Date.now();
      await db.projects.put({ id, name, state, updated, kind: 'project' });
      activeProjectId = id; activeProjectName = name;
    }
    await saveProject();
  }

  async function openSavedProject(id) {
    try {
      await preserveCurrentProject();
      const row = await db.projects.get(id);
      if (!row || !row.state) return say('That saved project could not be found.');
      activeProjectId = row.id; activeProjectName = niceName(row.name || visibleName(JSON.parse(row.state)));
      clearTimeout(saveTimer);
      await restore(row.state); t = 0; undoStack = [snap()]; redoStack = [];
      if (S.main.length) await seek(0); refresh(0); await saveProject();
      closeSheet(); showEditor(); say(`Opened “${activeProjectName}”.`);
    } catch (err) { console.error(err); say('Could not open this project: ' + (err.message || err)); }
  }

  async function collectUnreferencedMedia() {
    // Flush the current editor state before calculating references, or a pending edit could lose its media.
    await saveProject();
    const projects = await db.projects.toArray();
    const referenced = new Set();
    for (const row of projects) {
      if (!row || !row.state) continue;
      let state;
      try { state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state; }
      catch (_) {
        console.warn('Media cleanup skipped because a saved project state could not be read.');
        return 0; // Unknown references must never cause user media to be deleted.
      }
      if (!state || typeof state !== 'object' ||
          !Array.isArray(state.main) || !Array.isArray(state.audio) || !Array.isArray(state.overlays)) {
        console.warn('Media cleanup skipped because a saved project has an unsupported state shape.');
        return 0; // Older or partial project records are treated as unknown references.
      }
      for (const lane of [state.main, state.audio, state.overlays]) {
        if (!Array.isArray(lane)) continue;
        for (const item of lane) if (item && item.mediaId) referenced.add(item.mediaId);
      }
    }
    // Saved templates live in localStorage rather than the projects table. Treat an
    // unreadable or unknown template schema as a reason to skip collection: deleting
    // media while references are uncertain would permanently break a user's template.
    const templateRaw = localStorage.getItem('pmy-templates');
    if (templateRaw !== null) {
      let templates;
      try { templates = JSON.parse(templateRaw); }
      catch (_) {
        console.warn('Media cleanup skipped because saved templates could not be read.');
        return 0;
      }
      if (!Array.isArray(templates)) {
        console.warn('Media cleanup skipped because the saved template list has an unsupported shape.');
        return 0;
      }
      for (const template of templates) {
        if (!template || typeof template !== 'object' ||
            !Array.isArray(template.pre) || !Array.isArray(template.post) ||
            !Array.isArray(template.overlays) || !Array.isArray(template.audio)) {
          console.warn('Media cleanup skipped because a saved template has an unsupported shape.');
          return 0;
        }
        for (const lane of [template.pre, template.post, template.overlays, template.audio]) {
          for (const item of lane) if (item && item.mediaId) referenced.add(item.mediaId);
        }
        if (template.slotClip && template.slotClip.mediaId) referenced.add(template.slotClip.mediaId);
      }
    }
    const mediaIds = await db.media.toCollection().primaryKeys();
    const orphanIds = mediaIds.filter(id => !referenced.has(id));
    if (!orphanIds.length) return 0;
    await db.media.bulkDelete(orphanIds);
    for (const id of orphanIds) {
      if (urls[id]) { URL.revokeObjectURL(urls[id]); delete urls[id]; }
      if (audios[id]) {
        try { audios[id].pause(); audios[id].removeAttribute('src'); audios[id].load(); } catch (_) {}
        delete audios[id];
      }
      delete audioLoads[id];
      delete decoded[id];
      delete thumbs[id];
      delete files[id];
    }
    return orphanIds.length;
  }

  // Debounced cleanup after destructive editor/template actions. Never collect while
  // an export or caption transaction may still be reading the media store.
  let mediaGcTimer = null;
  function scheduleMediaGc() {
    clearTimeout(mediaGcTimer);
    mediaGcTimer = setTimeout(async () => {
      if ((typeof exportInProgress !== 'undefined' && exportInProgress) ||
          (typeof captionRunning !== 'undefined' && captionRunning)) {
        scheduleMediaGc();
        return;
      }
      try { await collectUnreferencedMedia(); }
      catch (error) { console.warn('Unused media cleanup was skipped:', error); }
    }, 1500);
  }
  window.scheduleMediaGc = scheduleMediaGc;

  async function deleteSavedProject(id) {
    if (!window.confirm('Delete this saved project? Media used by other projects will be kept; unused imported media may be cleaned up.')) return;
    try {
      await db.projects.delete(id);
      if (activeProjectId === id) {
        activeProjectId = 'current'; activeProjectName = 'Untitled project';
        await saveProject();
      }
      let removedMedia = 0;
      try { removedMedia = await collectUnreferencedMedia(); }
      catch (cleanupError) { console.warn('Unused media cleanup was skipped:', cleanupError); }
      await loadHome();
      say(removedMedia
        ? `Saved project deleted. Cleaned up ${removedMedia} unused media file${removedMedia === 1 ? '' : 's'}.`
        : 'Saved project deleted. Media still used by a project was kept.');
    } catch (err) { say('Could not delete the project: ' + (err.message || err)); }
  }

  async function renderProjectLibrary() {
    const root = $('hmProjectList'), count = $('hmProjectCount');
    root.textContent = '';
    let rows = [];
    try { rows = await db.projects.toArray(); } catch (err) { console.warn('Could not list projects:', err); }
    rows = rows.filter(r => r && r.id !== 'current' && r.state && r.name && r.id !== activeProjectId)
      .sort((a, b) => (b.updated || 0) - (a.updated || 0));
    count.textContent = `${rows.length} saved`;
    if (!rows.length) {
      const p = document.createElement('p'); p.className = 'hm-library-empty';
      p.textContent = 'Named projects you save will appear here. Your current edit is kept above.'; root.appendChild(p); return;
    }
    rows.forEach(row => {
      const item = document.createElement('article'); item.className = 'hm-project-row';
      const info = document.createElement('div'); info.className = 'hm-project-info';
      const name = document.createElement('strong'); name.textContent = row.name || 'Untitled project';
      const meta = document.createElement('small');
      try {
        const st = JSON.parse(row.state);
        meta.textContent = `${(st.main || []).length} video · ${(st.overlays || []).length} overlay · ${new Date(row.updated || Date.now()).toLocaleDateString()}`;
      } catch (_) { meta.textContent = 'Saved on this device'; }
      info.append(name, meta);
      const controls = document.createElement('div'); controls.className = 'hm-project-controls';
      const open = document.createElement('button'); open.className = 'hm-open-project'; open.textContent = 'Open'; open.onclick = () => openSavedProject(row.id);
      const del = document.createElement('button'); del.className = 'hm-delete-project'; del.textContent = 'Delete'; del.onclick = () => deleteSavedProject(row.id);
      controls.append(open, del); item.append(info, controls); root.appendChild(item);
    });
  }

  async function loadHome() {
    if (loadingHome) return;
    loadingHome = true;
    try {
      // Don't race the editor's IndexedDB restore. Still show home even if restore fails.
      if (window.projectMediaReady) await window.projectMediaReady.catch(err => console.warn(err));
      const row = await db.projects.get('current').catch(() => null);
      let st = null;
      if (row && row.state) {
        try { st = JSON.parse(row.state); } catch (_) {}
      }
      const hasRecent = hasContent(st);
      $('hmRecent').classList.toggle('is-empty', !hasRecent);
      $('hmContinue').hidden = !hasRecent;
      $('hmNoProject').hidden = hasRecent;
      $('hmExport').hidden = !hasVideo(st);
      if (hasRecent) {
        const name = row.activeProjectName && row.activeProjectName !== 'Untitled project' ? row.activeProjectName : visibleName(st);
        $('hmProjectTitle').textContent = name;
        const d = new Date(row.updated || Date.now()).toLocaleDateString();
        $('hmProjectMeta').textContent = `${(st.main || []).length} video clip${(st.main || []).length === 1 ? '' : 's'} · ${(st.overlays || []).length} overlay${(st.overlays || []).length === 1 ? '' : 's'} · ${(st.audio || []).length} audio track${(st.audio || []).length === 1 ? '' : 's'} · Saved ${d}`;
        if (SHAPES.some(s => s.v === st.ratio)) pick.r = st.ratio;
      } else {
        $('hmProjectTitle').textContent = 'Your last edit';
        $('hmProjectMeta').textContent = 'Start a project and it will appear here.';
      }
      home.hidden = false; setup.hidden = true; renderSetup(); await renderProjectLibrary();
    } catch (err) {
      console.error('Could not load home screen:', err);
      home.hidden = false; setup.hidden = true;
      try { say('Home is open, but the saved-project list could not be loaded.'); } catch (_) {}
    } finally { loadingHome = false; }
  }

  async function openHome() {
    try { if (typeof stop === 'function') stop(); } catch (_) {}
    try { clearTimeout(saveTimer); await saveProject(); } catch (err) { console.warn('Could not save before opening home:', err); }
    try { if (typeof select === 'function') select(null); if (typeof closeSheet === 'function') closeSheet(); } catch (_) {}
    await loadHome();
  }

  async function startNewProject() {
    try {
      await preserveCurrentProject();
      activeProjectId = 'current'; activeProjectName = 'Untitled project';
      const blank = { ratio: pick.r, main: [], audio: [], overlays: [], nextLayer: 1 };
      clearTimeout(saveTimer); t = 0; sel = null;
      await restore(JSON.stringify(blank));
      undoStack = [snap()]; redoStack = []; drawTimeline(); refresh(0); await saveProject();
      showSetup();
    } catch (err) { console.error(err); say('Could not start a new project: ' + (err.message || err)); }
  }

  $('hmContinue').onclick = showEditor;
  $('hmNew').onclick = startNewProject;
  $('hmTemplates').onclick = () => { showEditor(); openSheet('tpl'); };
  $('hmExport').onclick = () => { showEditor(); $('exportBtn').click(); };
  $('homeBtn').onclick = openHome;
  const brand = $('brandHome');
  if (brand) {
    brand.style.cursor = 'pointer';
    brand.onclick = openHome;
    brand.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHome(); } };
  }
  q('suStart').addEventListener('click', () => {}); // keep the primary action explicitly keyboard-focusable

  // First load always opens the dashboard, not just on the very first installation.
  loadHome();
})();
