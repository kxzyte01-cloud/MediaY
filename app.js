/* ProjectMedia Y — app.js
   Libraries: Fabric.js (layers), Anime.js (motion), Dexie (storage), FFmpeg.wasm (export, loaded on first Export) */
'use strict';
const $ = id => document.getElementById(id);
const RATIOS = { '9:16': [540, 960], '16:9': [960, 540], '1:1': [720, 720] };
const FX = [
  { n: 'Original', c: '', f: '' },
  { n: 'Vivid', c: 'saturate(1.5) contrast(1.1)', f: 'eq=saturation=1.5:contrast=1.1' },
  { n: 'Warm', c: 'sepia(.25) saturate(1.3)', f: 'colorbalance=rs=.15:bs=-.15,eq=saturation=1.2' },
  { n: 'Cool', c: 'hue-rotate(-12deg) saturate(1.1)', f: 'colorbalance=rs=-.12:bs=.15' },
  { n: 'Mono', c: 'grayscale(1)', f: 'hue=s=0' },
  { n: 'Noir', c: 'grayscale(1) contrast(1.5) brightness(.9)', f: 'hue=s=0,eq=contrast=1.5:brightness=-.05' },
  { n: 'Fade', c: 'contrast(.85) brightness(1.1) saturate(.8)', f: 'eq=contrast=.85:brightness=.06:saturation=.8' },
  { n: 'Retro', c: 'sepia(.7) contrast(1.1)', f: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131' },
  { n: 'Cinema', c: 'contrast(1.2) saturate(.9) brightness(.95)', f: 'eq=contrast=1.2:saturation=.9:brightness=-.03,vignette=PI/5' }];
const TS = [ // text styles
  () => ({ fill: '#fff', stroke: '#000', strokeWidth: 2 }),
  () => ({ fill: '#fff', strokeWidth: 0, shadow: new fabric.Shadow({ color: '#ff2d95', blur: 26 }) }),
  () => ({ fill: '#111', strokeWidth: 0, backgroundColor: '#ffe14a' }),
  () => ({ fill: '#ffe14a', stroke: '#000', strokeWidth: 5, fontStyle: 'italic', paintFirst: 'stroke' }),
  () => ({ fill: '#fff', strokeWidth: 0, backgroundColor: '#c8101e', fontSize: 44 }),
  () => ({ fill: '#fff', strokeWidth: 0, backgroundColor: '#0b2a5b', fontSize: 40 })];
const PX = 30; // timeline pixels per second
const uid = () => Math.random().toString(36).slice(2, 10);
const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const say = m => ($('status').textContent = m);

// Shared blocking progress UI for long-running media tasks.
function updateBusy(title, detail, progress = null, stage = 'Working') {
  const overlay = $('busyOverlay');
  if (!overlay) return;
  overlay.hidden = false;
  overlay.dataset.state = 'busy';
  document.body.setAttribute('aria-busy', 'true');
  $('busyDismiss').hidden = true;
  if (title != null) $('busyTitle').textContent = title;
  if (detail != null) $('busyDetail').textContent = detail;
  $('busyStage').textContent = stage;
  const bar = $('busyProgress'), label = $('busyPercent');
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    const value = Math.max(0, Math.min(100, progress));
    bar.value = value;
    label.textContent = Math.round(value) + '%';
  } else {
    bar.removeAttribute('value');
    label.textContent = '';
  }
}
function showBusyError(title, detail) {
  updateBusy(title, detail, null, 'Needs attention');
  const overlay = $('busyOverlay');
  if (overlay) overlay.dataset.state = 'error';
  $('busyDismiss').hidden = false;
}
function hideBusy() {
  const overlay = $('busyOverlay');
  if (overlay) { overlay.hidden = true; delete overlay.dataset.state; }
  document.body.removeAttribute('aria-busy');
}
$('busyDismiss').onclick = hideBusy;

/* ---------- Database (Dexie): media blobs + project state ---------- */
const db = new Dexie('projectmedia-y');
db.version(1).stores({ projects: 'id', media: 'id' });
const urls = {};      // mediaId -> object URL
const files = {};     // mediaId -> Blob
async function storeMedia(file) {
  const id = uid();
  await db.media.put({ id, name: file.name, type: file.type, blob: file }); // copied into IndexedDB
  files[id] = file; urls[id] = URL.createObjectURL(file);
  return id;
}
async function loadMedia(id) {
  if (urls[id]) return urls[id];
  const row = await db.media.get(id);
  if (!row || !row.blob) return null;
  // Preserve the original name/type after IndexedDB restores a Blob, so FFmpeg can
  // choose the appropriate input suffix for saved projects and reusable templates.
  const blob = row.blob;
  files[id] = (typeof File !== 'undefined' && blob instanceof File)
    ? blob
    : new File([blob], row.name || `${id}.bin`, { type: row.type || blob.type || 'application/octet-stream' });
  return (urls[id] = URL.createObjectURL(files[id]));
}

// Decode template image media before changing the active project. Some mobile pickers
// supply images in a browser-supported-but-not-HTMLImageElement-friendly format, or with
// a MIME type/extension that does not match the actual encoding. Fall back to bitmap decode
// and normalize it to PNG so the template can reuse the same durable media ID.
const decodeImageElement = (src, label) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error(`Could not decode overlay image “${label}”.`));
  image.src = src;
});
async function loadOverlayImage(url, overlay) {
  const label = overlay.name || 'unnamed image';
  try {
    return await decodeImageElement(url, label);
  } catch (firstError) {
    const row = await db.media.get(overlay.mediaId).catch(() => null);
    const source = files[overlay.mediaId] || (row && row.blob);
    if (!source || typeof createImageBitmap !== 'function') {
      throw new Error(`Could not read overlay image “${label}”. Re-import it as a standard JPG or PNG and save the template again.`);
    }
    let bitmap;
    try {
      bitmap = await createImageBitmap(source);
    } catch (_) {
      throw new Error(`Overlay image “${label}” is missing, damaged, or in a format this browser cannot decode. Re-import a standard JPG or PNG and save the template again.`);
    }
    try {
      const normalized = document.createElement('canvas');
      normalized.width = bitmap.width;
      normalized.height = bitmap.height;
      const ctx = normalized.getContext('2d');
      if (!ctx) throw new Error('Could not create an image conversion canvas.');
      ctx.drawImage(bitmap, 0, 0);
      const png = await new Promise((resolve, reject) => normalized.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not convert the overlay image to PNG.')), 'image/png'));
      const name = `${label.replace(/\\.[^.]+$/, '') || 'overlay'}.png`;
      const file = new File([png], name, { type: 'image/png', lastModified: Date.now() });
      await db.media.put({ id: overlay.mediaId, name, type: 'image/png', blob: file });
      files[overlay.mediaId] = file;
      if (urls[overlay.mediaId]) URL.revokeObjectURL(urls[overlay.mediaId]);
      urls[overlay.mediaId] = URL.createObjectURL(file);
      return await decodeImageElement(urls[overlay.mediaId], name);
    } finally {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    }
  }
}
async function validateTemplateAssets(template) {
  for (const overlay of template.overlays || []) {
    if (overlay.type === 'text' || !overlay.mediaId) continue;
    const url = await loadMedia(overlay.mediaId);
    if (!url) throw new Error(`Template media for “${overlay.name || overlay.type}” is missing from local storage. Re-import the original image/video and save the template again.`);
    if (overlay.type === 'image') {
      await loadOverlayImage(url, overlay);
    } else if (overlay.type === 'video') {
      const element = document.createElement('video');
      element.preload = 'metadata';
      element.muted = true;
      await new Promise((resolve, reject) => {
        element.onloadedmetadata = () => resolve();
        element.onerror = () => reject(new Error(`Template overlay video “${overlay.name || 'unnamed video'}” cannot be decoded in this browser. Convert it to MP4 and save the template again.`));
        element.src = url;
      });
    }
  }
}

/* ---------- State (single source of truth) ---------- */
let S = { ratio: '16:9', main: [], audio: [], overlays: [], nextLayer: 1 };
let sel = null, t = 0, playing = false, undoStack = [], redoStack = [], saveTimer;
// The current row is the crash-safe resume checkpoint. Named project rows live beside it.
let activeProjectId = 'current', activeProjectName = 'Untitled project';
const dur = c => (c.out - c.in) / (c.speed || 1);
const total = () => S.main.reduce((a, c) => a + dur(c), 0);
const video = $('sourceVideo');

/* ---------- Fabric canvas ---------- */
const canvas = new fabric.Canvas('overlayCanvas', { enableRetinaScaling: false, preserveObjectStacking: true, selection: false });
Object.assign(canvas.wrapperEl.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', maxWidth: '100%', maxHeight: '100%' });
// Fabric creates a fixed-pixel wrapper by default. Force it to follow the responsive preview frame.
canvas.wrapperEl.style.zIndex = '2';
function sizeCanvas() {
  const [w, h] = RATIOS[S.ratio];
  canvas.setDimensions({ width: w, height: h });
  canvas.setDimensions({ width: '100%', height: '100%' }, { cssOnly: true });
  $('previewFrame').style.aspectRatio = `${w} / ${h}`;
  $('previewFrame').style.width = `min(100%, calc(100cqh * ${w / h}))`;
  $('previewFrame').style.maxWidth = 'none';
  $('aspectRatio').value = S.ratio; markRatio();
}
// Locked layering: every overlay keeps its own layer number. Stack order always comes from it.
function restack() {
  canvas._objects.sort((a, b) => a.layer - b.layer);
  canvas.requestRenderAll();
}
canvas.on('object:modified', e => {
  const o = S.overlays.find(x => x.id === e.target.pmId); if (!o) return;
  Object.assign(o, { left: e.target.left, top: e.target.top, scaleX: e.target.scaleX, scaleY: e.target.scaleY, angle: e.target.angle });
  commit();
});
canvas.on('selection:created', e => select(e.selected[0].pmId));
canvas.on('selection:updated', e => select(e.selected[0].pmId));
canvas.on('selection:cleared', () => { if (sel && sel.lane === 'overlay') select(null); });

async function buildObject(o) {
  const [w, h] = RATIOS[S.ratio];
  let obj;
  if (o.type === 'text') {
    obj = new fabric.Textbox(o.text, { width: w * 0.8, fontFamily: 'DM Sans', fontWeight: 700, fontSize: 56, textAlign: 'center', ...TS[o.style || 0]() });
  } else {
    const url = await loadMedia(o.mediaId); if (!url) return;
    let el;
    if (o.type === 'video') {
      el = document.createElement('video'); el.src = url; el.muted = true; el.playsInline = true; o.el = el;
      await new Promise((resolve, reject) => { el.onloadeddata = resolve; el.onerror = () => reject(new Error('Could not read this overlay video. Try converting it to MP4.')); });
      el.width = el.videoWidth; el.height = el.videoHeight;
      obj = new fabric.Image(el);
    } else {
      el = await loadOverlayImage(url, o);
      obj = new fabric.Image(el);
    }
    if (o.scaleX == null) { o.scaleX = o.scaleY = (w * 0.4) / obj.width; }
  }
  Object.assign(obj, { pmId: o.id, layer: o.layer });
  obj.set({ left: o.left ?? w * 0.1, top: o.top ?? h * 0.1, scaleX: o.scaleX ?? 1, scaleY: o.scaleY ?? 1, angle: o.angle || 0, cornerSize: 22, transparentCorners: false });
  Object.assign(o, { left: obj.left, top: obj.top, scaleX: obj.scaleX, scaleY: obj.scaleY });
  if (o.key && obj.applyFilters) { obj.filters = [keyFilter(o.key)]; obj.applyFilters(); }
  canvas.add(obj); restack(); return obj;
}
async function rebuildCanvas() {
  canvas.clear(); sizeCanvas();
  for (const o of [...S.overlays].sort((a, b) => a.layer - b.layer)) await buildObject(o);
  refresh(t);
}
const objOf = id => canvas.getObjects().find(x => x.pmId === id);

/* ---------- Undo / save ---------- */
const snap = () => JSON.stringify(S, (k, v) => (k === 'el' ? undefined : v));
function commit() {
  undoStack.push(snap()); if (undoStack.length > 50) undoStack.shift(); redoStack = [];
  drawTimeline(); clearTimeout(saveTimer); saveTimer = setTimeout(() => saveProject().catch(err => { console.warn('Auto-save failed:', err); say('Auto-save failed. Check available storage on this device.'); }), 800);
}
function normalizeState(value) {
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  return {
    ...raw,
    ratio: RATIOS[raw && raw.ratio] ? raw.ratio : '16:9',
    main: Array.isArray(raw && raw.main) ? raw.main : [],
    audio: Array.isArray(raw && raw.audio) ? raw.audio : [],
    overlays: Array.isArray(raw && raw.overlays) ? raw.overlays : [],
    nextLayer: Number.isFinite(raw && raw.nextLayer) ? raw.nextLayer : 1
  };
}
async function restore(json) { S = normalizeState(json); sel = null; await rebuildCanvas(); drawTimeline(); }
$('undoBtn').onclick = async () => { if (undoStack.length < 2) return; redoStack.push(undoStack.pop()); await restore(undoStack[undoStack.length - 1]); };
$('redoBtn').onclick = async () => { if (!redoStack.length) return; const s = redoStack.pop(); undoStack.push(s); await restore(s); };
async function saveProject() {
  const state = snap(), updated = Date.now();
  // Keep one always-up-to-date resume checkpoint, even when editing a named project.
  await db.projects.put({ id: 'current', state, updated, activeProjectId, activeProjectName });
  if (activeProjectId !== 'current') {
    await db.projects.put({ id: activeProjectId, name: activeProjectName || 'Untitled project', state, updated, kind: 'project' });
  }
  say(activeProjectId === 'current' ? 'Saved on this device.' : `Saved “${activeProjectName}”.`);
}
$('saveBtn').onclick = async () => {
  const suggested = activeProjectName && activeProjectName !== 'Untitled project' ? activeProjectName :
    ((S.main[0] && S.main[0].name) || (S.overlays[0] && S.overlays[0].name) || 'My video project').replace(/\.[^.]+$/, '');
  const entered = window.prompt(activeProjectId === 'current' ? 'Name this project:' : 'Save project as:', suggested);
  if (entered == null) return;
  const name = entered.trim() || suggested;
  if (activeProjectId === 'current') activeProjectId = `project-${uid()}`;
  activeProjectName = name.slice(0, 80);
  try { await saveProject(); } catch (err) { console.error(err); say('Could not save this project: ' + (err.message || err)); }
};

/* ---------- Import ---------- */
$('importBtn').onclick = () => { $('mediaInput').accept = 'video/*,image/*,audio/*'; $('mediaInput').click(); };
$('audioBtn').onclick = () => { $('mediaInput').accept = 'audio/*'; $('mediaInput').click(); };
$('mediaInput').onchange = async e => {
  const selected = [...(e.target.files || [])]; e.target.value = '';
  if (!selected.length) return;
  say('Importing…'); let added = 0;
  updateBusy('Importing media…', 'Preparing the selected files.', 0, 'Import');
  try {
    for (let fileIndex = 0; fileIndex < selected.length; fileIndex++) {
      const f = selected[fileIndex];
      updateBusy('Importing media…', `Reading ${f.name} (${fileIndex + 1} of ${selected.length}).`, (fileIndex / Math.max(1, selected.length)) * 100, 'Import');
      const mediaId = await storeMedia(f);
      const isImage = f.type.startsWith('image'), isAudio = f.type.startsWith('audio'), isVideo = f.type.startsWith('video');
      if (isImage) { await addOverlay({ type: 'image', mediaId, name: f.name, start: t, dur: 5 }); added++; continue; }
      if (!isAudio && !isVideo) throw new Error(`Unsupported file type: ${f.name}`);
      const length = await probe(urls[mediaId], isAudio ? 'audio' : 'video');
      if (!Number.isFinite(length) || length <= 0) throw new Error(`Could not read ${f.name}. Try a standard MP4/MOV video or MP3/M4A audio file.`);
      if (isVideo) S.main.push({ id: uid(), mediaId, name: f.name, in: 0, out: length, src: length });
      else S.audio.push({ id: uid(), mediaId, name: f.name, start: t, in: 0, out: length, src: length });
      added++;
    }
    commit(); if (S.main.length) await seek(Math.min(t, total())); refresh(Math.min(t, total())); say(`${added} media file${added === 1 ? '' : 's'} added.`);
  } catch (err) {
    commit(); refresh(t); console.error(err); say('Import stopped: ' + (err.message || err));
  }
  hideBusy();
};
const probe = (url, kind = 'video') => new Promise(resolve => {
  const m = document.createElement(kind === 'audio' ? 'audio' : 'video'); m.preload = 'metadata';
  const done = value => { m.onloadedmetadata = null; m.onerror = null; resolve(Number.isFinite(value) ? value : 0); };
  m.onloadedmetadata = () => done(m.duration); m.onerror = () => done(0); m.src = url;
});

/* ---------- Overlays (PiP, stickers, text) ---------- */
async function addOverlay(o) {
  o = { id: uid(), layer: S.nextLayer++, dur: 3, start: t, ...o };
  S.overlays.push(o);
  const obj = await buildObject(o);
  if (obj && o.type === 'text') anime({ targets: obj, opacity: [0, 1], top: [obj.top + 50, obj.top], duration: 700, easing: 'easeOutElastic(1, .6)', update: () => canvas.requestRenderAll() });
  commit();
}
$('textBtn').onclick = () => openSheet('text');
const pipInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'video/*,image/*', hidden: true });
document.body.appendChild(pipInput);
$('pipBtn').onclick = () => { pipInput.dataset.replace = sel && sel.lane === 'overlay' ? sel.id : ''; pipInput.click(); };
pipInput.onchange = async () => {
  const f = pipInput.files && pipInput.files[0]; if (!f) return;
  pipInput.value = '';
  try {
    const mediaId = await storeMedia(f), type = f.type.startsWith('video') ? 'video' : f.type.startsWith('image') ? 'image' : '';
    if (!type) throw new Error('Choose a picture or video for an overlay.');
    const rid = pipInput.dataset.replace;
    if (rid) { // Keep the layer's position and timing when replacing an overlay.
      const o = S.overlays.find(x => x.id === rid); if (!o) throw new Error('The selected overlay no longer exists.');
      const old = objOf(rid); if (old) canvas.remove(old);
      Object.assign(o, { mediaId, type, name: f.name }); delete o.el; delete o.scaleX; delete o.scaleY;
      await buildObject(o); restack(); commit(); refresh(t); say('Overlay replaced.');
    } else {
      const length = type === 'video' ? await probe(urls[mediaId], 'video') : 5;
      if (type === 'video' && (!Number.isFinite(length) || length <= 0)) throw new Error('Could not read this video. Try an MP4 or MOV file.');
      await addOverlay({ type, mediaId, name: f.name, dur: length });
      refresh(t); say('Overlay added. Drag it in the preview to position it.');
    }
  } catch (err) { console.error(err); say('Could not add overlay: ' + (err.message || err)); }
};

/* ---------- Timeline ---------- */
function select(id, lane) {
  const L = lane || (S.main.some(c => c.id === id) ? 'main' : S.audio.some(c => c.id === id) ? 'audio' : S.overlays.some(c => c.id === id) ? 'overlay' : null);
  sel = id ? { id, lane: L } : null;
  if (L === 'overlay') { const ob = objOf(id); if (ob && canvas.getActiveObject() !== ob) canvas.setActiveObject(ob); } else canvas.discardActiveObject();
  drawTimeline();
}
const tl = $('tl'), inner = $('tlInner');
let drag = null, lastScroll = 0;
const itemOf = (id, lane) => (lane === 'main' ? S.main : lane === 'audio' ? S.audio : S.overlays).find(x => x.id === id);
const lenOf = (c, lane) => (lane === 'overlay' ? c.dur : lane === 'main' ? dur(c) : c.out - c.in);
const startOf = (c, lane) => (lane === 'main' ? S.main.slice(0, S.main.indexOf(c)).reduce((a, x) => a + dur(x), 0) : c.start);
const thumbs = {};
async function thumb(c, el) { // one preview frame per clip, cached
  const k = c.mediaId + ':' + Math.round(c.in);
  thumbs[k] = thumbs[k] || (async () => {
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = await loadMedia(c.mediaId);
    await new Promise(r => { v.onloadeddata = r; v.onerror = r; }); v.currentTime = c.in + 0.05; await new Promise(r => { v.onseeked = r; });
    const cv = document.createElement('canvas'); cv.height = 56; cv.width = Math.round(56 * (v.videoWidth / v.videoHeight || 0.56));
    cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height); return cv.toDataURL('image/jpeg', 0.6);
  })().catch(() => '');
  const u = await thumbs[k]; if (u) el.style.backgroundImage = `url(${u})`;
}
const decoded = {}; let actx;
async function wave(a, el) {
  try {
    decoded[a.mediaId] = decoded[a.mediaId] || (async () => { await loadMedia(a.mediaId); if (files[a.mediaId].size > 40e6) throw 0; actx = actx || new (window.AudioContext || window.webkitAudioContext)(); return actx.decodeAudioData(await files[a.mediaId].arrayBuffer()); })();
    const buf = await decoded[a.mediaId], ch = buf.getChannelData(0), rate = buf.sampleRate, len = a.out - a.in, n = Math.max(1, Math.round(len * PX / 3)), step = Math.max(1, Math.floor(len * rate / n)), off = Math.floor(a.in * rate);
    const cv = document.createElement('canvas'); cv.width = n * 3; cv.height = 30; const g = cv.getContext('2d'); g.fillStyle = 'rgba(255,255,255,.75)';
    for (let i = 0; i < n; i++) { let m = 0; for (let j = 0; j < step; j += 24) m = Math.max(m, Math.abs(ch[off + i * step + j] || 0)); const h = Math.max(2, Math.min(1, m * 1.6) * 28); g.fillRect(i * 3, (30 - h) / 2, 2, h); }
    Object.assign(el.style, { backgroundImage: `url(${cv.toDataURL()})`, backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat' });
  } catch (e) { /* too big or undecodable: keep the plain bars */ }
}
const pack = (items, st, ln) => { const rows = []; return [...items].sort((a, b) => st(a) - st(b)).map(c => { let r = c.row || 0; while (rows[r] > st(c) + 1e-6) r++; rows[r] = st(c) + ln(c); return [c, r]; }); };
function drawTimeline() {
  const d = total(); inner.textContent = ''; inner.style.width = Math.max(d, 1) * PX + 'px';
  const mk = (cls, h) => { const e = document.createElement('div'); e.className = cls; if (h) e.style.height = h + 'px'; inner.appendChild(e); return e; };
  const ruler = mk('ruler'); for (let s = 0; s <= Math.ceil(d); s++) { const i = document.createElement('i'); i.style.left = s * PX + 'px'; ruler.appendChild(i); if (s % 2 === 0) { const b = document.createElement('b'); b.style.left = s * PX + 'px'; b.textContent = fmt(s); ruler.appendChild(b); } }
  const add = (lane, el, c, st, ln, top, h, cls, label) => {
    const b = document.createElement('div'), on = sel && sel.id === c.id; b.className = `clip ${cls}` + (on ? ' sel' : '');
    Object.assign(b.style, { left: st * PX + 'px', width: Math.max(ln * PX, 18) + 'px', top: top + 'px', height: h + 'px' });
    b.dataset.id = c.id; b.dataset.lane = lane; b.append(label);
    if (on) ['l', 'r'].forEach(side => { const h = document.createElement('i'); h.className = 'h ' + side; h.dataset.side = side; b.appendChild(h); });
    el.appendChild(b); return b;
  };
  const V = mk('lane', 56); let acc = 0;
  S.main.forEach(c => { const l = dur(c); thumb(c, add('main', V, c, acc, l, 0, 56, 'video-clip', (c.fx ? '✦ ' + FX[c.fx].n + ' ' : '') + (c.fade ? '◐ ' : '') + (c.speed && c.speed !== 1 ? c.speed + '× ' : '') + (c.tr ? '⇄ ' : '') + (c.vol === 0 ? '🔇 ' : '') + (c.rev ? '⟲ ' : ''))); acc += l; });
  const po = pack(S.overlays, o => o.start, o => o.dur), O = mk('lane', Math.max(1, ...po.map(x => x[1] + 1)) * 34);
  po.forEach(([o, r]) => add('overlay', O, o, o.start, o.dur, r * 34, 30, 'ov-clip', o.type === 'text' ? o.text : o.name));
  const pa = pack(S.audio, a => a.start, a => a.out - a.in), A = mk('lane', Math.max(1, ...pa.map(x => x[1] + 1)) * 34);
  pa.forEach(([a, r]) => wave(a, add('audio', A, a, a.start, a.out - a.in, r * 34, 30, 'audio-clip', (a.vol === 0 ? '🔇 ' : '♪ ') + a.name)));
  $('timeDisplay').textContent = `${fmt(t)} / ${fmt(d)}`;
  hints(V, O, A); updateChrome();
}
const snapT = v => { let a = 0; const e = [0, t, ...S.main.map(c => (a += dur(c)))].find(x => Math.abs(x - v) < 8 / PX); return e != null ? e : v; };
function clampTrim(c, lane, side, dt) {
  const sp = lane === 'main' ? c.speed || 1 : 1, len = lenOf(c, lane), max = lane === 'overlay' ? 36000 : ((c.src || c.out) - c.in) / sp;
  if (side === 'r') return Math.min(Math.max(dt, 0.2 - len), max - len);
  const lo = lane === 'main' ? -c.in / sp : lane === 'audio' ? -Math.min(c.in, c.start) : -c.start;
  return Math.min(Math.max(dt, lo), len - 0.2);
}
function applyTrim(c, lane, side, dt) {
  const sp = lane === 'main' ? c.speed || 1 : 1;
  if (side === 'r') { if (lane === 'overlay') c.dur += dt; else c.out += dt * sp; }
  else if (lane === 'overlay') { c.start += dt; c.dur -= dt; } else { c.in += dt * sp; if (lane === 'audio') c.start += dt; }
}
function hints(V, O, A) {
  const h = (el, txt, id) => { const b = document.createElement('button'); b.className = 'lane-hint'; b.textContent = txt; b.onclick = () => $(id).click(); el.appendChild(b); };
  if (!S.main.length) h(V, '＋ Tap to add your video', 'importBtn');
  if (!S.overlays.length) h(O, '＋ Add photo, logo or video on top', 'pipBtn');
  if (!S.audio.length) h(A, '＋ Add music or voice-over', 'audioBtn');
}
function updateChrome() {
  $('emptyState').hidden = !!(S.main.length || S.overlays.length || S.audio.length);
  const on = !!sel; $('dockMain').hidden = on; $('dockEdit').hidden = !on;
  if (on) { document.querySelectorAll('#dockEdit [data-for]').forEach(b => (b.hidden = !b.dataset.for.split(' ').includes(sel.lane))); $('styleBtn').hidden = !textSel(); $('keyBtn').hidden = !keyOv(); }
  let off = false; try { off = !!localStorage.getItem('pmy-tips-off'); } catch (e) {}
  $('tipBar').hidden = off;
  $('tip').textContent = pendingRep ? 'Tap the clip on the timeline that you want to replace.' : !S.main.length ? 'Tap “Import media” to add your first video.' : on ? 'Hold and drag a clip to move it. Drag the white ends to trim it.' : 'Swipe the timeline to move. Tap a clip to edit it.';
}
function keyFilter(k) { return new fabric.Image.filters.RemoveColor({ color: k.color, distance: 0.1 + k.sim / 100 * 0.5 }); }
function restackRows() { // higher row on screen = in front, like other editors
  pack(S.overlays, o => o.start, o => o.dur).sort((a, b) => b[1] - a[1] || a[0].layer - b[0].layer).forEach(([o], i) => { o.layer = i + 1; const ob = objOf(o.id); if (ob) ob.layer = o.layer; });
  S.nextLayer = S.overlays.length + 1; restack();
}
function autoScroll() { if (!drag || drag.mode !== 'move' || !drag.edge) { if (drag) drag.auto = false; return; } tl.scrollLeft += drag.edge * 10; tl.dispatchEvent(new PointerEvent('pointermove', { clientX: drag.cx, clientY: drag.cy, pointerType: 'touch' })); requestAnimationFrame(autoScroll); }
function lift() { const c = itemOf(drag.id, drag.lane); if (!c) return; drag.mode = 'move'; navigator.vibrate && navigator.vibrate(15); select(c.id, drag.lane); drag.el = tl.querySelector(`[data-id="${c.id}"]`); drag.el && drag.el.classList.add('lift'); }
tl.addEventListener('pointerdown', e => {
  if (playing) stop();
  const b = e.target.closest('.clip'); if (!b) return; const lane = b.dataset.lane, c = itemOf(b.dataset.id, lane); if (!c) return;
  const side = e.target.dataset.side;
  drag = { id: c.id, lane, x: e.clientX, side, mode: side ? 'trim' : 'wait', el: b, s0: startOf(c, lane), len: lenOf(c, lane), sl0: tl.scrollLeft, y0: e.clientY, r0: Math.round((parseFloat(b.style.top) || 0) / 34) };
  tl.setPointerCapture(e.pointerId);
  if (!side) drag.timer = setTimeout(() => drag && drag.mode === 'wait' && lift(), 320);
});
tl.addEventListener('pointermove', e => {
  if (!drag) return; drag.cx = e.clientX; drag.cy = e.clientY; const dx = e.clientX - drag.x + (drag.mode === 'move' ? tl.scrollLeft - drag.sl0 : 0), c = itemOf(drag.id, drag.lane); if (!c) return;
  if (drag.mode === 'wait') { if (Math.abs(dx) > 8) { if (e.pointerType === 'mouse') { clearTimeout(drag.timer); lift(); } else { clearTimeout(drag.timer); drag = null; } } return; }
  if (!drag.el) return;
  if (drag.mode === 'trim') {
    const dt = (drag.dt = clampTrim(c, drag.lane, drag.side, dx / PX)), r = drag.side === 'r', st = drag.lane === 'main' ? drag.s0 : drag.s0 + (r ? 0 : dt);
    drag.el.style.left = st * PX + 'px'; drag.el.style.width = Math.max((drag.len + (r ? dt : -dt)) * PX, 18) + 'px';
  } else if (drag.lane === 'main') drag.el.style.transform = `translateX(${dx}px)`;
  else { drag.ns = snapT(Math.max(0, drag.s0 + dx / PX)); drag.el.style.left = drag.ns * PX + 'px'; const nr = Math.max(0, Math.min(Math.floor(drag.el.parentElement.offsetHeight / 34), Math.round(drag.r0 + (e.clientY - drag.y0) / 34))); drag.nr = nr; drag.el.style.top = nr * 34 + 'px'; }
  if (drag.mode === 'move') { const r = tl.getBoundingClientRect(); drag.edge = e.clientX < r.left + 50 ? -1 : e.clientX > r.right - 50 ? 1 : 0; if (drag.edge && !drag.auto) { drag.auto = true; autoScroll(); } }
});
tl.addEventListener('pointerup', e => {
  if (!drag) return; clearTimeout(drag.timer); const d = drag, c = itemOf(d.id, d.lane); drag = null; if (!c) return;
  if (d.mode === 'wait') { select(c.id, d.lane); if (pendingRep) applyRep(c.id, d.lane); return; }
  if (d.mode === 'trim') applyTrim(c, d.lane, d.side, d.dt || 0);
  else if (d.lane === 'main') {
    const cx = d.s0 + d.len / 2 + (e.clientX - d.x + tl.scrollLeft - d.sl0) / PX; let acc = 0, idx = 0;
    S.main.filter(x => x !== c).forEach(x => { const l = dur(x); if (acc + l / 2 < cx) idx++; acc += l; });
    S.main.splice(S.main.indexOf(c), 1); S.main.splice(idx, 0, c);
  } else { if (d.ns != null) c.start = d.ns; if (d.nr != null && d.nr !== d.r0) { c.row = d.nr; if (d.lane === 'overlay') restackRows(); } }
  commit(); seek(t).then(() => refresh(t));
});
tl.addEventListener('pointercancel', () => { if (drag) { clearTimeout(drag.timer); drag = null; drawTimeline(); } });
tl.addEventListener('touchmove', e => { if (drag && drag.mode !== 'wait') e.preventDefault(); }, { passive: false });
tl.addEventListener('contextmenu', e => e.preventDefault());
tl.addEventListener('scroll', () => { if (drag) return; const x = tl.scrollLeft / PX; if (Math.abs(x - t) < 1.5 / PX) return; lastScroll = Date.now(); $('playhead').oninput({ target: { time: Math.min(x, total()) } }); });
['dragover', 'drop'].forEach(ev => document.addEventListener(ev, e => { // drop files from another app / desktop
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return; e.preventDefault();
  if (ev === 'drop') { $('mediaInput').files = e.dataTransfer.files; $('mediaInput').dispatchEvent(new Event('change')); }
}));

/* ---------- Playback + anti-scrub jamming ---------- */
function locate(time) {
  let acc = 0;
  for (const c of S.main) { const d = dur(c); if (time < acc + d || c === S.main[S.main.length - 1]) return { c, local: Math.min(Math.max(time - acc, 0), d), start: acc }; acc += d; }
  return null;
}
async function seek(time) {
  const hit = locate(time); if (!hit) return;
  const url = await loadMedia(hit.c.mediaId);
  if (!url) { video.pause(); video.style.display = 'none'; say(`Missing media for ${hit.c.name || 'this clip'}. Re-import the file to continue.`); return; }
  video.style.display = 'block'; $('emptyState').hidden = true;
  if (video.dataset.mid !== hit.c.mediaId) {
    video.dataset.mid = hit.c.mediaId;
    await new Promise((resolve, reject) => {
      const clean = () => { video.removeEventListener('loadedmetadata', ready); video.removeEventListener('error', failed); };
      const ready = () => { clean(); resolve(); };
      const failed = () => { clean(); reject(new Error('The selected video could not be decoded on this device.')); };
      video.addEventListener('loadedmetadata', ready, { once: true }); video.addEventListener('error', failed, { once: true });
      video.src = url; video.load();
    }).catch(err => { video.style.display = 'none'; say(err.message || 'Could not load video.'); });
    if (video.style.display === 'none') return;
  }
  const target = hit.c.in + hit.local * (hit.c.speed || 1);
  if (video.fastSeek) video.fastSeek(target); else video.currentTime = target;
}
let pending = null, raf = 0;
$('playhead').oninput = e => { // throttle: at most one seek per animation frame, latest value wins
  pending = e.target.time != null ? e.target.time : (e.target.value / 1000) * total();
  if (!raf) raf = requestAnimationFrame(async () => { raf = 0; if (video.seeking) return setTimeout(() => $('playhead').oninput({ target: { time: pending } }), 40); t = pending; await seek(t); refresh(t); });
};
function refresh(time) {
  t = time; const d = total() || 1; $('emptyState').hidden = !!(S.main.length || S.overlays.length || S.audio.length);
  const hit = locate(t);
  if (!hit) {
    if (!video.paused) video.pause(); video.style.display = 'none'; video.style.filter = '';
    video.playbackRate = 1; video.volume = 1;
    if (video.dataset.mid) { delete video.dataset.mid; video.removeAttribute('src'); video.load(); }
  } else {
    video.style.display = 'block'; video.style.filter = FX[hit.c.fx || 0].c || '';
    video.playbackRate = hit.c.speed || 1; video.volume = Math.min(1, hit.c.vol ?? 1);
  }
  if (Date.now() - lastScroll > 200) tl.scrollLeft = t * PX;
  $('playhead').value = (t / d) * 1000; $('timeDisplay').textContent = `${fmt(t)} / ${fmt(total())}`;
  S.overlays.forEach(o => {
    const ob = objOf(o.id); if (!ob) return;
    const on = t >= o.start && t <= o.start + o.dur;
    if (on && !ob.visible && o.type === 'text') anime({ targets: ob, opacity: [0, 1], duration: 400, easing: 'easeOutCubic', update: () => canvas.requestRenderAll() });
    ob.visible = on; if (o.key && on && ob.applyFilters) ob.applyFilters();
    if (o.el && on) { const want = t - o.start; if (playing && o.el.paused) o.el.play().catch(() => {}); if (!playing && Math.abs(o.el.currentTime - want) > 0.1) o.el.currentTime = want; }
    else if (o.el && !o.el.paused) o.el.pause();
  });
  canvas.requestRenderAll();
}
function tick() {
  if (!playing) return;
  const hit = locate(t), c = hit && hit.c;
  if (c) {
    const ct = video.currentTime;
    if (ct >= c.out - 0.03 || video.ended) {
      const i = S.main.indexOf(c);
      if (i === S.main.length - 1) return stop();
      t = S.main.slice(0, i + 1).reduce((a, x) => a + dur(x), 0); seek(t).then(() => video.play());
    } else t = hit.start + (ct - c.in) / (c.speed || 1);
  }
  refresh(t); S.audio.forEach(a => playAudio(a)); requestAnimationFrame(tick);
}
const audios = {}, audioLoads = {};
function playAudio(a) {
  const end = a.start + Math.max(0, a.out - a.in);
  if (t < a.start || t >= end) { if (audios[a.id] && !audios[a.id].paused) audios[a.id].pause(); return; }
  if (!urls[a.mediaId]) {
    if (!audioLoads[a.id]) audioLoads[a.id] = loadMedia(a.mediaId).then(() => { delete audioLoads[a.id]; if (playing) playAudio(a); }).catch(err => { delete audioLoads[a.id]; console.warn('Could not load audio track:', err); });
    return;
  }
  const el = audios[a.id] || (audios[a.id] = Object.assign(new Audio(urls[a.mediaId]), { preload: 'auto' }));
  el.volume = Math.min(1, a.vol ?? 1);
  const wanted = a.in + t - a.start;
  if (el.paused || Math.abs(el.currentTime - wanted) > 0.35) {
    el.currentTime = Math.max(a.in, wanted); el.play().catch(() => {});
  }
}
function stop() { playing = false; video.pause(); Object.values(audios).forEach(a => a.pause()); S.overlays.forEach(o => o.el && o.el.pause()); $('playBtn').textContent = '▶'; }
$('playBtn').onclick = async () => {
  if (!S.main.length) return say('Import a video first.');
  if (playing) return stop();
  if (t >= total() - 0.05) t = 0;
  await seek(t); playing = true; $('playBtn').textContent = '❚❚'; video.play(); requestAnimationFrame(tick);
};

/* ---------- Edit tools ---------- */
$('splitBtn').onclick = () => {
  const hit = locate(t); if (!hit) return;
  const c = hit.c, at = c.in + hit.local * (c.speed || 1); if (at <= c.in + 0.1 || at >= c.out - 0.1) return say('Move the playhead inside a clip to split.');
  S.main.splice(S.main.indexOf(c), 1, { ...c, out: at }, { ...c, id: uid(), in: at, tr: undefined });
  commit(); say('Split.');
};
$('deleteBtn').onclick = () => {
  if (!sel) return say('Tap a clip first.');
  if (sel.lane === 'overlay') { const ob = objOf(sel.id); if (ob) canvas.remove(ob); }
  S[sel.lane === 'main' ? 'main' : sel.lane === 'audio' ? 'audio' : 'overlays'] = S[sel.lane === 'main' ? 'main' : sel.lane === 'audio' ? 'audio' : 'overlays'].filter(x => x.id !== sel.id);
  sel = null; commit(); refresh(Math.min(t, total()));
};
$('aspectRatio').onchange = async e => {
  const [ow, oh] = RATIOS[S.ratio]; S.ratio = e.target.value; const [nw, nh] = RATIOS[S.ratio];
  S.overlays.forEach(o => { o.left = (o.left ?? 0) * nw / ow; o.top = (o.top ?? 0) * nh / oh; o.scaleX *= nw / ow; o.scaleY *= nw / ow; });
  await rebuildCanvas(); commit();
};

/* ---------- Export: FFmpeg.wasm, one clip at a time (chunked) ---------- */
const loadScript = src => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('Could not load ' + src)); document.head.appendChild(s); });
let ff, ffLogs = [], exportProgressHandler = null, exportClipIndex = 0, exportGroupIndex = 0;
async function getFFmpeg() {
  if (ff) return ff;
  const CDN = 'https://cdn.jsdelivr.net/npm/';
  await loadScript(CDN + '@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js');
  await loadScript(CDN + '@ffmpeg/util@0.12.1/dist/umd/index.js');
  const { toBlobURL } = FFmpegUtil, core = CDN + '@ffmpeg/core@0.12.6/dist/umd/';
  ff = new FFmpegWASM.FFmpeg();
  ff.on('log', ({ message }) => {
    const line = String(message || '');
    if (/error|invalid|failed|not found|unsupported|could not|unable|aborted/i.test(line)) {
      ffLogs.push(line);
      if (ffLogs.length > 30) ffLogs.shift();
    }
  });
  ff.on('progress', event => { if (exportProgressHandler) exportProgressHandler(event || {}); });
  try {
    await ff.load({
      classWorkerURL: await toBlobURL(CDN + '@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js', 'text/javascript'),
      coreURL: await toBlobURL(core + 'ffmpeg-core.js', 'text/javascript'),
      wasmURL: await toBlobURL(core + 'ffmpeg-core.wasm', 'application/wasm'),
    });
    return ff;
  } catch (error) {
    try { ff.terminate(); } catch (_) { /* loader may not have completed */ }
    ff = null;
    throw error;
  }
}
const run = async (args) => { const code = await ff.exec(args); if (code !== 0) throw new Error('FFmpeg failed (code ' + code + ')'); };
async function overlayPNG(o) { // render one overlay alone, full canvas size, transparent
  const obj = objOf(o.id), keep = canvas.getObjects().map(x => x.visible);
  canvas.discardActiveObject(); canvas.getObjects().forEach(x => (x.visible = x === obj));
  const url = canvas.toDataURL({ format: 'png' });
  canvas.getObjects().forEach((x, i) => (x.visible = keep[i])); canvas.requestRenderAll();
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

/* ---------- Saving the finished video (browser download, or Android share sheet in the APK) ---------- */
const isNative = () => !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
async function saveVideo(data) {
  const name = `ProjectMedia-Y-${Date.now()}.mp4`;
  if (isNative() && Capacitor.Plugins.Filesystem && Capacitor.Plugins.Share) {
    const { Filesystem, Share } = Capacitor.Plugins, CHUNK = 3 * 1024 * 1024; // multiple of 3 keeps base64 pieces valid
    for (let i = 0; i < data.length; i += CHUNK) {
      let bin = ''; const part = data.subarray(i, i + CHUNK);
      for (let j = 0; j < part.length; j += 0x8000) bin += String.fromCharCode.apply(null, part.subarray(j, j + 0x8000));
      const opts = { path: name, directory: 'CACHE', data: btoa(bin) };
      if (i === 0) await Filesystem.writeFile(opts); else await Filesystem.appendFile(opts);
    }
    const { uri } = await Filesystem.getUri({ path: name, directory: 'CACHE' });
    await Share.share({ title: 'ProjectMedia Y video', url: uri, dialogTitle: 'Save or share your video' });
    return;
  }
  const url = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
}

const EXP = { res: 720, fps: 30 };
$('goExport').onclick = async (_event, recoveryAttempt = 0) => {
  if (!S.main.length) return say('Nothing to export yet.');
  if (playing) stop();
  closeSheet(); const btn = $('goExport'); btn.disabled = true;
  let exportFailed = false;
  ffLogs = [];
  updateBusy('Preparing your export…', 'Checking project media before rendering.', 1, 'Preparing');
  try {
    if (!S.main.length) throw new Error('Add at least one video clip to the main timeline before exporting.');
    for (const c of S.main) {
      if (!Number.isFinite(c.in) || !Number.isFinite(c.out) || c.out <= c.in || !Number.isFinite(dur(c)) || dur(c) <= 0) {
        throw new Error(`The clip “${c.name || 'Untitled clip'}” has an invalid trim range or duration. Re-import the clip and try again.`);
      }
    }
    const mediaRefs = [...S.main, ...S.audio, ...S.overlays.filter(o => o.mediaId)];
    const mediaIds = [...new Set(mediaRefs.map(x => x.mediaId))];
    for (let m = 0; m < mediaIds.length; m++) {
      const id = mediaIds[m], url = await loadMedia(id), file = files[id];
      if (!url || !file || !file.size) {
        const ref = mediaRefs.find(x => x.mediaId === id);
        throw new Error(`Media “${(ref && ref.name) || id}” is missing from this browser’s local storage. Re-import that file, wait for it to finish, and export again.`);
      }
      updateBusy('Checking project media…', `Checking file ${m + 1} of ${mediaIds.length}.`, 2 + ((m + 1) / Math.max(1, mediaIds.length)) * 3, 'Preparing');
    }
    say('Loading video engine (first time only)…');
    updateBusy('Loading video engine…', 'The first export needs to download the rendering engine.', 6, 'Loading encoder');
    await getFFmpeg();
    updateBusy('Rendering video…', 'Encoding each clip with its effects and overlays.', 8, 'Rendering');
    exportProgressHandler = ({ progress }) => {
      const fraction = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
      const overall = 8 + ((exportClipIndex + fraction) / Math.max(1, S.main.length)) * 58;
      updateBusy(`Rendering clip ${Math.min(exportClipIndex + 1, S.main.length)} of ${S.main.length}…`, 'Encoding video, effects, and overlays. Longer clips can take more time.', overall, 'Rendering');
      say(`Rendering clip ${Math.min(exportClipIndex + 1, S.main.length)} of ${S.main.length}…`);
    };
    const [bw, bh] = RATIOS[S.ratio], kk = EXP.res / Math.min(bw, bh), W = Math.round(bw * kk / 2) * 2, H = Math.round(bh * kk / 2) * 2, segs = []; let offset = 0, cached = null;
    const TD = S.main.map((c, i) => (i && c.tr ? Math.min(c.trDur || 0.5, dur(S.main[i - 1]) * 0.45, dur(c) * 0.45) : 0)); // overlap length at each clip's start
    for (let i = 0; i < S.main.length; i++) {
      exportClipIndex = i;
      updateBusy(`Rendering clip ${i + 1} of ${S.main.length}…`, 'Encoding video, effects, and overlays.', 8 + (i / Math.max(1, S.main.length)) * 58, 'Rendering');
      const c = S.main[i], d = c.out - c.in, sp = c.speed || 1, td = d / sp, ext = (files[c.mediaId].name || 'v.mp4').split('.').pop().toLowerCase();
      const src = `src_${c.mediaId}.${ext}`;
      say(`Clip ${i + 1} of ${S.main.length}…`);
      if (cached !== src) { if (cached) await ff.deleteFile(cached).catch(() => {}); await ff.writeFile(src, new Uint8Array(await files[c.mediaId].arrayBuffer())); cached = src; }
      const live = S.overlays.filter(o => (o.type !== 'video' || objOf(o.id)) && o.start < offset + td && o.start + o.dur > offset).sort((a, b) => a.layer - b.layer), geo = [], K = W / RATIOS[S.ratio][0];
      const inputs = [], names = [];
      for (let k = 0; k < live.length; k++) {
        const o = live[k];
        if (o.type === 'video') { // picture-in-picture video: scale, rotate and place it, starting at the right moment
          const n = `ovv${k}`, ob = objOf(o.id), bb = ob.getBoundingRect(true, true), rad = ((ob.angle || 0) * Math.PI / 180).toFixed(4);
          await ff.writeFile(n, new Uint8Array(await files[o.mediaId].arrayBuffer())); names.push(n);
          inputs.push('-ss', Math.max(0, offset - o.start).toFixed(2), '-i', n);
          geo[k] = { ox: Math.round(bb.left * K), oy: Math.round(bb.top * K), chain: `${o.start > offset ? `tpad=start_mode=clone:start_duration=${(o.start - offset).toFixed(2)},` : ''}scale=${Math.max(2, Math.round(ob.getScaledWidth() * K))}:${Math.max(2, Math.round(ob.getScaledHeight() * K))}${o.key ? `,chromakey=color=0x${o.key.color.slice(1)}:similarity=${(0.08 + o.key.sim / 100 * 0.32).toFixed(3)}:blend=${((o.key.soft || 0) / 100 * 0.25).toFixed(3)}` : ''}${+rad ? `,format=rgba,rotate=${rad}:ow=rotw(${rad}):oh=roth(${rad}):c=none` : ''}` };
        } else { const n = `ov${k}.png`; await ff.writeFile(n, await overlayPNG(o)); names.push(n); inputs.push('-i', n); }
      }
      let g = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1${c.rev ? ',reverse' : ''}${sp !== 1 ? `,setpts=PTS/${sp}` : ''},fps=${EXP.fps}${FX[c.fx || 0].f ? ',' + FX[c.fx || 0].f : ''}${c.fade ? `,fade=t=in:d=.4,fade=t=out:st=${Math.max(0, td - .4).toFixed(2)}:d=.4` : ''}[b0]`, last = 'b0';
      live.forEach((o, k) => { // lower layers first so stacking matches the preview
        g += `;[${k + 1}:v]${geo[k] ? geo[k].chain : `scale=${W}:${H}`}[s${k}];[${last}][s${k}]overlay=${geo[k] ? geo[k].ox + ':' + geo[k].oy : '0:0'}:enable='between(t,${Math.max(0, o.start - offset).toFixed(2)},${(o.start + o.dur - offset).toFixed(2)})'[b${k + 1}]`; last = `b${k + 1}`;
      });
      const tx = TD[i + 1] || 0; // hold the last frame so the blend has something to fade from
      if (tx) { g += `;[${last}]tpad=stop_mode=clone:stop_duration=${tx.toFixed(2)}[bt]`; last = 'bt'; }
      const seg = `seg${i}.mp4`;
      const af = [c.rev && 'areverse', sp !== 1 && `atempo=${sp}`, (c.vol ?? 1) !== 1 && `volume=${c.vol}`, c.fade && `afade=t=in:d=.4,afade=t=out:st=${Math.max(0, td - .4).toFixed(2)}:d=.4`, tx > 0 && `apad=pad_dur=${tx.toFixed(2)}`].filter(Boolean).join(','), enc = a => ['-ss', String(c.in), '-t', String(d), '-i', src, ...inputs, '-filter_complex', g, '-map', `[${last}]`, '-map', '0:a:0?', ...a, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-t', (td + tx).toFixed(3), seg]; // -t: a long overlay video must not stretch the clip
      try { await run(enc(af ? ['-af', af] : [])); } catch (e) { if (!af) throw e; await run(enc(['-an'])); }
      for (const n of names) await ff.deleteFile(n);
      segs.push(seg); offset += td;
    }
    if (cached) await ff.deleteFile(cached).catch(() => {});
    exportProgressHandler = null;
    updateBusy('Finishing transitions…', 'Preparing the final sequence of clips.', 68, 'Transitions');
    const groups = []; segs.forEach((sg, i) => (i && TD[i] ? groups[groups.length - 1].push(i) : groups.push([i])));
    const pieces = [];
    exportProgressHandler = ({ progress }) => {
      const fraction = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
      updateBusy('Blending transitions…', `Processing transition group ${Math.min(exportGroupIndex + 1, groups.length)} of ${groups.length}.`, 70 + ((exportGroupIndex + fraction) / Math.max(1, groups.length)) * 12, 'Transitions');
    };
    for (const [gi, grp] of groups.entries()) {
      exportGroupIndex = gi;
      updateBusy('Blending transitions…', `Preparing group ${gi + 1} of ${groups.length}.`, 70 + (gi / Math.max(1, groups.length)) * 12, 'Transitions');
      if (grp.length === 1) { pieces.push(segs[grp[0]]); continue; }
      say(`Blending clips (${gi + 1} of ${groups.length})…`);
      const ins = grp.flatMap(i => ['-i', segs[i]]), name = `grp${gi}.mp4`;
      let pv = '[0:v]', pa = '[0:a]', cur = dur(S.main[grp[0]]) + TD[grp[1]], fv = '', fa = '';
      grp.slice(1).forEach((i, j) => {
        const d = TD[i], k = j + 1;
        fv += `${pv}[${k}:v]xfade=transition=${S.main[i].tr}:duration=${d.toFixed(2)}:offset=${(cur - d).toFixed(2)}[v${k}];`;
        fa += `${pa}[${k}:a]acrossfade=d=${d.toFixed(2)}[a${k}];`;
        cur += dur(S.main[i]) + (TD[i + 1] || 0) - d; pv = `[v${k}]`; pa = `[a${k}]`;
      });
      const enc2 = (fc, m) => run([...ins, '-filter_complex', fc, ...m, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2', name]);
      try { await enc2(fv + fa.slice(0, -1), ['-map', pv, '-map', pa]); } catch (e) { await enc2(fv.slice(0, -1), ['-map', pv, '-an']); }
      pieces.push(name);
    }
    exportProgressHandler = null;
    updateBusy('Joining clips…', 'Combining the rendered clips into one MP4.', 84, 'Final assembly');
    say('Joining clips…');
    await ff.writeFile('list.txt', new TextEncoder().encode(pieces.map(s => `file '${s}'`).join('\n')));
    await run(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'joined.mp4']);
    for (const s of new Set([...segs, ...pieces])) await ff.deleteFile(s).catch(() => {});
    let out = 'joined.mp4';
    const ovA = S.overlays.filter(o => o.type === 'video');
    if (S.audio.length || ovA.length) { // mix music, voice-over and overlay-video sound on top
      updateBusy('Mixing audio tracks…', 'Combining the original sound, music, and voice-over.', 90, 'Audio');
      say('Mixing audio…');
      const trk = [...S.audio.map(a => ({ m: a.mediaId, st: a.start, in: a.in, out: a.out, vol: a.vol, fade: a.fade, ov: false })), ...ovA.map(o => ({ m: o.mediaId, st: o.start, in: 0, out: o.dur, ov: true }))], ins = [];
      for (let k = 0; k < trk.length; k++) { await ff.writeFile(`aud${k}`, new Uint8Array(await files[trk[k].m].arrayBuffer())); ins.push('-i', `aud${k}`); }
      const tryMix = (idx, withOrig) => {
        const parts = idx.map(k => { const a = trk[k], ms = Math.round(a.st * 1000); return `[${k + 1}:a]atrim=start=${a.in}:end=${a.out},asetpts=PTS-STARTPTS${(a.vol ?? 1) !== 1 ? `,volume=${a.vol}` : ''}${a.fade ? `,afade=t=in:d=1,afade=t=out:st=${Math.max(0, a.out - a.in - 1).toFixed(2)}:d=1` : ''},adelay=${ms}|${ms}[a${k}]`; });
        return run(['-i', 'joined.mp4', ...ins, '-filter_complex', `${parts.join(';')};${withOrig ? '[0:a]' : ''}${idx.map(k => `[a${k}]`).join('')}amix=inputs=${idx.length + (withOrig ? 1 : 0)}:duration=first:normalize=0[m]`, '-map', '0:v', '-map', '[m]', '-c:v', 'copy', '-c:a', 'aac', 'final.mp4']);
      };
      const all = trk.map((_, k) => k), music = all.filter(k => !trk[k].ov); let done = false;
      for (const [idx, wo] of [[all, true], [all, false], [music, true], [music, false]]) { // a video with no sound falls back to the next combination
        if (!idx.length || (idx === music && music.length === all.length)) continue;
        try { await tryMix(idx, wo); done = true; break; } catch (e) { /* try the next one */ }
      }
      if (!done) throw new Error('Could not mix the audio tracks.');
      out = 'final.mp4';
    }
    updateBusy('Preparing your MP4…', 'Writing the final video file.', 97, 'Finishing');
    const data = await ff.readFile(out);
    await saveVideo(data);
    ['joined.mp4', 'final.mp4', 'list.txt'].forEach(n => ff.deleteFile(n).catch(() => {}));
    say('Export complete — your MP4 is ready.');
  } catch (err) {
    console.error(err);
    const errText = String(err && err.message || err);
    const encoderNotLoaded = /ffmpeg is not loaded|not loaded, call.*ffmpeg\.load|called FFmpeg\.terminate/i.test(errText);
    if (encoderNotLoaded && recoveryAttempt < 1) {
      // The browser/WebView can lose the FFmpeg worker. A truthy `ff` reference is not proof
      // that its worker is still alive; throw it away and rebuild the full export once.
      exportProgressHandler = null;
      try { if (ff) ff.terminate(); } catch (_) { /* worker may already be gone */ }
      ff = null;
      ffLogs = [];
      updateBusy('Restarting video engine…', 'The encoder worker stopped responding. MediaY is reloading it and retrying once.', 2, 'Recovery');
      say('Video engine stopped responding; reloading it and retrying once…');
      btn.disabled = false;
      return $('goExport').onclick(null, recoveryAttempt + 1);
    }
    const memoryProblem = /out of memory|memory access out of bounds|failed to grow memory|cannot allocate|allocation failed|out of memory|oom/i.test(errText + ' ' + ffLogs.join(' '));
    if (EXP.res > 1080 && memoryProblem) { // only downgrade resolution when there is evidence of a memory failure
      EXP.res = 1080; [...$('resList').children].forEach(b => b.classList.toggle('on', +b.dataset.v === 1080));
      exportProgressHandler = null; try { ff.terminate(); } catch (e) { /* already gone */ } ff = null; updateBusy('Retrying at 1080p…', 'The selected resolution used too much memory. Retrying at a lower resolution.', 3, 'Retry'); say('That size ran out of memory. Trying again at 1080p…'); btn.disabled = false; return $('goExport').onclick();
    }
    exportFailed = true;
    exportProgressHandler = null;
    const diagnostics = ffLogs.length ? (' Encoder details: ' + ffLogs.slice(-4).join(' | ').slice(0, 650)) : '';
    const message = 'Export problem: ' + (err && err.message || err) + '. Try 720p or a shorter clip.' + diagnostics;
    say(message);
    showBusyError('Export failed', message);
  }
  exportProgressHandler = null;
  btn.disabled = false;
  if (!exportFailed) hideBusy();
};

/* ---------- Effects sheet, fades, text styles ---------- */
const sheet = $('sheet'), clipNow = () => (sel && sel.lane === 'main' ? S.main.find(x => x.id === sel.id) : (locate(t) || {}).c);
function markFx() { const c = clipNow(); [...$('fxList').children].forEach((b, i) => b.classList.toggle('on', i === ((c && c.fx) || 0))); }
function openSheet(name) {
  sheet.hidden = false; sheet.dataset.tab = name;
  document.querySelectorAll('[data-pane]').forEach(p => (p.hidden = p.dataset.pane !== name));
  document.querySelectorAll('.dock button').forEach(b => b.classList.toggle('on', b.dataset.sheet === name));
  if (name === 'fx') markFx(); else if (name === 'speed') markSp(); else if (name === 'vol') markVol(); else if (name === 'tr') markTr(); else if (name === 'text') markText(); else if (name === 'tpl') markTpl(); else if (name === 'key') markKey(); else if (window.lucide) lucide.createIcons();
}
const closeSheet = () => { sheet.hidden = true; document.querySelectorAll('.dock button').forEach(b => b.classList.remove('on')); };
$('sheetClose').onclick = closeSheet;
$('fxBtn').onclick = () => (sheet.hidden || sheet.dataset.tab !== 'fx' ? openSheet('fx') : closeSheet());
$('fxList').innerHTML = FX.map((f, i) => `<button data-fx="${i}"><i style="filter:${f.c}"></i>${f.n}</button>`).join('');
$('fxList').onclick = e => {
  const b = e.target.closest('[data-fx]'), c = clipNow(); if (!b) return;
  if (!c) return say('Import a video first.');
  c.fx = +b.dataset.fx; commit(); refresh(t); markFx(); say(`${FX[c.fx].n} applied to this clip.`);
};
$('fadeBtn').onclick = () => { const c = volClip(); if (!c) return say('Import a video first.'); c.fade = !c.fade; commit(); say(c.fade ? 'Fade in and out added.' : 'Fade removed.'); };
let txtStyle = 0;
$('styleList').innerHTML = ['Classic', 'Neon', 'Label', 'Pop', 'Headline', 'News blue'].map((n, i) => `<button data-ts="${i}" class="${i ? '' : 'on'}">${n}</button>`).join('');
$('styleList').onclick = async e => {
  const b = e.target.closest('[data-ts]'); if (!b) return;
  txtStyle = +b.dataset.ts; [...$('styleList').children].forEach(x => x.classList.toggle('on', x === b));
  const o = sel && sel.lane === 'overlay' && S.overlays.find(x => x.id === sel.id && x.type === 'text');
  if (o) { const old = objOf(o.id); if (old) canvas.remove(old); o.style = txtStyle; await buildObject(o); refresh(t); commit(); }
};
const textSel = () => { const o = sel && sel.lane === 'overlay' && S.overlays.find(x => x.id === sel.id); return o && o.type === 'text' ? o : null; };
function markText() { const o = textSel(); $('textInput').value = o ? o.text : ''; $('addText').textContent = o ? 'Update text' : 'Add to video'; }
$('addText').onclick = async () => {
  const s = $('textInput').value.trim(); if (!s) return say('Type your text first.');
  const o = textSel();
  if (o) { const old = objOf(o.id); if (old) canvas.remove(old); o.text = s; await buildObject(o); restack(); commit(); refresh(t); closeSheet(); return; }
  addOverlay({ type: 'text', text: s, style: txtStyle, top: RATIOS[S.ratio][1] * 0.7 }); $('textInput').value = ''; closeSheet();
};

$('exportBtn').onclick = () => openSheet('export');

/* ---------- Chroma key: remove a green or blue background from a picture or video layer ---------- */
const keyOv = () => { const o = sel && sel.lane === 'overlay' && S.overlays.find(x => x.id === sel.id); return o && o.type !== 'text' ? o : null; };
function applyKey(o) { const ob = objOf(o.id); if (!ob) return; ob.filters = o.key ? [keyFilter(o.key)] : []; ob.applyFilters(); canvas.requestRenderAll(); }
function markKey() {
  const o = keyOv(), k = o && o.key; $('keySim').value = k ? k.sim : 50; $('keySoft').value = k ? k.soft : 20; $('keyCol').value = k ? k.color : '#00ff00';
  [...$('keyColors').children].forEach(b => b.classList.toggle('on', k ? b.dataset.c === k.color : b.dataset.c === 'off'));
}
function setKey(color) {
  const o = keyOv(); if (!o) return say('Select a video or picture layer first.');
  o.key = color === 'off' ? undefined : { color, sim: o.key ? o.key.sim : 50, soft: o.key ? o.key.soft : 20 };
  applyKey(o); refresh(t); commit(); markKey(); say(o.key ? 'Background removed. The exported video uses a sharper version.' : 'Chroma key is off.');
}
$('keyBtn').onclick = () => (sheet.hidden || sheet.dataset.tab !== 'key' ? openSheet('key') : closeSheet());
$('keyColors').onclick = e => { const b = e.target.closest('[data-c]'); if (b) setKey(b.dataset.c); };
$('keyCol').onchange = e => setKey(e.target.value);
$('keySim').oninput = e => { const o = keyOv(); if (!o || !o.key) return; o.key.sim = +e.target.value; applyKey(o); refresh(t); };
$('keySoft').oninput = e => { const o = keyOv(); if (o && o.key) o.key.soft = +e.target.value; };
$('keySim').onchange = $('keySoft').onchange = () => { if (keyOv()) commit(); };

/* ---------- Replace a video or music clip: keep its place, filter, speed, layers ---------- */
let pendingRep = null;
function askReplace(kind) { $('repInput').accept = kind === 'audio' ? 'audio/*' : 'video/*'; $('repInput').dataset.kind = kind; $('repInput').click(); }
$('repMain').onclick = () => { if (pendingRep) { pendingRep = null; $('tl').classList.remove('picking'); updateChrome(); return say('Replace cancelled.'); } askReplace('video'); };
$('repInput').onchange = async e => {
  const f = e.target.files[0], kind = e.target.dataset.kind; e.target.value = ''; if (!f) return;
  say('Loading your new file…');
  const mediaId = await storeMedia(f), d = await probe(urls[mediaId], kind === 'audio' ? 'audio' : 'video'); if (!d || !Number.isFinite(d)) return say(`Could not read ${f.name}. Try a standard ${kind === 'audio' ? 'audio' : 'MP4/MOV video'} file.`); pendingRep = { mediaId, name: f.name, dur: d, kind };
  if (sel && sel.lane === (kind === 'audio' ? 'audio' : 'main')) applyRep(sel.id, sel.lane); // a clip was already selected
  else { $('tl').classList.add('picking'); updateChrome(); say(`Now tap the ${kind === 'audio' ? 'music' : 'video'} clip you want to replace. (Tap Replace again to cancel.)`); }
};
function retime(a0, oldLen, newLen) { // layers and music that covered the old clip stretch to the new one; later ones shift
  const a1 = a0 + oldLen, T = total(), f = x => (x >= a1 - 0.01 ? x - oldLen + newLen : x <= a0 ? x : Math.min(x, a0 + newLen));
  S.overlays.forEach(o => { const s0 = f(o.start), e0 = Math.min(f(o.start + o.dur), T); o.start = s0; o.dur = Math.max(0.5, e0 - s0); });
  S.audio.forEach(a => { const s0 = f(a.start), len = Math.min(f(a.start + a.out - a.in), T) - s0; a.start = s0; a.out = a.in + Math.max(0.3, Math.min(len, (a.src || a.out) - a.in)); });
}
async function applyRep(id, lane) {
  const p = pendingRep, c = itemOf(id, lane); if (!p || !c) return;
  if (lane === 'overlay') return say('To swap a logo or picture, select it and tap Replace.');
  if ((lane === 'main') !== (p.kind === 'video')) return say(`Tap a ${p.kind === 'video' ? 'video' : 'music'} clip.`);
  pendingRep = null; $('tl').classList.remove('picking');
  const a0 = lane === 'main' ? startOf(c, 'main') : 0, oldLen = lane === 'main' ? dur(c) : 0;
  Object.assign(c, { mediaId: p.mediaId, name: p.name, in: 0, out: p.dur, src: p.dur });
  if (lane === 'audio') { if (audios[c.id]) { audios[c.id].pause(); delete audios[c.id]; } } else retime(a0, oldLen, dur(c));
  t = Math.min(t, total()); commit(); await seek(t); refresh(t);
  say(lane === 'main' ? 'Video replaced. Your logo and layers were fitted to the new length.' : 'Music replaced.');
}

/* ---------- Voice-over: record while the video plays ---------- */
let rec;
$('voiceBtn').onclick = async () => {
  if (rec) return rec.stop();
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch (e) { return say('The microphone is blocked. Allow it in your phone settings, then try again.'); }
  const chunks = [], t0 = t, began = Date.now(), mr = new MediaRecorder(stream), tag = $('voiceBtn').lastChild;
  mr.ondataavailable = e => e.data.size && chunks.push(e.data);
  mr.onstop = async () => {
    stream.getTracks().forEach(x => x.stop()); rec = null; if (playing) stop(); $('voiceBtn').classList.remove('rec'); tag.textContent = 'Voice';
    const len = Math.max(0.3, (Date.now() - began) / 1000 - 0.1); // webm recordings have no length, so use the timer
    const f = new File(chunks, `Voice-over ${new Date().toLocaleTimeString()}.webm`, { type: mr.mimeType || 'audio/webm' });
    const mediaId = await storeMedia(f);
    S.audio.push({ id: uid(), mediaId, name: f.name, start: t0, in: 0, out: len, src: len }); commit(); say('Voice-over added. Tap it to change the volume.');
  };
  rec = mr; mr.start(); $('voiceBtn').classList.add('rec'); tag.textContent = 'Stop';
  say('Recording… use headphones so the video sound is not recorded. Tap Stop when you finish.');
  if (!playing) $('playBtn').click();
};
$('fitBtn').onclick = () => { // logo or music: stretch across the whole video
  const lane = sel && sel.lane, c = lane === 'overlay' ? S.overlays.find(x => x.id === sel.id) : lane === 'audio' ? S.audio.find(x => x.id === sel.id) : null;
  if (!c || !total()) return say('Select a logo, text or music clip first.');
  if (lane === 'overlay') { c.start = 0; c.dur = total(); } else { c.start = 0; c.out = Math.min(c.src || c.out, c.in + total()); }
  commit(); say('Now covers the whole video.');
};

/* ---------- Templates: intro + logo + outro saved once, reused for every news video ---------- */
const TPLKEY = 'pmy-templates'; let pendingTpl = null;
const loadTpls = () => { try { return JSON.parse(localStorage.getItem(TPLKEY)) || []; } catch (e) { return []; } };
const saveTpls = l => { try { localStorage.setItem(TPLKEY, JSON.stringify(l)); } catch (e) { say('Could not save the template on this device.'); } };
function markTpl() {
  const l = loadTpls(); $('tplList').textContent = '';
  if (!l.length) { const p = document.createElement('p'); p.className = 'lbl'; p.textContent = 'No templates yet. Build your intro, logo and outro, then save it below.'; $('tplList').appendChild(p); }
  l.forEach(p => {
    const row = document.createElement('div'), info = document.createElement('span'), use = document.createElement('button'), del = document.createElement('button'); row.className = 'tpl';
    info.textContent = `${p.name} · ${p.pre.length} intro, ${p.post.length} outro, ${p.overlays.length} layers`;
    use.className = 'primary'; use.textContent = 'Use'; use.onclick = () => { pendingTpl = p.id; $('tplInput').click(); };
    del.textContent = '✕'; del.setAttribute('aria-label', 'Delete template'); del.onclick = () => { saveTpls(loadTpls().filter(x => x.id !== p.id)); markTpl(); };
    const open = document.createElement('button'); open.textContent = 'Open'; open.onclick = () => openTpl(p);
    row.append(info, open, use, del); $('tplList').appendChild(row);
  });
  $('tplSlot').textContent = '';
  S.main.forEach((c, i) => { const o = document.createElement('option'); o.value = i; o.textContent = `${i + 1}. ${c.name}`; $('tplSlot').appendChild(o); });
  const none = document.createElement('option'); none.value = -1; none.textContent = 'None: put my news video at the end'; $('tplSlot').appendChild(none);
  if (S.main.length) $('tplSlot').value = S.main.reduce((b, c, i) => (dur(c) > dur(S.main[b]) ? i : b), 0);
}
async function openTpl(p) { // load the template as an editable project; then tap Replace to swap in the new video
  if ((S.main.length || S.overlays.length || S.audio.length) && !confirm('This replaces your current project. Continue?')) return;
  const fresh = c => { const n = { ...c, id: uid() }; delete n.el; return n; };
  const main = [...p.pre.map(fresh), ...(p.slotClip ? [fresh(p.slotClip)] : []), ...p.post.map(fresh)];
  updateBusy('Opening template…', 'Restoring clips, audio, overlays, and timing.', 15, 'Template');
  try {
    await validateTemplateAssets(p);
    t = 0; await restore(JSON.stringify({ ratio: p.ratio, main, audio: p.audio.map(fresh), overlays: p.overlays.map(fresh), nextLayer: Math.max(1, ...p.overlays.map(o => o.layer || 0)) + 1 }));
    updateBusy('Finishing template…', 'Rebuilding the preview and timeline.', 85, 'Template');
    commit(); closeSheet(); await seek(0); refresh(0);
    say(p.slotClip ? 'Template opened. Tap Replace, choose your news video, then tap the sample clip.' : 'Template opened.');
    hideBusy();
  } catch (err) {
    showBusyError('Could not open template', err.message || String(err));
    say('Could not open template: ' + (err.message || err));
  }
}
$('tplBtn').onclick = () => openSheet('tpl'); $('tplStart').onclick = () => openSheet('tpl');
$('tplSave').onclick = () => {
  if (!S.main.length && !S.overlays.length && !S.audio.length) return say('Add at least one video, overlay or audio track before saving a template.');
  const st = JSON.parse(snap()), i = +$('tplSlot').value, slot = i >= 0 ? st.main[i] : null;
  st.overlays.forEach(o => delete o.el);
  const tpl = { id: uid(), name: $('tplName').value.trim() || 'My template', ratio: st.ratio, pre: st.main.slice(0, i >= 0 ? i : st.main.length), post: i >= 0 ? st.main.slice(i + 1) : [],
    slotLen: slot ? dur(slot) : 0, slotClip: slot, proto: slot ? { fx: slot.fx, fade: slot.fade, vol: slot.vol, speed: slot.speed, tr: slot.tr } : {}, overlays: st.overlays, audio: st.audio };
  saveTpls([...loadTpls(), tpl]); $('tplName').value = ''; markTpl(); say('Template saved. Next time, tap Use and pick your news videos.');
};
$('tplInput').onchange = async e => {
  const tpl = loadTpls().find(x => x.id === pendingTpl), list = [...e.target.files]; e.target.value = ''; if (!tpl || !list.length) return;
  if ((S.main.length || S.overlays.length || S.audio.length) && !confirm('This replaces your current project. Continue?')) return;
  say('Building your video from the template…');
  updateBusy('Applying template…', 'Importing replacement clips and rebuilding the timeline.', 2, 'Template');
  try {
    await validateTemplateAssets(tpl);
    const news = [];
    for (let fileIndex = 0; fileIndex < list.length; fileIndex++) { const file = list[fileIndex]; updateBusy('Applying template…', `Reading replacement video ${fileIndex + 1} of ${list.length}: ${file.name}.`, 5 + (fileIndex / Math.max(1, list.length)) * 60, 'Template'); const mediaId = await storeMedia(file), d = await probe(urls[mediaId]); if (!d || !Number.isFinite(d)) throw new Error('Could not read the duration of ' + file.name + '. Try a standard MP4 or MOV video.'); news.push({ ...tpl.proto, id: uid(), mediaId, name: file.name, in: 0, out: d, src: d, tr: news.length ? undefined : tpl.proto.tr }); }
    const fresh = c => ({ ...c, id: uid() }), N = news.reduce((a, c) => a + dur(c), 0), a0 = tpl.pre.reduce((a, c) => a + dur(c), 0), a1 = a0 + tpl.slotLen;
    const f = x => (x >= a1 - 0.01 ? x - tpl.slotLen + N : x <= a0 ? x : Math.min(x, a0 + N)), Tnew = a0 + N + tpl.post.reduce((a, c) => a + dur(c), 0);
    const fS = x => (tpl.slotLen === 0 ? (x > a0 + 0.01 ? x + N : x) : f(x)); // with no sample clip, a layer starting at 0 must stay at 0 // intro stays, outro shifts, "whole video" layers stretch
    const ov = tpl.overlays.map(o => { const s0 = fS(o.start), e0 = Math.min(f(o.start + o.dur), Tnew), c = fresh(o); delete c.el; return Object.assign(c, { start: s0, dur: Math.max(0.5, e0 - s0) }); });
    const au = tpl.audio.map(a => { const s0 = fS(a.start), len = Math.min(f(a.start + a.out - a.in), Tnew) - s0; return { ...fresh(a), start: s0, out: a.in + Math.max(0.3, Math.min(len, (a.src || a.out) - a.in)) }; });
    const S2 = { ratio: tpl.ratio, main: [...tpl.pre.map(fresh), ...news, ...tpl.post.map(fresh)], audio: au, overlays: ov, nextLayer: Math.max(1, ...ov.map(o => o.layer || 0)) + 1 };
    t = 0; updateBusy('Rebuilding timeline…', 'Restoring overlays, timing, and audio tracks.', 75, 'Template'); await restore(JSON.stringify(S2)); commit(); await seek(0); refresh(0); closeSheet(); say(`Done: ${list.length} video${list.length > 1 ? 's' : ''} placed in your template.`);
  } catch (err) { say('Could not use the template: ' + (err.message || err)); showBusyError('Could not apply template', err.message || String(err)); return; }
  hideBusy();
};
$('doneBtn').onclick = () => { select(null); closeSheet(); };
$('styleBtn').onclick = () => openSheet('text');
$('replBtn').onclick = () => (sel && sel.lane === 'overlay' ? $('pipBtn').click() : askReplace(sel && sel.lane === 'audio' ? 'audio' : 'video'));
async function jump(x) { t = Math.max(0, Math.min(x, total())); lastScroll = 0; await seek(t); refresh(t); }
$('toStart').onclick = () => jump(0); $('toEnd').onclick = () => jump(total());
$('tipOff').onclick = () => { try { localStorage.setItem('pmy-tips-off', '1'); } catch (e) {} $('tipBar').hidden = true; };
function markRatio() { document.querySelectorAll('#ratioPick button').forEach(b => b.classList.toggle('on', b.dataset.r === $('aspectRatio').value)); }
document.querySelectorAll('#ratioPick button').forEach(b => (b.onclick = () => { $('aspectRatio').value = b.dataset.r; $('aspectRatio').dispatchEvent(new Event('change')); markRatio(); }));
const LANGS = [['Auto-detect', ''], ['English', 'english'], ['Hindi', 'hindi'], ['Bengali', 'bengali'], ['Urdu', 'urdu'], ['Spanish', 'spanish'], ['French', 'french'], ['Portuguese', 'portuguese'], ['Arabic', 'arabic'], ['Indonesian', 'indonesian']];
$('capLang').innerHTML = LANGS.map(([n, v]) => `<option value="${v}">${n}</option>`).join('');
$('capBtn').onclick = () => (sheet.hidden || sheet.dataset.tab !== 'cap' ? openSheet('cap') : closeSheet());
let asr, asrBackend = 'wasm';
async function createSpeechPipeline(useWebGPU) {
  const packageName = useWebGPU ? '@huggingface/transformers@3.8.1' : '@xenova/transformers@2.17.2';
  const { pipeline, env } = await import(`https://cdn.jsdelivr.net/npm/${packageName}`);
  env.allowLocalModels = false;
  const progress_callback = p => {
    if (p.status !== 'progress') return;
    const detail = `Downloading speech model… ${Math.round(p.progress || 0)}%`;
    say(detail);
    updateBusy('Downloading speech model…', detail, Number.isFinite(p.progress) ? p.progress : null, 'Model download');
  };
  const options = { progress_callback };
  if (useWebGPU) options.device = 'webgpu';
  const modelId = useWebGPU ? 'onnx-community/whisper-tiny' : 'Xenova/whisper-tiny';
  const model = await pipeline('automatic-speech-recognition', modelId, options);
  asrBackend = useWebGPU ? 'webgpu' : 'wasm';
  return model;
}
async function pcmOf(src) { // 16 kHz mono sound of one clip; throws if it has no sound
  await loadMedia(src.m);
  const ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  try {
    const buf = await ac.decodeAudioData(await files[src.m].arrayBuffer()), sampleRate = buf.sampleRate || 16000, pcm = buf.getChannelData(0).slice(Math.floor(src.in * sampleRate), Math.ceil(src.out * sampleRate));
    if (pcm.length < 1600) throw new Error('empty'); return pcm;
  } finally { ac.close(); }
}
async function captionFrom(pcm, src) {
  const lang = $('capLang').value;
  const r = await asr(pcm, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, ...(lang ? { language: lang } : {}), task: $('capTr').checked ? 'translate' : 'transcribe' });
  let n = 0;
  for (const ch of r.chunks || []) {
    const words = ch.text.trim().split(/\s+/).filter(Boolean); if (!words.length || /^[\[(].*[\])]$/.test(ch.text.trim())) continue; // skip [music] style tags
    const s0 = ch.timestamp[0] || 0, e0 = ch.timestamp[1] != null ? ch.timestamp[1] : Math.min(s0 + 3, src.out - src.in), parts = Math.ceil(words.length / 4);
    for (let p = 0; p < parts; p++) { // short captions, about 4 words each
      const a = s0 + (e0 - s0) * p / parts, b = s0 + (e0 - s0) * (p + 1) / parts;
      const o = { id: uid(), layer: S.nextLayer++, type: 'text', text: words.slice(p * 4, p * 4 + 4).join(' '), style: txtStyle, start: src.start + a / src.sp, dur: Math.max(0.4, (b - a) / src.sp), top: RATIOS[S.ratio][1] * 0.72 };
      S.overlays.push(o); await buildObject(o); n++;
    }
  }
  return n;
}
$('capGo').onclick = async () => {
  const aSel = sel && sel.lane === 'audio' ? S.audio.find(x => x.id === sel.id) : null, vid = aSel ? null : clipNow();
  const A = a => ({ m: a.mediaId, in: a.in, out: a.out, start: a.start, sp: 1, label: 'your audio track' });
  const cands = aSel ? [A(aSel)] : [...(vid ? [{ m: vid.mediaId, in: vid.in, out: vid.out, start: startOf(vid, 'main'), sp: vid.speed || 1, label: 'this video' }] : []), ...S.audio.map(A)];
  if (!cands.length) return say('Import a video or add audio first.');
  const btn = $('capGo'); btn.disabled = true;
  let captionFailed = false;
  updateBusy('Preparing captions…', 'Loading the selected audio and speech-recognition model.', 1, 'Captions');
  try {
    if (!asr) {
      let gpuReady = false;
      if (navigator.gpu && typeof navigator.gpu.requestAdapter === 'function') {
        try {
          updateBusy('Starting GPU captions…', 'Checking whether this browser can accelerate speech recognition.', null, 'GPU acceleration');
          asr = await createSpeechPipeline(true);
          gpuReady = true;
        } catch (gpuError) {
          asr = null;
          updateBusy('Switching to compatibility mode…', 'GPU acceleration is unavailable on this device. Using the compatible speech engine instead.', null, 'Compatibility');
        }
      }
      if (!asr) {
        say('Loading the speech model (about 40 MB the first time)…');
        updateBusy('Loading speech model…', 'The first download is cached for later sessions.', null, 'Model download');
        asr = await createSpeechPipeline(false);
      } else if (gpuReady) {
        updateBusy('Speech model ready', 'Using browser GPU acceleration for transcription.', null, 'GPU accelerated');
      }
    }
    let n = 0, used = '';
    for (const src of cands) { // the video first, then your audio tracks; a silent video is skipped automatically
      say(`Listening to ${src.label}…`);
      updateBusy('Transcribing speech…', `Listening to ${src.label}. This step can take time on slower phones.`, null, 'Transcription');
      let pcm; try { pcm = await pcmOf(src); } catch (e) { continue; }
      try {
        n = await captionFrom(pcm, src);
      } catch (inferenceError) {
        if (asrBackend !== 'webgpu') throw inferenceError;
        // GPU model loading can succeed while inference fails on certain drivers.
        asr = null;
        updateBusy('Switching to compatible captions…', 'This device could not finish GPU inference. Retrying with the CPU engine.', null, 'Compatibility');
        asr = await createSpeechPipeline(false);
        n = await captionFrom(pcm, src);
      }
      if (n) { used = src.label; break; }
    }
    if (n) { restack(); commit(); refresh(t); closeSheet(); say(`Added ${n} captions from ${used}. Tap one to restyle or move it.`); }
    else say(S.audio.length || aSel ? 'No speech found.' : 'This video has no sound to caption. Add or record audio, then try again.');
  } catch (e) { const message = 'Captions failed: ' + (e.message || e) + ' (the first run needs internet).'; say(message); captionFailed = true; showBusyError('Caption generation failed', message); }
  btn.disabled = false;
  if (!captionFailed) hideBusy();
};
const TR = [['None', ''], ['Fade', 'fade'], ['Dip black', 'fadeblack'], ['Flash', 'fadewhite'], ['Slide', 'slideleft'], ['Wipe', 'wipeleft'], ['Circle', 'circleopen'], ['Dissolve', 'dissolve'], ['Pixelate', 'pixelize'], ['Radial', 'radial'], ['Slide right', 'slideright'], ['Wipe up', 'wipeup'], ['Diagonal', 'diagtl'], ['Iris in', 'circleclose'], ['Blinds', 'hlslice']];
function markTr() { const c = clipNow(); [...$('trList').children].forEach((b, i) => b.classList.toggle('on', ((c && c.tr) || '') === TR[i][1])); const d = c && c.trDur || 0.5; $('trDuration').value = d; $('trDurationLabel').textContent = Number(d).toFixed(1) + ' s'; $('trDuration').disabled = !c || !c.tr; }
$('trBtn').onclick = () => (sheet.hidden || sheet.dataset.tab !== 'tr' ? openSheet('tr') : closeSheet());
$('trList').innerHTML = TR.map(([n, v]) => `<button data-tr="${v}">${n}</button>`).join('');
$('trList').onclick = e => {
  const b = e.target.closest('[data-tr]'), c = clipNow(); if (!b) return; if (!c) return say('Import a video first.');
  if (S.main.indexOf(c) < 1) return say('A transition goes between two clips. Select the second clip.');
  c.tr = b.dataset.tr || undefined; if (c.tr && !c.trDur) c.trDur = 0.5; commit(); markTr(); say(c.tr ? 'Transition added. Duration can be adjusted below; it is rendered on export.' : 'Transition removed.');
};
$('trDuration').oninput = e => { const c = clipNow(); if (!c || !c.tr) return; c.trDur = Number(e.target.value); $('trDurationLabel').textContent = c.trDur.toFixed(1) + ' s'; };
$('trDuration').onchange = () => { const c = clipNow(); if (c && c.tr) { commit(); say(`Transition duration set to ${c.trDur.toFixed(1)} seconds.`); } };
const volClip = () => (sel && sel.lane === 'audio' ? S.audio.find(x => x.id === sel.id) : clipNow());
function markVol() {
  const c = volClip(), v = c ? Math.round((c.vol ?? 1) * 100) : 100;
  $('volRange').value = v; $('volLbl').textContent = v + '%' + (v > 100 ? ' (boost is heard in the exported video)' : '');
  $('muteBtn').classList.toggle('on', v === 0); $('muteBtn').textContent = v === 0 ? 'Unmute' : 'Mute clip';
}
function applyVol() { refresh(t); S.audio.forEach(a => { if (audios[a.id]) audios[a.id].volume = Math.min(1, a.vol ?? 1); }); }
$('volBtn').onclick = () => (sheet.hidden || sheet.dataset.tab !== 'vol' ? openSheet('vol') : closeSheet());
$('volRange').oninput = e => {
  const c = volClip(); if (!c) { markVol(); return say('Import a video first.'); }
  c.vol = Math.round(e.target.value) / 100; $('volLbl').textContent = e.target.value + '%' + (e.target.value > 100 ? ' (boost is heard in the exported video)' : ''); applyVol();
};
$('volRange').onchange = () => { if (volClip()) { commit(); markVol(); } }; // one undo step per slider drag
$('muteBtn').onclick = () => { const c = volClip(); if (!c) return say('Import a video first.'); c.vol = (c.vol ?? 1) === 0 ? 1 : 0; applyVol(); commit(); markVol(); say(c.vol === 0 ? 'Clip muted.' : 'Clip unmuted.'); };
$('speedList').innerHTML = [0.5, 1, 1.5, 2].map(v => `<button data-sp="${v}">${v}×</button>`).join('');
function markSp() { const c = clipNow(); [...$('speedList').children].forEach(b => b.classList.toggle('on', +b.dataset.sp === ((c && c.speed) || 1))); $('revBtn').classList.toggle('on', !!(c && c.rev)); }
$('speedBtn').onclick = () => (sheet.hidden || sheet.dataset.tab !== 'speed' ? openSheet('speed') : closeSheet());
$('speedList').onclick = e => {
  const b = e.target.closest('[data-sp]'), c = clipNow(); if (!b) return; if (!c) return say('Import a video first.');
  c.speed = +b.dataset.sp; t = Math.min(t, total()); commit(); seek(t).then(() => refresh(t)); markSp(); say(`${c.speed}× speed.`);
};
$('revBtn').onclick = () => { const c = clipNow(); if (!c) return say('Import a video first.'); c.rev = !c.rev; commit(); markSp(); say(c.rev ? 'Reverse added. It plays backwards in the exported video.' : 'Reverse removed.'); };
$('addClip').onclick = () => $('importBtn').click();
const opt = (id, vals, key) => { $(id).innerHTML = vals.map(v => `<button data-v="${v}" class="${EXP[key] === v ? 'on' : ''}">${key === 'res' ? (v === 1440 ? '2K' : v === 2160 ? '4K' : v + 'p' + (v === 720 ? ' · fast' : v === 1080 ? ' · HD' : '')) : v}</button>`).join(''); $(id).onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; EXP[key] = +b.dataset.v; [...$(id).children].forEach(x => x.classList.toggle('on', x === b)); }; };
opt('resList', [480, 720, 1080, 1440, 2160], 'res'); opt('fpsList', [24, 30, 60], 'fps');

/* ---------- Start up ---------- */
const projectMediaReady = (async function init() {
  sizeCanvas();
  const row = await db.projects.get('current').catch(() => null);
  if (row) {
    try {
      S = normalizeState(row.state);
      activeProjectId = row.activeProjectId || 'current';
      activeProjectName = row.activeProjectName || row.name || 'Untitled project';
      await rebuildCanvas();
      if (S.main.length) await seek(0);
      say('Restored your last project.');
    } catch (e) { console.warn('Could not restore the last project:', e); }
  }
  undoStack = [snap()]; drawTimeline(); refresh(0);
  if (window.lucide) lucide.createIcons();
  return true;
})();
// setup.js waits for this promise before showing the dashboard so startup cannot race IndexedDB restore.
window.projectMediaReady = projectMediaReady;
window.addEventListener('resize', () => requestAnimationFrame(() => { try { canvas.calcOffset(); } catch (_) {} }));
if ('ResizeObserver' in window) {
  const previewResizeObserver = new ResizeObserver(() => { try { canvas.calcOffset(); } catch (_) {} });
  previewResizeObserver.observe($('previewFrame'));
}

/* ---------- First-run agreement (shown once per device) ---------- */
(function consent() {
  const KEY = 'pmy-consent-v1', dlg = $('consentDialog');
  let agreed = false; try { agreed = localStorage.getItem(KEY) === 'yes'; } catch (e) {}
  if (agreed || !dlg || !dlg.showModal) return;
  dlg.addEventListener('cancel', e => e.preventDefault());
  $('consentBtn').onclick = () => { try { localStorage.setItem(KEY, 'yes'); } catch (e) {} dlg.close(); };
  dlg.showModal();
})();

/* Offline support + installability */
if ('serviceWorker' in navigator && !isNative()) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.warn));
