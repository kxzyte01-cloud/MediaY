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

const DEFAULT_ADJUST = Object.freeze({ brightness: 0, contrast: 100, saturation: 100, sharpen: 0, highlights: 0, shadows: 0, grain: 0 });
const BLEND_OPTIONS = [
  ['Normal', 'normal', 'source-over'], ['Add', 'addition', 'lighter'], ['Average', 'average', 'source-over'],
  ['Color burn', 'burn', 'color-burn'], ['Color dodge', 'dodge', 'color-dodge'], ['Darken', 'darken', 'darken'],
  ['Lighten', 'lighten', 'lighten'], ['Multiply', 'multiply', 'multiply'], ['Screen', 'screen', 'screen'],
  ['Overlay', 'overlay', 'overlay'], ['Hard light', 'hardlight', 'hard-light'], ['Soft light', 'softlight', 'soft-light']
];
const adjustOf = clip => ({ ...DEFAULT_ADJUST, ...(clip && clip.adjust || {}) });
const bounded = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
function adjustmentFilter(clip) {
  const a = adjustOf(clip), filters = [];
  if (a.brightness !== 0 || a.contrast !== 100 || a.saturation !== 100) {
    filters.push('eq=brightness=' + (bounded(a.brightness, -100, 100) / 200).toFixed(3) +
      ':contrast=' + Math.max(0.1, bounded(a.contrast, 0, 200) / 100).toFixed(3) +
      ':saturation=' + (bounded(a.saturation, 0, 200) / 100).toFixed(3));
  }
  if (a.highlights !== 0 || a.shadows !== 0) {
    const low = bounded(0.25 + bounded(a.shadows, -100, 100) / 100 * 0.12, 0.13, 0.37);
    const high = bounded(0.75 + bounded(a.highlights, -100, 100) / 100 * 0.12, 0.63, 0.87);
    filters.push("curves=all='0/0 0.25/" + low.toFixed(3) + " 0.5/0.5 0.75/" + high.toFixed(3) + " 1/1'");
  }
  if (a.sharpen > 0) filters.push('unsharp=5:5:' + (bounded(a.sharpen, 0, 100) / 50).toFixed(2) + ':5:5:0.00');
  if (a.grain > 0) filters.push('noise=alls=' + (bounded(a.grain, 0, 100) * 0.18).toFixed(1) + ':allf=t+u');
  return filters.join(',');
}
function previewFilter(clip) {
  if (!clip) return '';
  const a = adjustOf(clip), filters = [];
  if (FX[clip.fx || 0] && FX[clip.fx || 0].c) filters.push(FX[clip.fx || 0].c);
  if (a.brightness !== 0) filters.push('brightness(' + (1 + bounded(a.brightness, -100, 100) / 200).toFixed(2) + ')');
  if (a.contrast !== 100) filters.push('contrast(' + Math.max(0, bounded(a.contrast, 0, 200) / 100).toFixed(2) + ')');
  if (a.saturation !== 100) filters.push('saturate(' + (bounded(a.saturation, 0, 200) / 100).toFixed(2) + ')');
  return filters.join(' ');
}
function overlaySourceAt(overlay, timelineTime) {
  // Keep preview, rendered picture-in-picture, and its audio on the same source-time mapping.
  return Math.max(0, Number(overlay && overlay.sourceIn) || 0) +
    Math.max(0, Number(timelineTime) - (Number(overlay && overlay.start) || 0));
}
function canvasBlendMode(mode) {
  const found = BLEND_OPTIONS.find(item => item[1] === mode);
  return found ? found[2] : 'source-over';
}

const TS = [ // text styles
  () => ({ fill: '#fff', stroke: '#000', strokeWidth: 2 }),
  () => ({ fill: '#fff', strokeWidth: 0, shadow: new fabric.Shadow({ color: '#ff2d95', blur: 26 }) }),
  () => ({ fill: '#111', strokeWidth: 0, backgroundColor: '#ffe14a' }),
  () => ({ fill: '#ffe14a', stroke: '#000', strokeWidth: 5, fontStyle: 'italic', paintFirst: 'stroke' }),
  () => ({ fill: '#fff', strokeWidth: 0, backgroundColor: '#c8101e', fontSize: 44 }),
  () => ({ fill: '#fff', strokeWidth: 0, backgroundColor: '#0b2a5b', fontSize: 40 })];
const BASE_PX = 30;
let PX = BASE_PX; // timeline pixels per second; editable with timeline zoom controls
const uid = () => Math.random().toString(36).slice(2, 10);
const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const TIMELINE_FPS = 30; // One authoritative project/export timebase.
const MIN_TIMELINE_FRAME = 1 / TIMELINE_FPS;
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
  const dismiss = $('busyDismiss');
  dismiss.hidden = false;
  dismiss.disabled = false;
  dismiss.textContent = 'Close';
  dismiss.onclick = hideBusy;
}
function hideBusy() {
  const overlay = $('busyOverlay');
  if (overlay) { overlay.hidden = true; delete overlay.dataset.state; }
  const dismiss = $('busyDismiss');
  if (dismiss) { dismiss.textContent = 'Close'; dismiss.disabled = false; dismiss.onclick = hideBusy; }
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
      const name = `${label.replace(/\.[^.]+$/, '') || 'overlay'}.png`;
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
async function validateTemplateAssets(template, options = {}) {
  // A template can contain original intro/outro clips, a replaceable slot, and audio
  // as well as visual overlays. Check every stored reference before changing the edit.
  const mainClips = [
    ...(template.pre || []),
    ...(template.slotClip && !options.skipSlotClip ? [template.slotClip] : []),
    ...(template.post || [])
  ];
  for (const clip of mainClips) {
    const url = clip.mediaId && await loadMedia(clip.mediaId);
    if (!url) throw new Error(`Template video “${clip.name || 'unnamed clip'}” is missing from this browser's local storage. Re-import it, save the template again, and retry.`);
    const length = await probe(url, 'video');
    if (!Number.isFinite(length) || length <= 0) throw new Error(`Template video “${clip.name || 'unnamed clip'}” cannot be decoded by this browser. Convert it to a standard MP4 or MOV and save the template again.`);
  }
  for (const track of template.audio || []) {
    const url = track.mediaId && await loadMedia(track.mediaId);
    if (!url) throw new Error(`Template audio “${track.name || 'unnamed track'}” is missing from local storage. Re-import it and save the template again.`);
    const length = await probe(url, 'audio');
    if (!Number.isFinite(length) || length <= 0) throw new Error(`Template audio “${track.name || 'unnamed track'}” cannot be decoded by this browser. Re-import it as a supported audio file and save the template again.`);
  }
  for (const overlay of template.overlays || []) {
    if (overlay.type === 'text' || !overlay.mediaId) continue;
    const url = await loadMedia(overlay.mediaId);
    if (!url) throw new Error(`Template media for “${overlay.name || overlay.type}” is missing from local storage. Re-import the original image/video and save the template again.`);
    if (overlay.type === 'image') {
      await loadOverlayImage(url, overlay);
    } else if (overlay.type === 'video') {
      const length = await probe(url, 'video');
      if (!Number.isFinite(length) || length <= 0) {
        throw new Error(`Template overlay video “${overlay.name || 'unnamed video'}” cannot be decoded in this browser. Convert it to MP4 and save the template again.`);
      }
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
const canvas = new fabric.Canvas('overlayCanvas', { enableRetinaScaling: false, preserveObjectStacking: true, selection: false, perPixelTargetFind: false, targetFindTolerance: 12, stopContextMenu: true });
// Keep transform handles physically large on phones even though the editor uses a
// high-resolution logical canvas scaled down to the responsive preview.
const OVERLAY_HANDLE_CSS_PX = 44;
function syncOverlayControls() {
  // Caption persistence and other non-browser tests may provide a canvas-compatible
  // stub that does not implement Fabric's sizing/selection APIs. Overlay handles are
  // optional in those contexts; never let UI sizing break the underlying edit action.
  if (!canvas || typeof canvas.getWidth !== 'function' ||
      typeof canvas.getObjects !== 'function' || typeof canvas.requestRenderAll !== 'function') return;
  const displayWidth = canvas.upperCanvasEl && canvas.upperCanvasEl.getBoundingClientRect().width;
  const logicalWidth = canvas.getWidth();
  if (!displayWidth || !logicalWidth) return;
  const handleSize = Math.max(22, Math.min(180, OVERLAY_HANDLE_CSS_PX * logicalWidth / displayWidth));
  for (const obj of canvas.getObjects()) {
    if (!obj || typeof obj.set !== 'function') continue;
    obj.set({ cornerSize: handleSize, touchCornerSize: handleSize, padding: Math.max(8, handleSize * 0.12),
      transparentCorners: false, cornerColor: '#ff4b55', cornerStrokeColor: '#ffffff', borderColor: '#ff4b55',
      borderScaleFactor: Math.max(1.5, handleSize / 22) });
  }
  canvas.requestRenderAll();
}
// Recalculate handle hit areas when the preview changes size (rotation, split-screen,
// responsive layout), without rebuilding or moving any overlay objects.
if (typeof ResizeObserver !== 'undefined') {
  const overlayResizeObserver = new ResizeObserver(() => requestAnimationFrame(syncOverlayControls));
  overlayResizeObserver.observe($('previewFrame'));
} else {
  window.addEventListener('resize', () => requestAnimationFrame(syncOverlayControls), { passive: true });
}
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
  requestAnimationFrame(syncOverlayControls);
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

async function buildObject(o, { restackAfter = true } = {}) {
  const [w, h] = RATIOS[S.ratio];
  let obj;
  if (o.type === 'text') {
    await ensureFontsReady();
    obj = new fabric.Textbox(o.text, { width: w * 0.8, fontFamily: 'Avenir Next, Avenir, Segoe UI, system-ui, sans-serif', fontWeight: 700, fontSize: 56, textAlign: 'center', ...TS[o.style || 0]() });
  } else {
    const url = await loadMedia(o.mediaId); if (!url) return;
    let el;
    if (o.type === 'video') {
      el = document.createElement('video'); el.src = url; el.muted = true; el.playsInline = true; o.el = el;
      await new Promise((resolve, reject) => { el.onloadeddata = resolve; el.onerror = () => reject(new Error('Could not read this overlay video. Try converting it to MP4.')); });
      el.width = el.videoWidth; el.height = el.videoHeight;
      const decodedDuration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration :
        (Number.isFinite(o.srcDur) && o.srcDur > 0 ? o.srcDur : o.dur);
      o.srcDur = decodedDuration;
      o.sourceIn = Math.max(0, Math.min(Number(o.sourceIn) || 0, Math.max(0, decodedDuration - 0.001)));
      obj = new fabric.Image(el);
    } else {
      el = await loadOverlayImage(url, o);
      obj = new fabric.Image(el);
    }
    if (o.scaleX == null) { o.scaleX = o.scaleY = (w * 0.4) / obj.width; }
  }
  Object.assign(obj, { pmId: o.id, layer: o.layer });
  obj.set({ left: o.left ?? w * 0.1, top: o.top ?? h * 0.1, scaleX: o.scaleX ?? 1, scaleY: o.scaleY ?? 1, angle: o.angle || 0, opacity: bounded(o.opacity ?? 1, 0, 1), globalCompositeOperation: canvasBlendMode(o.blend || 'normal'), cornerSize: 22, transparentCorners: false, cornerColor: '#ff4b55', cornerStrokeColor: '#ffffff', borderColor: '#ff4b55', lockUniScaling: o.type !== 'text', lockScalingFlip: true, centeredScaling: false, perPixelTargetFind: false });
  Object.assign(o, { left: obj.left, top: obj.top, scaleX: obj.scaleX, scaleY: obj.scaleY });
  if (o.key && obj.applyFilters) { obj.filters = [keyFilter(o.key)]; obj.applyFilters(); }
  canvas.add(obj); syncOverlayControls(); if (restackAfter) restack(); return obj;
}
function releaseOverlayMediaElement(element) {
  if (!element || String(element.tagName || '').toUpperCase() !== 'VIDEO') return;
  try { element.pause(); } catch (_) {}
  try { element.removeAttribute('src'); element.load(); } catch (_) {}
}
function disposeOverlayObject(object, overlay) {
  if (object) {
    // After restore(), S already points at snapshot objects without .el. The live
    // video element must therefore be released through the Fabric object itself.
    try { if (typeof object.getElement === 'function') releaseOverlayMediaElement(object.getElement()); } catch (_) {}
    try { canvas.remove(object); } catch (_) { /* already detached */ }
    try { if (typeof object.dispose === 'function') object.dispose(); } catch (_) { /* release best-effort */ }
  }
  const element = overlay && overlay.el;
  if (element) {
    releaseOverlayMediaElement(element);
    delete overlay.el;
  }
}
let rebuildGeneration = 0;
async function rebuildCanvas() {
  // Prevent overlapping Undo/Redo rebuilds from leaving stale Fabric objects.
  const generation = ++rebuildGeneration;
  for (const object of canvas.getObjects().slice()) {
    const overlay = S.overlays.find(item => item.id === object.pmId);
    disposeOverlayObject(object, overlay);
  }
  canvas.clear(); sizeCanvas();
  for (const o of [...S.overlays].sort((a, b) => a.layer - b.layer)) {
    if (generation !== rebuildGeneration) return;
    const built = await buildObject(o);
    if (generation !== rebuildGeneration) {
      if (built) disposeOverlayObject(built, o);
      return;
    }
  }
  if (generation === rebuildGeneration) refresh(t);
}
const objOf = id => canvas.getObjects().find(x => x.pmId === id);

/* ---------- Undo / save ---------- */
const snap = () => JSON.stringify(S, (k, v) => (k === 'el' ? undefined : v));
function scheduleProjectSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveProject().catch(err => {
    console.warn('Auto-save failed:', err);
    say('Auto-save failed. Check available storage on this device.');
  }), 800);
}
function commit() {
  undoStack.push(snap()); if (undoStack.length > 50) undoStack.shift(); redoStack = [];
  drawTimeline();
  scheduleProjectSave();
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
$('undoBtn').onclick = async () => {
  if (undoStack.length < 2) return;
  redoStack.push(undoStack.pop());
  await restore(undoStack[undoStack.length - 1]);
  scheduleProjectSave();
};
$('redoBtn').onclick = async () => {
  if (!redoStack.length) return;
  const s = redoStack.pop();
  undoStack.push(s);
  await restore(s);
  scheduleProjectSave();
};
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

/* ---------- Runtime guard: heavy-job safety, background keep-alive, in-place project refresh ---------- */
let exportInProgress = 0, exportCancelRequested = false;
let fontsReadyPromise = null;
// Canvas text is measured the moment it is created. Use the same local system-font stack as the editor,
// and wait only for fonts already used by the document; never depend on an unbundled web font.
function ensureFontsReady() {
  if (fontsReadyPromise) return fontsReadyPromise;
  fontsReadyPromise = (async () => {
    if (!document.fonts || !document.fonts.ready) return;
    try {
      await Promise.race([
        document.fonts.ready,
        new Promise(resolve => setTimeout(resolve, 800))
      ]);
    } catch (_) { /* system-font fallback remains available */ }
  })();
  return fontsReadyPromise;
}

// Reference-counted wrapper around the native Android foreground service (MediaYExportService), so that
// export and caption jobs share one service, start/stop calls never overlap, and the last job stops it.
const Background = (() => {
  let holders = 0, running = false;
  let chain = Promise.resolve();
  const queue = job => (chain = chain.then(job, job));
  return {
    begin() {
      holders++;
      return queue(async () => {
        if (running) return true;
        if (holders <= 0) return false; // the job already ended while an earlier call was in flight
        running = await beginNativeExportService();
        return running;
      });
    },
    end() {
      holders = Math.max(0, holders - 1);
      return queue(async () => {
        if (holders > 0 || !running) return;
        running = false;
        await endNativeExportService();
      });
    },
    get active() { return running; }
  };
})();

// Frees the two big memory users once a job is finished. Both reload automatically on next use.
async function releaseHeavyResources({ includeSpeech = true } = {}) {
  const released = [];
  if (asr && includeSpeech) {
    const model = asr; asr = null;
    try { if (typeof model.dispose === 'function') await model.dispose(); } catch (_) { /* already gone */ }
    released.push('speech model');
  }
  if (ff && !ffLoading && !exportInProgress && !(pendingExportSave && pendingExportSave.engine === ff)) { disposeFFmpeg(); released.push('video engine'); }
  return released;
}
function dropMediaCaches() {
  Object.values(audios).forEach(el => { try { el.pause(); el.removeAttribute('src'); el.load(); } catch (_) {} });
  Object.keys(audios).forEach(k => delete audios[k]);
  Object.keys(audioLoads).forEach(k => delete audioLoads[k]);
  try { video.pause(); } catch (_) {}
  delete video.dataset.mid; video.removeAttribute('src'); try { video.load(); } catch (_) {}
  for (const id of Object.keys(urls)) { try { URL.revokeObjectURL(urls[id]); } catch (_) {} delete urls[id]; }
  for (const id of Object.keys(files)) delete files[id];
  for (const id of Object.keys(decoded)) delete decoded[id];
  for (const id of Object.keys(thumbs)) delete thumbs[id];
}
// Does by itself what closing and reopening the app and the project used to do: saves the project, frees the
// heavy engines, forgets cached media handles, then rebuilds preview and timeline from the saved copy.
let reopenInFlight = null;
function reopenProjectInPlace(reason = 'generation') {
  if (reopenInFlight) return reopenInFlight;
  reopenInFlight = (async () => {
    try {
      if (playing) stop();
      const keepTime = Math.min(t, total());
      clearTimeout(saveTimer);
      await saveProject();
      const row = await db.projects.get('current');
      if (!row || typeof row.state !== 'string') throw new Error('The saved copy could not be read back.');
      const next = normalizeState(row.state); // parsed before anything live is touched
      if (next.main.length !== S.main.length || next.audio.length !== S.audio.length || next.overlays.length !== S.overlays.length) {
        throw new Error('The saved copy does not match the project on screen.');
      }
      await releaseHeavyResources();
      dropMediaCaches();
      S = next; sel = null;
      await rebuildCanvas();
      drawTimeline();
      if (S.main.length) await seek(keepTime);
      refresh(keepTime);
      if (S.main.length) setTimeout(preloadEngine, 4000);
      return { ok: true, reason };
    } catch (error) {
      console.warn('In-place project refresh skipped:', error);
      return { ok: false, reason, error };
    } finally {
      reopenInFlight = null;
    }
  })();
  return reopenInFlight;
}

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
  if (S.main.length) setTimeout(preloadEngine, 1500); // warm the export engine in the background
};
const probe = (url, kind = 'video') => new Promise(resolve => {
  const m = document.createElement(kind === 'audio' ? 'audio' : 'video'); m.preload = 'metadata';
  const done = value => { m.onloadedmetadata = null; m.onerror = null; resolve(Number.isFinite(value) ? value : 0); };
  m.onloadedmetadata = () => done(m.duration); m.onerror = () => done(0); m.src = url;
});

/* ---------- Overlays (PiP, stickers, text) ---------- */
async function addOverlay(o) {
  o = { id: uid(), layer: S.nextLayer++, dur: 3, start: t, ...o };
  if (o.type === 'video') {
    o.sourceIn = Math.max(0, Number(o.sourceIn) || 0);
    o.srcDur = Number.isFinite(o.srcDur) && o.srcDur > 0 ? o.srcDur : o.dur;
  }
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
      const replacementDuration = type === 'video' ? await probe(urls[mediaId], 'video') : 0;
      if (type === 'video' && (!Number.isFinite(replacementDuration) || replacementDuration <= 0)) {
        throw new Error('Could not read this replacement overlay video. Try converting it to MP4.');
      }
      const old = objOf(rid); disposeOverlayObject(old, o);
      Object.assign(o, { mediaId, type, name: f.name }); delete o.el; delete o.scaleX; delete o.scaleY;
      if (type === 'video') {
        o.sourceIn = 0;
        o.srcDur = replacementDuration;
        o.dur = Math.min(Number.isFinite(o.dur) && o.dur > 0 ? o.dur : replacementDuration, replacementDuration);
      } else {
        delete o.sourceIn;
        delete o.srcDur;
      }
      await buildObject(o); restack(); commit(); refresh(t); say('Overlay replaced.');
    } else {
      const length = type === 'video' ? await probe(urls[mediaId], 'video') : 5;
      if (type === 'video' && (!Number.isFinite(length) || length <= 0)) throw new Error('Could not read this video. Try an MP4 or MOV file.');
      await addOverlay({ type, mediaId, name: f.name, dur: length, ...(type === 'video' ? { sourceIn: 0, srcDur: length } : {}) });
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
// Programmatic scrolling keeps the playhead visible. Ignore only the matching scroll event;
// otherwise the scroll handler can mistake refresh()/zoom movement for a user scrub.
let programmaticTimelineScroll = null;
function scrollTimelineToTime(time) {
  const maxLeft = Math.max(0, tl.scrollWidth - tl.clientWidth);
  const target = Math.max(0, Math.min(maxLeft, Math.max(0, Number(time) || 0) * PX));
  const current = tl.scrollLeft;
  const moving = Math.abs(current - target) > 0.5;
  // Only arm a guard when this call changes scroll position or supersedes a still-pending write.
  // refresh() runs repeatedly during playback, so no-op writes must not suppress real user scrolls.
  if (moving || programmaticTimelineScroll) {
    programmaticTimelineScroll = { left: target };
    if (moving) tl.scrollLeft = target;
  }
}
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
  const previousScrollLeft = tl.scrollLeft;
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
  // Resizing the timeline can make the browser clamp scrollLeft asynchronously.
  // That clamp is layout housekeeping, not a request to scrub the playhead.
  if (Math.abs(tl.scrollLeft - previousScrollLeft) > 0.5) {
    programmaticTimelineScroll = { left: tl.scrollLeft };
  }
}
const snapT = v => { let a = 0; const e = [0, t, ...S.main.map(c => (a += dur(c)))].find(x => Math.abs(x - v) < 8 / PX); return e != null ? e : v; };

const clampTimelineZoom = value => Math.max(6, Math.min(90, Math.round((Number(value) || BASE_PX) / 3) * 3));
try {
  const savedTimelineZoom = Number(localStorage.getItem('pmy-timeline-zoom'));
  if (Number.isFinite(savedTimelineZoom) && savedTimelineZoom >= 6) PX = clampTimelineZoom(savedTimelineZoom);
} catch (_) {}
$('tlZoom').value = String(PX);
$('tlZoomLabel').textContent = (PX / BASE_PX).toFixed(1) + '×';
function setTimelineZoom(value, persist = false) {
  PX = clampTimelineZoom(value);
  $('tlZoom').value = String(PX);
  $('tlZoomLabel').textContent = (PX / BASE_PX).toFixed(1) + '×';
  drawTimeline();
  scrollTimelineToTime(t);
  if (persist) { try { localStorage.setItem('pmy-timeline-zoom', String(PX)); } catch (_) {} }
}
$('tlZoomOut').onclick = () => setTimelineZoom(PX - 6, true);
$('tlZoomIn').onclick = () => setTimelineZoom(PX + 6, true);
$('tlZoom').oninput = e => setTimelineZoom(Number(e.target.value), false);
$('tlZoom').onchange = e => setTimelineZoom(Number(e.target.value), true);
$('tlZoomFit').onclick = () => {
  const duration = Math.max(total(), 1);
  const fitPx = (tl.clientWidth * 0.5) / duration;
  setTimelineZoom(Math.max(6, Math.min(90, Math.floor(fitPx / 3) * 3)), true);
  say('Timeline zoom adjusted to fit as much of the edit as possible.');
};

function trimActionContext() {
  if (!sel) return null;
  const lane = sel.lane, clip = itemOf(sel.id, lane);
  if (!clip) return null;
  const start = startOf(clip, lane), length = lenOf(clip, lane), offset = t - start;
  // Keep at least one output frame on both sides; trims must be frame-precise, not 0.2s-granular.
  if (!Number.isFinite(start) || !Number.isFinite(length) || length < 2 * MIN_TIMELINE_FRAME ||
      !Number.isFinite(offset) || offset < MIN_TIMELINE_FRAME || offset > length - MIN_TIMELINE_FRAME) return null;
  const sourceAt = lane === 'overlay'
    ? (clip.type === 'video' ? overlaySourceAt(clip, t) : null)
    : clip.in + offset * (lane === 'main' ? (clip.speed || 1) : 1);
  if (lane !== 'overlay' && (!Number.isFinite(sourceAt) || sourceAt <= clip.in || sourceAt >= clip.out)) return null;
  if (lane === 'overlay' && clip.type === 'video' && Number.isFinite(clip.srcDur) && sourceAt >= clip.srcDur) return null;
  return { lane, clip, start, length, offset, sourceAt, at: t };
}
function updateTrimButtons() {
  const enabled = !!trimActionContext();
  ['trimStartBtn', 'trimEndBtn'].forEach(id => {
    const button = $(id);
    if (button) button.disabled = !enabled;
  });
}
function trimSelectionAtPlayhead(mode) {
  if (mode !== 'start' && mode !== 'end') return;
  // Editing while the preview is advancing makes the playhead and source frame race.
  // Stop first, then capture a stable trim context for this single edit transaction.
  if (playing) stop();
  const context = trimActionContext();
  if (!context) {
    updateTrimButtons();
    return say('Place the playhead at least one frame inside the selected clip to trim it.');
  }
  const { lane, clip, start, offset, sourceAt, at } = context;
  if (mode === 'start') {
    if (lane === 'main') {
      // The main video lane is a ripple-joined sequence: remove the lead-in and start
      // the retained source frame at this clip's existing sequence position.
      clip.in = sourceAt;
      t = start;
    } else if (lane === 'audio') {
      clip.in = sourceAt;
      clip.start = at;
    } else {
      if (clip.type === 'video') clip.sourceIn = sourceAt;
      clip.start = at;
      clip.dur -= offset;
    }
  } else {
    if (lane === 'overlay') clip.dur = offset;
    else clip.out = sourceAt;
  }
  commit();
  refresh(Math.max(0, Math.min(t, total())));
  updateTrimButtons();
  say(mode === 'start'
    ? 'From here: removed the selected clip’s lead-in and kept the rest.'
    : 'To here: removed the selected clip’s ending and kept the beginning.');
}
function updateCopyTillButton() {
  const btn = $('copyTillBtn');
  if (!btn) return;
  const item = sel ? itemOf(sel.id, sel.lane) : null;
  const end = item ? startOf(item, sel.lane) + lenOf(item, sel.lane) : Infinity;
  btn.disabled = !item || t - end < 0.2;
}
async function copyTillPlayhead() {
  if (!sel) return say('Select a timeline clip first.');
  const lane = sel.lane, source = itemOf(sel.id, lane);
  if (!source) return say('Select a clip that still exists on the timeline.');
  const start = startOf(source, lane), length = lenOf(source, lane), end = start + length;
  const gap = t - end;
  if (gap < 0.2) return say('Move the playhead at least 0.2 seconds beyond the selected clip, then copy till here.');
  if (!Number.isFinite(length) || length < 0.2) return say('The selected item is too short to copy.');
  const previous = snap();
  const clones = [];
  const cloneRecord = value => JSON.parse(JSON.stringify(value, (key, child) => key === 'el' ? undefined : child));
  try {
    if (lane === 'main') {
      let remaining = gap;
      while (remaining >= 0.2) {
        const part = Math.min(length, remaining);
        if (part < 0.2) break;
        const copy = cloneRecord(source);
        copy.id = uid();
        if (part < length - 0.001) copy.out = Math.min(source.out, source.in + part * (source.speed || 1));
        clones.push(copy);
        remaining -= part;
      }
      S.main.splice(S.main.indexOf(source) + 1, 0, ...clones);
    } else if (lane === 'audio') {
      let position = end, remaining = gap;
      while (remaining >= 0.2) {
        const part = Math.min(length, remaining);
        if (part < 0.2) break;
        const copy = cloneRecord(source);
        copy.id = uid();
        copy.start = position;
        if (part < length - 0.001) copy.out = Math.min(source.out, source.in + part);
        clones.push(copy);
        position += part;
        remaining -= part;
      }
      S.audio.push(...clones);
    } else {
      let position = end, remaining = gap;
      while (remaining >= 0.2) {
        const part = Math.min(length, remaining);
        if (part < 0.2) break;
        const copy = cloneRecord(source);
        copy.id = uid();
        copy.start = position;
        copy.dur = part;
        copy.layer = S.nextLayer++;
        delete copy.el;
        clones.push(copy);
        position += part;
        remaining -= part;
      }
      S.overlays.push(...clones);
      for (const copy of clones) await buildObject(copy);
      restackRows();
    }
    if (!clones.length) return say('There is not enough room before the playhead to make another copy.');
    commit();
    select(clones[clones.length - 1].id, lane);
    refresh(t);
    say('Copied ' + clones.length + ' repeat' + (clones.length === 1 ? '' : 's') + ' up to the playhead.');
  } catch (err) {
    await restore(previous);
    showBusyError('Copy till here failed', err.message || String(err));
  }
}
$('copyTillBtn').onclick = copyTillPlayhead;

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
  $('adjustBtn').hidden = !(on && sel.lane === 'main');
  const blendItem = on && sel.lane === 'overlay' ? S.overlays.find(o => o.id === sel.id) : null;
  $('blendBtn').hidden = !(blendItem && blendItem.type !== 'text');
  updateCopyTillButton();
  updateTrimButtons();
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
tl.addEventListener('scroll', () => {
  if (drag) return;
  const left = tl.scrollLeft, guard = programmaticTimelineScroll;
  if (guard && Math.abs(left - guard.left) < 1.5) {
    programmaticTimelineScroll = null;
    return;
  }
  // A mismatching guard targets an older position; this is a genuine user-driven timeline scroll.
  programmaticTimelineScroll = null;
  const x = left / PX;
  if (Math.abs(x - t) < 1.5 / PX) return;
  lastScroll = Date.now();
  $('playhead').oninput({ target: { time: Math.min(x, total()) } });
});
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
    video.style.display = 'block'; video.style.filter = previewFilter(hit.c);
    video.playbackRate = hit.c.speed || 1; video.volume = Math.min(1, hit.c.vol ?? 1);
  }
  if (Date.now() - lastScroll > 200) scrollTimelineToTime(t);
  $('playhead').value = (t / d) * 1000; $('timeDisplay').textContent = `${fmt(t)} / ${fmt(total())}`;
  S.overlays.forEach(o => {
    const ob = objOf(o.id); if (!ob) return;
    const on = t >= o.start && t <= o.start + o.dur;
    if (on && !ob.visible && o.type === 'text' && !o.caption) anime({ targets: ob, opacity: [0, 1], duration: 400, easing: 'easeOutCubic', update: () => canvas.requestRenderAll() });
    ob.visible = on; if (o.key && on && ob.applyFilters) ob.applyFilters();
    if (o.el && on) { const want = overlaySourceAt(o, t); if (playing && o.el.paused) o.el.play().catch(() => {}); if (!playing && Math.abs(o.el.currentTime - want) > 0.1) o.el.currentTime = want; }
    else if (o.el && !o.el.paused) o.el.pause();
  });
  canvas.requestRenderAll();
  updateCopyTillButton();
  updateTrimButtons();
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
$('trimStartBtn').onclick = () => trimSelectionAtPlayhead('start');
$('trimEndBtn').onclick = () => trimSelectionAtPlayhead('end');
$('deleteBtn').onclick = () => {
  if (!sel) return say('Tap a clip first.');
  if (sel.lane === 'overlay') { const overlay = S.overlays.find(x => x.id === sel.id); disposeOverlayObject(objOf(sel.id), overlay); }
  S[sel.lane === 'main' ? 'main' : sel.lane === 'audio' ? 'audio' : 'overlays'] = S[sel.lane === 'main' ? 'main' : sel.lane === 'audio' ? 'audio' : 'overlays'].filter(x => x.id !== sel.id);
  sel = null; commit(); refresh(Math.min(t, total()));
};
$('aspectRatio').onchange = async e => {
  const [ow, oh] = RATIOS[S.ratio]; S.ratio = e.target.value; const [nw, nh] = RATIOS[S.ratio];
  S.overlays.forEach(o => { o.left = (o.left ?? 0) * nw / ow; o.top = (o.top ?? 0) * nh / oh; o.scaleX *= nw / ow; o.scaleY *= nw / ow; });
  await rebuildCanvas(); commit();
};

/* ---------- Export: FFmpeg.wasm, one clip at a time (chunked) ---------- */
// FFmpeg's small wrapper and class-worker chunk are hosted in this app's origin.
// This avoids the cross-origin Worker path that produced "ffmpeg is not loaded" in WebView.
let ff, ffLogs = [], exportProgressHandler = null, exportClipIndex = 0, exportGroupIndex = 0, ffAssetURLs = [], ffLoading = null, ffQuiet = false, ffLastActivityAt = 0;
let pendingExportSave = null;
const CDN = 'https://cdn.jsdelivr.net/npm/';
// The engine (~31 MB) is kept in Cache Storage so it is downloaded once, not on every app launch.
// The cache name deliberately does not start with "pmy-", so sw.js cleanup never deletes it.
const ENGINE_CACHE = 'mediay-engine-v1';
const engineBusy = (...args) => { if (!ffQuiet) updateBusy(...args); }; // silent while the engine preloads in the background
async function remoteBlobURL(url, mimeType) {
  const assetName = url.split('/').pop() || 'FFmpeg asset';
  let cache = null, blob = null;
  try {
    cache = await caches.open(ENGINE_CACHE);
    const hit = await cache.match(url);
    if (hit) blob = await hit.blob();
  } catch (_) { cache = null; /* Cache Storage unavailable: fall back to the network every time */ }
  if (!blob) {
    engineBusy('Downloading video engine…', `Downloading ${assetName}. This only happens once.`, null, 'Engine download');
    const response = await fetch(url, { mode: 'cors', cache: 'force-cache' });
    if (!response.ok) throw new Error(`Could not download FFmpeg component (${response.status}): ${url}`);
    const total = Number(response.headers.get('content-length')) || 0;
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader(), chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        const detail = total
          ? `${assetName}: ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
          : `${assetName}: ${(received / 1048576).toFixed(1)} MB downloaded`;
        engineBusy('Downloading video engine…', detail, total ? received / total * 100 : null, 'Engine download');
      }
      blob = new Blob(chunks, { type: mimeType });
    } else {
      blob = await response.blob();
    }
    if (cache) cache.put(url, new Response(blob, { headers: { 'Content-Type': mimeType } })).catch(() => {}); // best effort
  }
  const objectURL = URL.createObjectURL(new Blob([blob], { type: mimeType }));
  ffAssetURLs.push(objectURL);
  return objectURL;
}
function disposeFFmpeg() {
  try { if (ff) ff.terminate(); } catch (_) { /* engine may already be stopped */ }
  ff = null;
  for (const url of ffAssetURLs) URL.revokeObjectURL(url);
  ffAssetURLs = [];
}
async function loadFFmpegEngine() {
  if (ff) disposeFFmpeg();
  if (!window.FFmpegWASM || typeof FFmpegWASM.FFmpeg !== 'function') {
    throw new Error('The local FFmpeg wrapper did not load. Reload MediaY; if this persists, redeploy the vendor/ffmpeg files.');
  }
  const core = CDN + '@ffmpeg/core@0.12.10/dist/umd/';
  ff = new FFmpegWASM.FFmpeg();
  ffLastActivityAt = Date.now();
  ff.on('log', ({ message }) => {
    ffLastActivityAt = Date.now();
    const line = String(message || '');
    if (/error|invalid|failed|not found|unsupported|could not|unable|aborted|matches no streams|does not contain any stream/i.test(line)) {
      ffLogs.push(line);
      if (ffLogs.length > 30) ffLogs.shift();
    }
  });
  ff.on('progress', event => { ffLastActivityAt = Date.now(); if (exportProgressHandler) exportProgressHandler(event || {}); });
  try {
    engineBusy('Starting video engine…', 'The core files are ready. Initializing FFmpeg in its local worker.', null, 'Engine startup');
    // Do not pass classWorkerURL: the vendored UMD wrapper automatically resolves
    // 814.ffmpeg.js beside vendor/ffmpeg/ffmpeg.js, so Worker stays same-origin.
    await ff.load({
      coreURL: await remoteBlobURL(core + 'ffmpeg-core.js', 'text/javascript'),
      wasmURL: await remoteBlobURL(core + 'ffmpeg-core.wasm', 'application/wasm'),
    });
    if (!ff.loaded) throw new Error('FFmpeg finished loading without becoming ready.');
    return ff;
  } catch (error) {
    disposeFFmpeg();
    if (isFFmpegCacheIntegrityError(error) && window.caches) {
      caches.delete(ENGINE_CACHE).catch(() => {}); // purge only a cached binary that failed integrity/instantiation
    }
    throw error;
  }
}
function isFFmpegCacheIntegrityError(error) {
  const message = String(error && error.message || error || '');
  const wasmCompileFailure = typeof WebAssembly !== 'undefined' &&
    ((WebAssembly.CompileError && error instanceof WebAssembly.CompileError) ||
     (WebAssembly.LinkError && error instanceof WebAssembly.LinkError));
  return !!wasmCompileFailure || /integrity|checksum|digest mismatch|WebAssembly\.(?:instantiate|compile)|failed to asynchronously prepare wasm|expected magic word|wasm magic (?:header|number)/i.test(message);
}
// One shared load: a background preload and an Export tap can never start two engines.
function getFFmpeg() {
  if (ff && ff.loaded) return Promise.resolve(ff);
  if (!ffLoading) {
    const p = loadFFmpegEngine(), clear = () => { if (ffLoading === p) ffLoading = null; };
    ffLoading = p; p.then(clear, clear);
  }
  return ffLoading;
}
// Warm the engine while the person edits, so Export doesn't begin with a 30 MB download and startup.
// Skipped on data saver / mobile data: there it loads only when Export is tapped.
function preloadEngine() {
  if ((ff && ff.loaded) || ffLoading) return;
  const net = navigator.connection;
  if (net && (net.saveData || net.type === 'cellular')) return;
  ffQuiet = true;
  getFFmpeg().catch(() => { /* Export will retry and report any real error */ }).finally(() => { ffQuiet = false; });
}
let activeExportMetric = null;
function createMediaYMetric(kind, metadata = {}) {
  const started = performance.now();
  const stageTotals = Object.create(null), commandTotals = Object.create(null);
  let currentStage = 'Setup', stageStarted = started, finished = false;
  const addTime = (bucket, name, ms) => {
    const item = bucket[name] || (bucket[name] = { count: 0, durationMs: 0, failures: 0 });
    item.count++;
    item.durationMs += Math.max(0, ms);
  };
  const categorizeOutput = output => {
    if (/^seg\d+\.mp4$/.test(output)) return 'clip encoding';
    if (/^grp\d+\.mp4$/.test(output)) return 'transition rendering';
    if (output === 'joined.mp4' || output === 'list.txt') return 'final assembly';
    if (output === 'final.mp4') return 'audio mix';
    return 'other FFmpeg commands';
  };
  return {
    note(key, value) { if (!finished) metadata[key] = value; }, // extra facts for the report, e.g. which video engine was used
    stage(name) {
      if (finished) return;
      const now = performance.now();
      stageTotals[currentStage] = (stageTotals[currentStage] || 0) + Math.max(0, now - stageStarted);
      currentStage = name;
      stageStarted = now;
    },
    command(output, durationMs, success) {
      if (finished) return;
      const name = categorizeOutput(output);
      addTime(commandTotals, name, durationMs);
      if (!success) commandTotals[name].failures++;
    },
    finish(outcome = 'complete') {
      if (finished) return this.report;
      this.stage('Finalization');
      finished = true;
      const roundBuckets = bucket => Object.fromEntries(
        Object.entries(bucket).map(([key, item]) => [key, {
          count: item.count, durationMs: Math.round(item.durationMs), failures: item.failures
        }])
      );
      this.report = {
        schemaVersion: 1,
        kind,
        timestamp: new Date().toISOString(),
        outcome,
        durationMs: Math.round(performance.now() - started),
        metadata: { ...metadata },
        stages: Object.fromEntries(Object.entries(stageTotals).map(([key, value]) => [key, Math.round(value)])),
        ffmpegCommands: roundBuckets(commandTotals)
      };
      return this.report;
    }
  };
}
const recentMediaYMetrics = { export: null, captions: null };
function renderMediaYPerformanceReport() {
  const el = $('perfReport');
  if (!el) return;
  const reports = [recentMediaYMetrics.export, recentMediaYMetrics.captions].filter(Boolean);
  if (!reports.length) {
    el.textContent = 'No diagnostics yet. Run an export or generate captions to record stage timings on this device.';
    return;
  }
  const seconds = ms => (ms / 1000).toFixed(2) + ' s';
  el.textContent = reports.map(report => {
    const lines = [
      `MediaY ${report.kind} report`,
      `Time: ${report.timestamp}`,
      `Result: ${report.outcome}`,
      `Total: ${seconds(report.durationMs)}`,
      `Settings: ${JSON.stringify(report.metadata)}`,
      'Stage timings:'
    ];
    for (const [name, ms] of Object.entries(report.stages)) lines.push(`  ${name}: ${seconds(ms)}`);
    if (Object.keys(report.ffmpegCommands || {}).length) {
      lines.push('FFmpeg command timings (included in stage totals):');
      for (const [name, detail] of Object.entries(report.ffmpegCommands)) {
        lines.push(`  ${name}: ${seconds(detail.durationMs)} across ${detail.count} command(s), ${detail.failures} failed`);
      }
    }
    return lines.join('\n');
  }).join('\n\n');
  window.MediaYDiagnostics = recentMediaYMetrics;
}
$('copyPerfReport').onclick = async () => {
  const text = $('perfReport')?.textContent || '';
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const input = document.createElement('textarea');
      input.value = text;
      input.style.position = 'fixed'; input.style.opacity = '0';
      document.body.appendChild(input); input.select();
      const ok = document.execCommand('copy'); input.remove();
      if (!ok) throw new Error('Clipboard permission is unavailable.');
    }
    say('Performance report copied. It contains timings, not media content.');
  } catch (_) {
    say('Could not access the clipboard. Select the report text and copy it manually.');
  }
};
renderMediaYPerformanceReport();
window.MediaYDiagnostics = recentMediaYMetrics;
const run = async args => {
  if (exportCancelRequested) throw new Error('Export cancelled');
  const engine = ff;
  if (!engine || !engine.loaded) throw new Error('The FFmpeg engine is not ready. Please retry the export.');
  const started = performance.now();
  let success = false;
  let watchdogTimer = null;
  const output = String(args && args.length ? args[args.length - 1] : '');
  // FFmpeg can legitimately run for a long time. Use an inactivity watchdog rather
  // than a fixed command deadline, resetting it whenever the worker emits logs/progress.
  const watchdog = new Promise((_, reject) => {
    const checkActivity = () => {
      if (exportCancelRequested) return reject(new Error('Export cancelled'));
      const idleMs = Date.now() - ffLastActivityAt;
      const idleLimitMs = 15 * 60 * 1000;
      if (idleMs >= idleLimitMs) {
        if (ff === engine) disposeFFmpeg();
        return reject(new Error('FFmpeg stopped reporting activity for 15 minutes. The export was stopped to prevent an indefinite hang. Your project was not changed; please retry.'));
      }
      watchdogTimer = window.setTimeout(checkActivity, Math.min(30_000, idleLimitMs - idleMs));
    };
    watchdogTimer = window.setTimeout(checkActivity, 30_000);
  });
  try {
    const code = await Promise.race([engine.exec(args), watchdog]);
    if (code !== 0) throw new Error('FFmpeg failed (code ' + code + ')');
    success = true;
    return code;
  } finally {
    if (watchdogTimer !== null) window.clearTimeout(watchdogTimer);
    if (activeExportMetric) activeExportMetric.command(output, performance.now() - started, success);
  }
};
async function overlayPNG(o, outputWidth = canvas.getWidth()) { // render one overlay alone, full canvas size, transparent
  const obj = objOf(o.id), keep = canvas.getObjects().map(x => x.visible);
  canvas.discardActiveObject(); canvas.getObjects().forEach(x => (x.visible = x === obj));
  const previousComposite = obj && obj.globalCompositeOperation;
  if (obj) obj.globalCompositeOperation = 'source-over'; // render raw pixels and alpha; FFmpeg composites the chosen blend mode per frame
  const multiplier = Math.max(1, Number(outputWidth) / Math.max(1, canvas.getWidth()));
  const url = canvas.toDataURL({ format: 'png', multiplier });
  if (obj) obj.globalCompositeOperation = previousComposite || 'source-over';
  canvas.getObjects().forEach((x, i) => (x.visible = keep[i])); canvas.requestRenderAll();
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

/* ---------- Saving the finished video (Movies/MediaY on Android, browser download on web) ---------- */
const isNative = () => !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());

async function saveVideo(data) {
  if (!data || !Number.isFinite(data.byteLength) || data.byteLength <= 0) {
    throw new Error('The encoder returned an empty MP4. Nothing was saved.');
  }
  const name = `ProjectMedia-Y-${Date.now()}.mp4`;

  if (isNative()) {
    const plugins = (window.Capacitor && window.Capacitor.Plugins) || {};
    const Filesystem = plugins.Filesystem;
    const Share = plugins.Share;
    const MediaYMediaStore = plugins.MediaYMediaStore;
    if (!Filesystem) {
      throw new Error('Android file storage is unavailable in this build. Install the latest MediaY APK and try again.');
    }

    const CHUNK = 3 * 1024 * 1024; // multiple of 3 keeps base64 pieces valid
    let cacheFileCreated = false;
    try {
      for (let i = 0; i < data.length; i += CHUNK) {
        let bin = '';
        const part = data.subarray(i, i + CHUNK);
        for (let j = 0; j < part.length; j += 0x8000) {
          bin += String.fromCharCode.apply(null, part.subarray(j, j + 0x8000));
        }
        const options = { path: name, directory: 'CACHE', data: btoa(bin) };
        if (i === 0) {
          await Filesystem.writeFile(options);
          // Mark the partial file immediately: a later append can fail (for example,
          // when the device runs out of storage) and must not leave a cache orphan.
          cacheFileCreated = true;
        } else await Filesystem.appendFile(options);
      }

      if (MediaYMediaStore && typeof MediaYMediaStore.saveVideo === 'function') {
        try {
          const saved = await MediaYMediaStore.saveVideo({ fileName: name });
          await Filesystem.deleteFile({ path: name, directory: 'CACHE' }).catch(() => {});
          return {
            method: 'device',
            filename: (saved && saved.fileName) || name,
            location: (saved && saved.location) || 'Movies/MediaY'
          };
        } catch (saveError) {
          // Preserve the completed export: offer the Android chooser only when direct saving fails.
          if (!Share || typeof Share.share !== 'function' || document.visibilityState === 'hidden') {
            throw new Error('Could not save the MP4 to Movies/MediaY: ' + (saveError && saveError.message || saveError));
          }
          const { uri } = await Filesystem.getUri({ path: name, directory: 'CACHE' });
          say('Direct save to Movies failed. Choose a device-save option in the Android share sheet.');
          await Share.share({ title: name, url: uri, dialogTitle: 'Save or share your video' });
          await Filesystem.deleteFile({ path: name, directory: 'CACHE' }).catch(() => {});
          return { method: 'share-fallback', filename: name, location: 'Android share sheet' };
        }
      }

      // Compatibility for older APKs that predate the MediaStore plugin.
      // The new APK saves directly to Movies/MediaY and does not open the share sheet.
      if (Share && typeof Share.share === 'function' && document.visibilityState !== 'hidden') {
        const { uri } = await Filesystem.getUri({ path: name, directory: 'CACHE' });
        say('This APK cannot save directly to Movies. Choose a device-save option in the Android share sheet.');
        await Share.share({ title: name, url: uri, dialogTitle: 'Save or share your video' });
        await Filesystem.deleteFile({ path: name, directory: 'CACHE' }).catch(() => {});
        return { method: 'share-fallback', filename: name, location: 'Android share sheet' };
      }
      throw new Error('This APK cannot save directly to Movies/MediaY. Install the latest MediaY build to enable direct device saving.');
    } catch (error) {
      if (cacheFileCreated) await Filesystem.deleteFile({ path: name, directory: 'CACHE' }).catch(() => {});
      throw error;
    }
  }

  const url = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Keep the blob alive long enough for mobile browsers to begin the file download.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { method: 'browser-download', filename: name, location: 'Downloads' };
}

/* Stream a completed FFmpeg file to Android without materializing the entire MP4 in WebView memory. */
async function saveFFmpegOutput(engine, outputPath) {
  const plugins = (window.Capacitor && window.Capacitor.Plugins) || {};
  const nativeStore = isNative() && plugins.MediaYMediaStore;
  if (!nativeStore || typeof nativeStore.beginStreamingSave !== 'function' ||
      typeof engine.readFileChunk !== 'function') {
    // The legacy path must not keep a second full MP4 in FFmpeg MEMFS while
    // saveVideo builds its native/browser delivery copy. Keep the JS buffer
    // attached to a thrown error so Retry save still works after MEMFS cleanup.
    const data = await engine.readFile(outputPath);
    try { await engine.deleteFile(outputPath); } catch (_) { /* retain the in-memory render */ }
    try { return await saveVideo(data); }
    catch (error) { error.renderedData = data; throw error; }
  }
  const name = `ProjectMedia-Y-${Date.now()}.mp4`;
  const CHUNK_BYTES = 1024 * 1024;
  let started = false;
  let offset = 0;
  let totalBytes = null;
  try {
    await nativeStore.beginStreamingSave({ fileName: name });
    started = true;
    while (totalBytes == null || offset < totalBytes) {
      if (exportCancelRequested) throw new Error('Export cancelled');
      const part = await engine.readFileChunk(outputPath, offset, CHUNK_BYTES);
      if (!part || !part.bytesRead || !(part.data instanceof Uint8Array)) {
        throw new Error('The video engine returned an incomplete MP4 chunk.');
      }
      totalBytes = Number(part.fileSize) || totalBytes;
      let binary = '';
      for (let i = 0; i < part.data.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, part.data.subarray(i, i + 0x8000));
      }
      await nativeStore.appendStreamingChunk({ data: btoa(binary) });
      offset += part.bytesRead;
      const progress = totalBytes ? Math.min(99, 97 + offset / totalBytes * 2) : null;
      updateBusy('Saving your MP4…', `Writing ${(offset / 1048576).toFixed(1)} MB of ${(totalBytes / 1048576).toFixed(1)} MB to Movies/MediaY.`, progress, 'Saving video');
      if (part.eof) break;
    }
    if (!totalBytes || offset !== totalBytes) {
      throw new Error('The completed MP4 could not be read in full.');
    }
    if (exportCancelRequested) throw new Error('Export cancelled');
    const cancelButton = $('busyCancel');
    if (cancelButton) {
      cancelButton.disabled = true;
      cancelButton.textContent = 'Finishing save…';
    }
    const saved = await nativeStore.finishStreamingSave();
    started = false;
    return { method: 'device', filename: (saved && saved.fileName) || name,
      location: (saved && saved.location) || 'Movies/MediaY' };
  } catch (error) {
    if (started && typeof nativeStore.abortStreamingSave === 'function') {
      await nativeStore.abortStreamingSave().catch(() => {});
    }
    // Android 9 and earlier retain the established legacy-storage path.
    if (/Android 10 or newer/.test(String(error && error.message || error))) {
      return saveVideo(await engine.readFile(outputPath));
    }
    throw error;
  }
}

// Native Android builds register this plugin during the APK workflow. A foreground
// service helps keep the app process alive during export when the user switches apps.
async function retryPendingExportSave() {
  const pending = pendingExportSave;
  if (!pending || (!pending.engine && !pending.data)) return hideBusy();
  const button = $('busyDismiss');
  button.disabled = true;
  updateBusy('Saving completed video…', 'The render is preserved in MediaY. Retrying the device save.', 97, 'Saving video');
  try {
    const delivery = pending.data ? await saveVideo(pending.data) : await saveFFmpegOutput(pending.engine, pending.path);
    pendingExportSave = null;
    if (pending.engine) { try { await pending.engine.deleteFile(pending.path); } catch (_) {} }
    pending.data = null;
    if (delivery.method === 'device') {
      say(`Export complete — saved to ${delivery.location}/${delivery.filename}. Open Gallery or Files to find it.`);
    } else if (delivery.method === 'browser-download') {
      say(`Export complete — download started for ${delivery.filename}. Check your Downloads folder.`);
    } else {
      say('Export rendered, but direct saving was unavailable. Check the Android share sheet to choose a save destination.');
    }
    await releaseHeavyResources();
    hideBusy();
  } catch (error) {
    console.warn('Could not save the retained MediaY render:', error);
    showBusyError('Save still unavailable', 'Your completed render is still preserved in MediaY memory. Check free storage or Android save permissions, then tap Retry save again. Keep MediaY open.');
    const retry = $('busyDismiss');
    retry.textContent = 'Retry save';
    retry.disabled = false;
    retry.onclick = retryPendingExportSave;
  }
}

async function beginNativeExportService() {
  const plugin = isNative() && window.Capacitor && window.Capacitor.Plugins &&
    window.Capacitor.Plugins.MediaYExportService;
  if (!plugin || typeof plugin.start !== 'function') return false;
  try {
    await plugin.start();
    return true;
  } catch (error) {
    console.warn('Could not start native export foreground service:', error);
    return false;
  }
}
async function endNativeExportService() {
  const plugin = isNative() && window.Capacitor && window.Capacitor.Plugins &&
    window.Capacitor.Plugins.MediaYExportService;
  if (!plugin || typeof plugin.stop !== 'function') return;
  try { await plugin.stop(); }
  catch (error) { console.warn('Could not stop native export foreground service:', error); }
}

const EXP = { res: 720, fps: TIMELINE_FPS, fastDraft: false };
const runExport = async (_event, recoveryAttempt = 0) => {
  if (pendingExportSave) return say('A completed render is waiting to be saved. Tap Retry save before starting another export.');
  exportCancelRequested = false;
  if (!S.main.length) return say('Nothing to export yet.');
  if (captionRunning) return say('Captions are still being generated. Wait for them to finish, then export.');
  const exportMetric = createMediaYMetric('Export', {
    resolution: EXP.res, fps: EXP.fps,
    mainClips: S.main.length, audioTracks: S.audio.length, overlays: S.overlays.length
  });
  activeExportMetric = exportMetric;
  let exportOutcome = 'failed';
  exportMetric.stage('Validate project and media');
  if (playing) stop();
  closeSheet(); const btn = $('goExport'); btn.disabled = true;
  const busyCancelButton = $('busyCancel');
  busyCancelButton.hidden = false;
  busyCancelButton.disabled = false;
  busyCancelButton.textContent = 'Cancel export';
  let exportFailed = false, delivered = null, retryAfterCleanup = false, retryAttempt = recoveryAttempt;
  let preserveOutputPath = null, saveFailurePending = false;
  ffLogs = [];
  const exportWorkspaceFiles = new Set();
  const exportSourceMounts = new Map(); // mounted WORKERFS file path -> mount directory
  const exportSourceCache = new Map();
  const exportOverlayPngCache = new Map();
  let exportSourceCacheBytes = 0, exportOverlayPngCacheBytes = 0;
  const EXPORT_SOURCE_CACHE_LIMIT = 96 * 1024 * 1024;
  const EXPORT_OVERLAY_PNG_CACHE_LIMIT = 12 * 1024 * 1024;
  const removeExportFile = async name => {
    const mountDir = exportSourceMounts.get(name);
    if (ff && mountDir) {
      try { await ff.unmount(mountDir); } catch (_) {}
      try { await ff.deleteDir(mountDir); } catch (_) {}
      exportSourceMounts.delete(name);
    } else {
      try { if (ff) await ff.deleteFile(name); } catch (_) {}
    }
    exportWorkspaceFiles.delete(name);
  };
  const mountExportFile = async (file, name) => {
    const mountDir = '/mediay_src_' + uid();
    await ff.createDir(mountDir);
    try {
      const mounted = await ff.mount('WORKERFS', { blobs: [{ name, data: file }] }, mountDir);
      if (!mounted) throw new Error('FFmpeg WORKERFS is unavailable for source streaming.');
    } catch (error) {
      try { await ff.deleteDir(mountDir); } catch (_) {}
      throw error;
    }
    const mountedPath = mountDir + '/' + name;
    exportWorkspaceFiles.add(mountedPath);
    exportSourceMounts.set(mountedPath, mountDir);
    return mountedPath;
  };
  updateBusy('Preparing your export…', 'Rendering runs in MediaY. Keep the app open and in the foreground until the MP4 is saved.', 1, 'Preparing');
  let exportWakeLock = null;
  let exportVisibilityHandler = null;
  let nativeExportServiceStarted = false;
  const requestExportWakeLock = async () => {
    if (!navigator.wakeLock || document.hidden) return;
    try {
      exportWakeLock = await navigator.wakeLock.request('screen');
      exportWakeLock.addEventListener('release', () => { exportWakeLock = null; }, { once: true });
    } catch (_) { exportWakeLock = null; }
  };
  try {
    exportVisibilityHandler = () => {
      if (document.hidden) {
        say(nativeExportServiceStarted
          ? 'Android export notification is active. If rendering pauses on this device, return to MediaY and leave it open.'
          : 'Export is running. Keep MediaY open; this build has no native background service available.');
      } else {
        say(nativeExportServiceStarted
          ? 'MediaY is active again. The Android export service is running; keep the app open until the MP4 is saved.'
          : 'MediaY is active again. Export is continuing; keep the app open until the MP4 is saved.');
        requestExportWakeLock().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', exportVisibilityHandler);
    nativeExportServiceStarted = await Background.begin();
    if (nativeExportServiceStarted) {
      updateBusy('Preparing your export…', 'An Android export notification is active. You can switch apps while rendering runs; return to MediaY if progress pauses.', 1, 'Preparing');
    } else {
      updateBusy('Preparing your export…', 'Rendering runs in MediaY. Keep the app open in the foreground until the MP4 is saved.', 1, 'Preparing');
    }
    await requestExportWakeLock();
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
    exportMetric.stage('Initialize FFmpeg');
    say('Loading video engine…');
    ffQuiet = false;
    updateBusy('Loading video engine…', 'Getting the rendering engine ready.', 6, 'Loading encoder');
    await getFFmpeg();
    exportMetric.stage('Stage assets and encode clips');
    updateBusy('Rendering video…', 'Encoding each clip with its effects and overlays.', 8, 'Rendering');
    exportProgressHandler = ({ progress }) => {
      const fraction = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
      const overall = 8 + ((exportClipIndex + fraction) / Math.max(1, S.main.length)) * 58;
      updateBusy(`Rendering clip ${Math.min(exportClipIndex + 1, S.main.length)} of ${S.main.length}…`, 'Encoding video, effects, and overlays. Longer clips can take more time.', overall, 'Rendering');
      say(`Rendering clip ${Math.min(exportClipIndex + 1, S.main.length)} of ${S.main.length}…`);
    };
    const [bw, bh] = RATIOS[S.ratio], kk = EXP.res / Math.min(bw, bh), W = Math.round(bw * kk / 2) * 2, H = Math.round(bh * kk / 2) * 2, segs = []; let offset = 0;
    const touchLru = (map, key, value) => { map.delete(key); map.set(key, value); };
    const hasAudioStream = async name => {
      const previousLogs = ffLogs;
      ffLogs = [];
      try {
        await run(['-i', name, '-map', '0:a:0', '-t', '0.1', '-f', 'null', '-']);
        return true;
      } catch (error) {
        const diagnostics = ffLogs.join(' ');
        if (/matches no streams|does not contain any stream/i.test(diagnostics)) return false;
        throw new Error('Could not inspect the audio stream in ' + name + ': ' + String(error && error.message || error));
      } finally {
        ffLogs = [...previousLogs, ...ffLogs].slice(-30);
      }
    };
    const ensureExportSource = async (mediaId, pinnedMediaIds, clipSources) => {
      if (clipSources.has(mediaId)) return clipSources.get(mediaId);
      const cached = exportSourceCache.get(mediaId);
      if (cached) {
        touchLru(exportSourceCache, mediaId, cached);
        clipSources.set(mediaId, cached);
        return cached;
      }
      const file = files[mediaId];
      if (!file || !file.size) throw new Error('A source media file is missing during export.');
      const ext = ((file.name || 'media.mp4').split('.').pop() || 'mp4').toLowerCase();
      const name = `src_${mediaId}.${ext}`;
      const size = file.size;
      let cacheable = size <= EXPORT_SOURCE_CACHE_LIMIT;
      while (cacheable && exportSourceCacheBytes + size > EXPORT_SOURCE_CACHE_LIMIT) {
        const victim = [...exportSourceCache.entries()].find(([id]) => !clipSources.has(id));
        if (!victim) { cacheable = false; break; }
        const [victimId, victimEntry] = victim;
        await removeExportFile(victimEntry.name);
        exportSourceCache.delete(victimId);
        exportSourceCacheBytes -= victimEntry.size;
      }
      // Large single sources are transient to avoid retaining multiple large video blobs in WASM memory.
      if (!cacheable) {
        for (const [victimId, victimEntry] of [...exportSourceCache.entries()]) {
          if (clipSources.has(victimId)) continue;
          await removeExportFile(victimEntry.name);
          exportSourceCache.delete(victimId);
          exportSourceCacheBytes -= victimEntry.size;
        }
      }
      updateBusy('Preparing source media…', `Streaming ${file.name || 'media'} into the encoder without copying the whole file.`, 5 + (segs.length / Math.max(1, S.main.length)) * 5, 'Source preparation');
      const mountedName = await mountExportFile(file, name);
      const entry = { name: mountedName, size, cached: cacheable, mounted: true };
      if (cacheable) {
        exportSourceCache.set(mediaId, entry);
        exportSourceCacheBytes += size;
      }
      clipSources.set(mediaId, entry);
      return entry;
    };
    const ensureOverlayPng = async (overlay, pinnedOverlayIds, clipPngs, tempNames, clipIndex) => {
      if (clipPngs.has(overlay.id)) return clipPngs.get(overlay.id);
      const cached = exportOverlayPngCache.get(overlay.id);
      if (cached) {
        touchLru(exportOverlayPngCache, overlay.id, cached);
        clipPngs.set(overlay.id, cached);
        return cached;
      }
      const png = await overlayPNG(overlay, W);
      const size = png.byteLength;
      let cacheable = size <= EXPORT_OVERLAY_PNG_CACHE_LIMIT;
      while (cacheable && exportOverlayPngCacheBytes + size > EXPORT_OVERLAY_PNG_CACHE_LIMIT) {
        const victim = [...exportOverlayPngCache.entries()].find(([id]) => !pinnedOverlayIds.has(id));
        if (!victim) { cacheable = false; break; }
        const [victimId, victimEntry] = victim;
        await removeExportFile(victimEntry.name);
        exportOverlayPngCache.delete(victimId);
        exportOverlayPngCacheBytes -= victimEntry.size;
      }
      const name = cacheable ? `overlay_${overlay.id}.png` : `ovtemp_${clipIndex}_${overlay.id}.png`;
      await ff.writeFile(name, png);
      exportWorkspaceFiles.add(name);
      const entry = { name, size, cached: cacheable };
      if (cacheable) {
        exportOverlayPngCache.set(overlay.id, entry);
        exportOverlayPngCacheBytes += size;
      } else tempNames.push(name);
      clipPngs.set(overlay.id, entry);
      return entry;
    };
    const TD = S.main.map((c, i) => (i && c.tr ? Math.min(c.trDur || 0.5, dur(S.main[i - 1]) * 0.45, dur(c) * 0.45) : 0)); // overlap length at each clip's start
    // ---- Device video encoder path (WebCodecs) -------------------------------------------------------------------
    // Decoding and encoding video inside WebAssembly is what makes phone exports slow. When the device has its own H.264
    // decoder/encoder and the project is simple (cuts, speed, fades, text/sticker overlays), the video is rendered with them and
    // FFmpeg only does the sound and the final MP4. Returns the finished file name, or null to use the FFmpeg-only path below.
    // ANY problem (unsupported file, slow or failing encoder, memory) cleans up and returns null: this path can never fail an export.
    const tryDeviceEncoderExport = async () => {
      const Fast = window.MediaYFast;
      const note = (key, value) => { if (exportMetric.note) exportMetric.note(key, value); };
      const decline = reason => {
        note('deviceEncoder', 'not used: ' + reason);
        console.info('MediaY: device video encoder not used:', reason);
        return null;
      };
      const savedHandler = exportProgressHandler, mine = new Set(), overlayBitmaps = [];
      try {
        if (exportCancelRequested) throw new Error('Export cancelled');
        if (!Fast) return decline('engine script not loaded');
        const toggle = $('useDeviceEncoder');
        if (toggle && !toggle.checked) return decline('turned off in the export settings');
        const why = Fast.ineligibleReason({
          clips: S.main.map((c, i) => ({ reverse: !!c.rev, effect: !!FX[c.fx || 0].f, adjust: !!adjustmentFilter(c), transition: TD[i] > 0 })),
          overlays: S.overlays.map(o => ({ type: o.type, blend: o.blend }))
        });
        if (why) return decline(why);
        if (S.main.some(c => (c.speed || 1) < 0.5 || (c.speed || 1) > 2)) return decline('unusual playback speed');
        // Sources must be plain MP4/MOV files this device can decode. They are read in pieces, never loaded whole.
        const sources = new Map();
        for (const c of S.main) {
          if (exportCancelRequested) throw new Error('Export cancelled');
          if (sources.has(c.mediaId)) continue;
          const info = await Fast.demux(files[c.mediaId]);
          if (exportCancelRequested) throw new Error('Export cancelled');
          if (!(await Fast.checkDecoder(info.video))) return decline('this device cannot decode ' + info.video.codec);
          sources.set(c.mediaId, info);
        }
        const audioFlags = S.main.map(c => !!sources.get(c.mediaId).hasAudio);
        const hasAudio = audioFlags.some(Boolean);

        exportMetric.stage('Check device video encoder');
        updateBusy('Checking this phone’s video encoder…', 'Looking for a hardware video encoder.', 7, 'Preparing');
        // Keep each hardware-encoded piece below the existing memory budget. A short
        // bounded render is muxed immediately, so JS never retains the entire video stream.
        // The final MP4 is assembled from compatible MP4 pieces with stream copy.
        const maxBufferedVideoBytes = 32 * 1024 * 1024;
        const estimatedBitrate = Fast.targetBitrate(W, H, EXP.fps);
        const maxChunkFrames = Math.max(1, Math.min(Math.round(30 * EXP.fps),
          Math.floor((maxBufferedVideoBytes * 8 / Math.max(1, estimatedBitrate * 1.5)) * EXP.fps)));
        const choice = await Fast.chooseEncoderConfig({ W, H, fps: EXP.fps });
        const bench = await Fast.benchmarkEncoder(choice);
        note('deviceEncoderSelfTest', `${choice.codec}, ${choice.acceleration}, ${Math.round(bench.fps)} fps`);
        if (bench.fps < 2) return decline(`encoder self-test too slow (${bench.fps.toFixed(1)} fps)`);

        exportMetric.stage('Render video on device');
        say('Rendering with this phone’s video encoder…');
        updateBusy('Preparing overlays…', 'Rendering captions and stickers.', 8, 'Rendering');
        // Use the exact frame-aligned project duration for overlay clipping.
        const totalFrames = S.main.reduce((sum, c) => sum + Fast.frameCount(dur(c), EXP.fps), 0);
        const totalSeconds = totalFrames / EXP.fps;
        const overlays = [];
        for (const o of [...S.overlays].sort((x, y) => x.layer - y.layer)) {
          if (!(o.start < totalSeconds && o.start + o.dur > 0)) continue;
          const part = await Fast.overlayFromPng(await overlayPNG(o, W), W, H);
          if (part) { overlayBitmaps.push(part.bitmap); overlays.push({ ...part, start: o.start, end: o.start + o.dur }); }
        }

        const videoSegments = [], clipFrames = [];
        const minPieceFrames = Math.max(1, Math.round(EXP.fps));
        let adaptiveChunkLimit = maxChunkFrames;
        let renderedFrames = 0, segmentIndex = 0, timelineOffset = 0;
        const rate = String(EXP.fps);
        exportProgressHandler = null;
        for (let i = 0; i < S.main.length; i++) {
          const c = S.main[i], speed = c.speed || 1;
          const framesInClip = Fast.frameCount(dur(c), EXP.fps);
          clipFrames[i] = framesInClip;
          for (let frameOffset = 0; frameOffset < framesInClip;) {
            let chunkFrames = Math.min(adaptiveChunkLimit, framesInClip - frameOffset);
            const rawName = `fastvideo_${segmentIndex}.h264`;
            const segmentName = `fastsegment_${segmentIndex}.mp4`;
            exportWorkspaceFiles.add(rawName); exportWorkspaceFiles.add(segmentName);
            mine.add(rawName); mine.add(segmentName);
            let result, sink, encodedChunk;
            for (;;) {
              const chunkDuration = chunkFrames / EXP.fps;
              const chunkStart = timelineOffset + frameOffset / EXP.fps;
              const chunkEnd = chunkStart + chunkDuration;
              const sourceIn = c.in + frameOffset / EXP.fps * speed;
              const sourceOut = sourceIn + chunkDuration * speed;
              const localOverlays = overlays
                .filter(o => o.start < chunkEnd && o.end > chunkStart)
                .map(o => ({ ...o, start: Math.max(0, o.start - chunkStart), end: Math.min(chunkDuration, o.end - chunkStart) }));
              sink = new Fast.AnnexBSink(maxBufferedVideoBytes);
              try {
                result = await Fast.renderTimeline({
                  clips: [{
                    file: files[c.mediaId], track: sources.get(c.mediaId).video,
                    in: sourceIn, out: sourceOut, speed,
                    fadeIn: !!c.fade && frameOffset === 0,
                    fadeOut: !!c.fade && frameOffset + chunkFrames === framesInClip
                  }],
                  overlays: localOverlays, W, H, fps: EXP.fps, choice, sink,
                  isCancelled: () => exportCancelRequested,
                  onProgress: f => {
                    const progress = (renderedFrames + f * chunkFrames) / Math.max(1, totalFrames);
                    updateBusy('Rendering video…', `Encoding with this phone’s video encoder: ${Math.round(progress * 100)}%.`,
                      8 + progress * 50, 'Rendering');
                  }
                });
              } catch (error) {
                if (error && error.code === 'PIECE_BUDGET_EXCEEDED' && chunkFrames > minPieceFrames) {
                  // Discard the failed partial chunk and retry at half the frame count.
                  // Never shrink below one second; if that still exceeds the cap, fall back.
                  sink.parts = []; sink.bytes = 0; sink.frameCount = 0;
                  chunkFrames = Math.max(minPieceFrames, Math.floor(chunkFrames / 2));
                  adaptiveChunkLimit = Math.min(adaptiveChunkLimit, chunkFrames);
                  note('deviceEncoderBudgetRetry', `retrying with ${chunkFrames} frames per piece`);
                  continue;
                }
                throw error;
              }
              if (sink.frameCount !== chunkFrames) {
                throw new Error(`Device encoder emitted ${sink.frameCount} frames for ${chunkFrames} submitted frames; using the FFmpeg fallback.`);
              }
              encodedChunk = sink.finish();
              break;
            }
            await ff.writeFile(rawName, encodedChunk);
            // Drop the JS copy before the next chunk is rendered.
            await run(['-f', 'h264', '-framerate', rate, '-i', rawName, '-c:v', 'copy', '-an', segmentName]);
            await removeExportFile(rawName);
            videoSegments.push(segmentName);
            renderedFrames += result.frames;
            frameOffset += chunkFrames;
            segmentIndex++;
          }
          timelineOffset += dur(c);
        }
        overlayBitmaps.splice(0).forEach(b => { try { b.close(); } catch (_) { /* already closed */ } });

        // Sound: one small FFmpeg command per original clip, padded to the exact
        // accumulated video-frame duration. Chunk boundaries do not reset audio timing.
        const audioNames = [];
        if (hasAudio) {
          exportMetric.stage('Prepare clip sound');
          for (let i = 0; i < S.main.length; i++) {
            const c = S.main[i], sp = c.speed || 1, td = (c.out - c.in) / sp, seconds = clipFrames[i] / EXP.fps;
            updateBusy('Preparing sound…', `Clip ${i + 1} of ${S.main.length}.`, 58 + (i / S.main.length) * 8, 'Audio');
            const name = `aseg${i}.wav`;
            exportWorkspaceFiles.add(name); mine.add(name);
            if (!audioFlags[i]) {
              await run(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', seconds.toFixed(4),
                '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', name]);
              audioNames.push(name);
              continue;
            }
            const entry = await ensureExportSource(c.mediaId, new Set([c.mediaId]), new Map());
            const fd = Math.min(0.4, Math.max(0.05, td / 2));
            const chain = [sp !== 1 && `atempo=${sp}`, (c.vol ?? 1) !== 1 && `volume=${c.vol}`,
              c.fade && `afade=type=in:duration=${fd.toFixed(3)},afade=type=out:start_time=${Math.max(0, td - fd).toFixed(3)}:duration=${fd.toFixed(3)}`,
              `apad=whole_dur=${seconds.toFixed(4)}`].filter(Boolean).join(',');
            try {
              await run(['-ss', String(c.in), '-t', String(c.out - c.in), '-i', entry.name, '-map', '0:a:0', '-vn', '-af', chain,
                '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', '-t', seconds.toFixed(4), name]);
            } finally {
              if (!entry.cached) await removeExportFile(entry.name);
            }
            audioNames.push(name);
          }
        }

        exportMetric.stage('Join rendered clips');
        updateBusy('Assembling the video…', 'Joining the encoded pieces without re-encoding.', 67, 'Final assembly');
        const videoList = 'vlist.txt';
        await ff.writeFile(videoList, new TextEncoder().encode(videoSegments.map(n => `file '${n}'`).join('\n')));
        exportWorkspaceFiles.add(videoList); mine.add(videoList);
        exportWorkspaceFiles.add('joined.mp4'); mine.add('joined.mp4');
        if (audioNames.length) {
          await ff.writeFile('alist.txt', new TextEncoder().encode(audioNames.map(n => `file '${n}'`).join('\n')));
          exportWorkspaceFiles.add('alist.txt'); mine.add('alist.txt');
          await run(['-f', 'concat', '-safe', '0', '-i', videoList, '-f', 'concat', '-safe', '0', '-i', 'alist.txt',
            '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2', 'joined.mp4']);
        } else {
          await run(['-f', 'concat', '-safe', '0', '-i', videoList, '-map', '0:v:0', '-c:v', 'copy', '-an', 'joined.mp4']);
        }
        for (const n of [...videoSegments, videoList, 'alist.txt', ...audioNames]) await removeExportFile(n);
        for (const entry of exportSourceCache.values()) await removeExportFile(entry.name);
        exportSourceCache.clear(); exportSourceCacheBytes = 0;
        note('deviceEncoder', `used (${choice.codec}, ${choice.acceleration}): ${renderedFrames} frames in ${segmentIndex} bounded pieces`);
        return 'joined.mp4';
      } catch (error) {
        console.warn('MediaY: device video encoder failed, using the standard encoder:', error);
        for (const n of mine) await removeExportFile(n);
        exportProgressHandler = savedHandler;
        if (exportCancelRequested) throw error;
        return decline((error && error.name === 'Unsupported' ? '' : 'failed: ') + String(error && error.message || error).slice(0, 160));
      } finally {
        overlayBitmaps.forEach(b => { try { b.close(); } catch (_) { /* already closed */ } });
      }
    };
    // PiP audio is intentionally excluded: preview is muted and there is no overlay-volume control.

    let out = await tryDeviceEncoderExport();
    if (!out) { // ---- FFmpeg-only path: every clip, transition and join runs in WebAssembly ----
    const mainAudioFlags = new Map();
    for (const c of S.main) {
      if (mainAudioFlags.has(c.mediaId)) continue;
      const probeSources = new Map();
      const entry = await ensureExportSource(c.mediaId, new Set([c.mediaId]), probeSources);
      mainAudioFlags.set(c.mediaId, await hasAudioStream(entry.name));
      if (!entry.cached) await removeExportFile(entry.name);
    }
    const hasMainAudio = [...mainAudioFlags.values()].some(Boolean);
    for (let i = 0; i < S.main.length; i++) {
      exportClipIndex = i;
      updateBusy(`Rendering clip ${i + 1} of ${S.main.length}…`, 'Encoding video, effects, and overlays.', 8 + (i / Math.max(1, S.main.length)) * 58, 'Rendering');
      const c = S.main[i], d = c.out - c.in, sp = c.speed || 1, td = d / sp;
      say(`Clip ${i + 1} of ${S.main.length}…`);
      const live = S.overlays.filter(o => (o.type !== 'video' || objOf(o.id)) && o.start < offset + td && o.start + o.dur > offset).sort((a, b) => a.layer - b.layer), geo = [], K = W / RATIOS[S.ratio][0];
      const pinnedMediaIds = new Set([c.mediaId, ...live.filter(o => o.type === 'video').map(o => o.mediaId)]);
      const clipSources = new Map(), clipPngs = new Map(), names = [];
      const sourceEntry = await ensureExportSource(c.mediaId, pinnedMediaIds, clipSources);
      const src = sourceEntry.name;
      const pinnedOverlayIds = new Set(live.filter(o => o.type !== 'video').map(o => o.id));
      const inputs = [];
      for (let k = 0; k < live.length; k++) {
        const o = live[k];
        if (o.type === 'video') { // picture-in-picture video: scale, rotate and place it, starting at the right moment
          const n = (await ensureExportSource(o.mediaId, pinnedMediaIds, clipSources)).name, ob = objOf(o.id), bb = ob.getBoundingRect(true, true), rad = ((ob.angle || 0) * Math.PI / 180).toFixed(4);
          inputs.push('-ss', overlaySourceAt(o, offset).toFixed(2), '-i', n);
          geo[k] = { ox: Math.round(bb.left * K), oy: Math.round(bb.top * K), chain: `${o.start > offset ? `tpad=start_mode=clone:start_duration=${(o.start - offset).toFixed(2)},` : ''}scale=${Math.max(2, Math.round(ob.getScaledWidth() * K))}:${Math.max(2, Math.round(ob.getScaledHeight() * K))}${o.key ? `,chromakey=color=0x${o.key.color.slice(1)}:similarity=${(0.08 + o.key.sim / 100 * 0.32).toFixed(3)}:blend=${((o.key.soft || 0) / 100 * 0.25).toFixed(3)}` : ''}${+rad ? `,format=rgba,rotate=${rad}:ow=rotw(${rad}):oh=roth(${rad}):c=none` : ''},format=rgba,colorchannelmixer=aa=${bounded(o.opacity ?? 1, 0, 1).toFixed(2)}` };
        } else { const n = (await ensureOverlayPng(o, pinnedOverlayIds, clipPngs, names, i)).name; inputs.push('-i', n); }
      }
      const fd = Math.min(0.4, Math.max(0.05, td / 2));
      const videoFadeFilter = c.fade ? ',fade=type=in:duration=' + fd.toFixed(3) + ',fade=type=out:start_time=' + Math.max(0, td - fd).toFixed(3) + ':duration=' + fd.toFixed(3) : '';
      const audioFadeFilter = c.fade ? 'afade=type=in:duration=' + fd.toFixed(3) + ',afade=type=out:start_time=' + Math.max(0, td - fd).toFixed(3) + ':duration=' + fd.toFixed(3) : '';
      const adjFilter = adjustmentFilter(c);
      const fit = 'scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease,pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2:black,setsar=1',
        pace = (sp !== 1 ? 'setpts=PTS/' + sp + ',' : '') + 'fps=' + EXP.fps;
      // Normal/faster speed, not reversed: fps can only DROP frames, so do it first and scale/pad fewer frames (e.g. 60fps footage -> 30fps).
      // Reverse buffers every frame, so it stays after the scale (small frames); slow-motion would duplicate frames, so it also stays after.
      let g = '[0:v]' + (c.rev || sp < 1 ? fit + (c.rev ? ',reverse' : '') + ',' + pace : pace + ',' + fit) +
        (FX[c.fx || 0].f ? ',' + FX[c.fx || 0].f : '') + (adjFilter ? ',' + adjFilter : '') + videoFadeFilter + '[b0]', last = 'b0';
      live.forEach((o, k) => { // lower layers first so stacking matches the preview
        const blend = o.type !== 'video' ? (o.blend || 'normal') : 'normal';
        const enable = "enable='between(t," + Math.max(0, o.start - offset).toFixed(2) + ',' + (o.start + o.dur - offset).toFixed(2) + ")'";
        const outTag = 'b' + (k + 1);
        if (blend !== 'normal' && !geo[k]) {
          // Full-canvas overlays use their alpha as a mask so pixels outside the overlay remain unchanged.
          g += ';[' + last + ']format=yuv444p,split[baseKeep' + k + '][baseBlend' + k + '];' +
            '[' + (k + 1) + ':v]scale=' + W + ':' + H + ',format=rgba,split[overlayColor' + k + '][overlayAlpha' + k + '];' +
            '[overlayColor' + k + ']format=yuv444p[overlayYuv' + k + '];' +
            '[baseBlend' + k + '][overlayYuv' + k + ']blend=all_mode=' + blend + ':all_opacity=1[blendFrame' + k + '];' +
            "[overlayAlpha" + k + "]alphaextract,format=yuv444p,geq=lum='(lum(X,Y)-16)*255/219':cb='(lum(X,Y)-16)*255/219':cr='(lum(X,Y)-16)*255/219'[blendMask" + k + "];" +
            '[baseKeep' + k + '][blendFrame' + k + '][blendMask' + k + ']maskedmerge=' + enable + '[' + outTag + ']';
        } else {
          g += ';[' + (k + 1) + ':v]' + (geo[k] ? geo[k].chain : 'scale=' + W + ':' + H) + '[s' + k + '];' +
            '[' + last + '][s' + k + ']overlay=' + (geo[k] ? geo[k].ox + ':' + geo[k].oy : '0:0') + ':' + enable + '[' + outTag + ']';
        }
        last = outTag;
      });
      const tx = TD[i + 1] || 0; // hold the last frame so the blend has something to fade from
      if (tx) { g += `;[${last}]tpad=stop_mode=clone:stop_duration=${tx.toFixed(2)}[bt]`; last = 'bt'; }
      const seg = `seg${i}.mp4`;
      exportWorkspaceFiles.add(seg);
      const segDur = (td + tx).toFixed(3);
      const af = [c.rev && 'areverse', sp !== 1 && `atempo=${sp}`, (c.vol ?? 1) !== 1 && `volume=${c.vol}`, c.fade && audioFadeFilter, `apad=whole_dur=${segDur}`].filter(Boolean).join(',');
      const sourceHasAudio = !!mainAudioFlags.get(c.mediaId);
      const addSilence = hasMainAudio && !sourceHasAudio;
      const audioInput = addSilence ? ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'] : [];
      const audioMap = sourceHasAudio ? ['-map', '0:a:0', ...(af ? ['-af', af] : [])]
        : addSilence ? ['-map', `${live.length + 1}:a:0`] : ['-an'];
      const enc = fast => ['-ss', String(c.in), '-t', String(d), ...(fast ? ['-skip_loop_filter', 'all'] : []),
        '-i', src, ...inputs, ...audioInput, '-filter_complex', g, '-map', `[${last}]`, ...audioMap,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
        ...(hasMainAudio ? ['-c:a', 'aac', '-ar', '44100', '-ac', '2'] : []), '-t', segDur, seg]; // -t bounds long overlays and synthetic silence to the segment duration
      // High-bitrate sources can skip loop filtering for faster decode; retry with normal decode if needed.
      const hiRate = (files[c.mediaId].size * 8) / Math.max(1, c.src || dur(c)) > 10e6, tries = hiRate && EXP.fastDraft ? [true, false] : [false];
      let encErr = null;
      for (const fast of tries) {
        try { await run(enc(fast)); encErr = null; break; } catch (e) { encErr = e; await ff.deleteFile(seg).catch(() => {}); }
      }
      if (encErr) throw encErr;
      for (const n of names) await removeExportFile(n);
      for (const [mediaId, entry] of clipSources) {
        if (!entry.cached) await removeExportFile(entry.name);
      }
      segs.push(seg); offset += td;
    }
    for (const entry of exportSourceCache.values()) await removeExportFile(entry.name);
    exportSourceCache.clear(); exportSourceCacheBytes = 0;
    for (const entry of exportOverlayPngCache.values()) await removeExportFile(entry.name);
    exportOverlayPngCache.clear(); exportOverlayPngCacheBytes = 0;
    exportMetric.stage('Render transitions');
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
      exportWorkspaceFiles.add(name);
      let pv = '[0:v]', pa = '[0:a]', cur = dur(S.main[grp[0]]) + TD[grp[1]], fv = '', fa = '';
      grp.slice(1).forEach((i, j) => {
        const d = TD[i], k = j + 1;
        fv += `${pv}[${k}:v]xfade=transition=${S.main[i].tr}:duration=${d.toFixed(2)}:offset=${(cur - d).toFixed(2)}[v${k}];`;
        if (hasMainAudio) fa += `${pa}[${k}:a]acrossfade=d=${d.toFixed(2)}[a${k}];`;
        cur += dur(S.main[i]) + (TD[i + 1] || 0) - d; pv = `[v${k}]`; pa = `[a${k}]`;
      });
      const enc2 = (fc, m) => run([...ins, '-filter_complex', fc, ...m, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
        ...(hasMainAudio ? ['-c:a', 'aac', '-ar', '44100', '-ac', '2'] : []), name]);
      await enc2(hasMainAudio ? fv + fa.slice(0, -1) : fv.slice(0, -1), hasMainAudio ? ['-map', pv, '-map', pa] : ['-map', pv, '-an']);
      pieces.push(name);
    }
    exportProgressHandler = null;
    if (pieces.length === 1) {
      // Avoid an unnecessary concat pass for a single rendered group. Audio mixing must
      // read this actual file, not assume a joined.mp4 was created.
      out = pieces[0];
    } else {
      exportMetric.stage('Join rendered clips');
      updateBusy('Joining clips…', 'Combining the rendered clips into one MP4.', 84, 'Final assembly');
      say('Joining clips…');
      await ff.writeFile('list.txt', new TextEncoder().encode(pieces.map(s => `file '${s}'`).join('\n')));
      exportWorkspaceFiles.add('list.txt');
      exportWorkspaceFiles.add('joined.mp4');
      await run(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'joined.mp4']);
      for (const s of new Set([...segs, ...pieces])) await ff.deleteFile(s).catch(() => {});
      out = 'joined.mp4';
    }
    } // end of the FFmpeg-only video path
    // Picture-in-picture videos are muted in preview and have no overlay-volume control.
    // Do not unexpectedly mix their hidden audio into the exported soundtrack.
    const ovA = [];
    if (S.audio.length || ovA.length) {
      const trk = [
        ...S.audio.map(a => ({ m: a.mediaId, st: a.start, in: a.in, out: a.out, vol: a.vol, fade: a.fade })),
        ...ovA.map(o => ({ m: o.mediaId, st: o.start, in: Number(o.sourceIn) || 0, out: (Number(o.sourceIn) || 0) + o.dur }))
      ];
      const activeTracks = [], ins = [];
      const audioSources = new Map();
      const audioStreamCache = new Map();
      for (const track of trk) {
        // Reuse one file-backed mount and one stream probe for repeated media IDs.
        const sourceEntry = await ensureExportSource(track.m, new Set([track.m]), audioSources);
        const sourceName = sourceEntry.name;
        let hasAudio = audioStreamCache.get(sourceName);
        if (hasAudio === undefined) {
          hasAudio = await hasAudioStream(sourceName);
          audioStreamCache.set(sourceName, hasAudio);
        }
        if (!hasAudio) continue;
        // Give every timeline track its own FFmpeg input index; filter graphs consume input pads once.
        const inputIndex = activeTracks.length + 1; // FFmpeg input 0 is the rendered video.
        ins.push('-i', sourceName);
        activeTracks.push({ ...track, inputIndex });
      }
      const originalHasAudio = await hasAudioStream(out);
      if (activeTracks.length) {
        exportMetric.stage('Mix audio tracks');
        updateBusy('Mixing audio tracks…', 'Combining the original sound, music, and voice-over.', 90, 'Audio');
        say('Mixing audio…');
        const timelineDur = Math.max(0.05, total()).toFixed(3);
        const parts = activeTracks.map((a, i) => {
          const clipLen = Math.max(0.05, a.out - a.in);
          const fd = Math.min(1, Math.max(0.05, clipLen / 2));
          const ms = Math.max(0, Math.round(a.st * 1000));
          return `[${a.inputIndex}:a]atrim=start=${a.in}:end=${a.out},asetpts=PTS-STARTPTS${(a.vol ?? 1) !== 1 ? `,volume=${a.vol}` : ''}${a.fade ? ',afade=type=in:duration=' + fd.toFixed(3) + ',afade=type=out:start_time=' + Math.max(0, clipLen - fd).toFixed(3) + ':duration=' + fd.toFixed(3) : ''},adelay=${ms}:all=1[a${i}]`;
        });
        const mixInputs = (originalHasAudio ? '[0:a]' : '') + activeTracks.map((_, i) => `[a${i}]`).join('');
        const mixCount = activeTracks.length + (originalHasAudio ? 1 : 0);
        const mix = mixCount === 1 ? `${mixInputs}anull[mixed]`
          : `${mixInputs}amix=inputs=${mixCount}:duration=longest:normalize=0[mixed]`;
        const filter = `${parts.join(';')};${mix};[mixed]apad=whole_dur=${timelineDur}[m]`;
        exportWorkspaceFiles.add('final.mp4');
        await run(['-i', out, ...ins, '-filter_complex', filter, '-map', '0:v', '-map', '[m]',
          '-c:v', 'copy', '-c:a', 'aac', '-t', timelineDur, 'final.mp4']);
        out = 'final.mp4';
      }
    }
    exportMetric.stage('Read and save final MP4');
    updateBusy('Preparing your MP4…', 'Writing the final video file.', 97, 'Finishing');
    let delivery;
    try {
      delivery = await saveFFmpegOutput(ff, out);
    } catch (saveError) {
      if (saveError && saveError.renderedData instanceof Uint8Array) {
        pendingExportSave = { engine: null, path: null, data: saveError.renderedData };
        preserveOutputPath = null;
        saveFailurePending = true;
      } else if (ff && ff.loaded) {
        pendingExportSave = { engine: ff, path: out };
        preserveOutputPath = out;
        saveFailurePending = true;
      }
      throw saveError;
    }
    delivered = delivery;
    ['joined.mp4', 'final.mp4', 'list.txt'].forEach(n => ff.deleteFile(n).catch(() => {}));
    exportOutcome = 'complete';
    if (delivery.method === 'device') {
      say(`Export complete — saved to ${delivery.location}/${delivery.filename}. Open Gallery or Files to find it.`);
    } else if (delivery.method === 'browser-download') {
      say(`Export complete — download started for ${delivery.filename}. Check your Downloads folder.`);
    } else {
      say('Export rendered, but direct saving was unavailable. Check the Android share sheet to choose a save destination.');
    }
  } catch (err) {
    exportMetric.stage('Handle export error or recovery');
    console.error(err);
    const errText = String(err && err.message || err);
    if (saveFailurePending && pendingExportSave) {
      exportOutcome = 'rendered; save pending';
      exportFailed = true;
      retryAfterCleanup = false;
      exportProgressHandler = null;
      const message = 'The video finished rendering, but saving failed. Your completed MP4 is still preserved in MediaY memory. Check storage or Android save permissions, then tap Retry save. Keep MediaY open.';
      say(message);
      showBusyError('Video rendered — save failed', message);
      const retry = $('busyDismiss');
      retry.textContent = 'Retry save';
      retry.onclick = retryPendingExportSave;
    } else if (exportCancelRequested || /Export cancelled/i.test(errText)) {
      exportOutcome = 'cancelled';
      exportFailed = false;
      retryAfterCleanup = false;
      exportProgressHandler = null;
      say('Export cancelled. Temporary files were cleaned up; your project was not changed.');
    } else {
    const encoderNotLoaded = /ffmpeg is not loaded|not loaded, call.*ffmpeg\.load|called FFmpeg\.terminate/i.test(errText);
    if (encoderNotLoaded && recoveryAttempt < 1) {
      // The browser/WebView can lose the FFmpeg worker. A truthy `ff` reference is not proof
      // that its worker is still alive; throw it away and rebuild the full export once.
      exportProgressHandler = null;
      disposeFFmpeg();
      ffLogs = [];
      updateBusy('Restarting video engine…', 'The encoder worker stopped responding. MediaY is reloading it and retrying once.', 2, 'Recovery');
      exportOutcome = 'retried after worker failure';
      say('Video engine stopped responding; reloading it and retrying once…');
      retryAfterCleanup = true;
      retryAttempt = recoveryAttempt + 1;
    }
    const memoryProblem = /out of memory|memory access out of bounds|failed to grow memory|cannot allocate|allocation failed|\boom\b/i.test(errText + ' ' + ffLogs.join(' '));
    const fallbackResolution = EXP.res > 1080 ? 1080 : (EXP.res > 720 ? 720 : null);
    if (fallbackResolution && memoryProblem && recoveryAttempt < 1) {
      EXP.res = fallbackResolution;
      [...$('resList').children].forEach(b => b.classList.toggle('on', +b.dataset.v === fallbackResolution));
      exportProgressHandler = null;
      disposeFFmpeg();
      updateBusy(`Retrying at ${fallbackResolution}p…`, 'The selected resolution used too much memory. Retrying at a lower resolution.', 3, 'Retry');
      say(`That size ran out of memory. Trying again at ${fallbackResolution}p…`);
      retryAfterCleanup = true;
      retryAttempt = recoveryAttempt + 1;
    }
    exportProgressHandler = null;
    if (!retryAfterCleanup) {
      exportFailed = true;
      const diagnostics = ffLogs.length ? (' Encoder details: ' + ffLogs.slice(-4).join(' | ').slice(0, 650)) : '';
      const message = 'Export problem: ' + (err && err.message || err) + '. Try 720p or a shorter clip.' + diagnostics;
      say(message);
      showBusyError('Export failed', message);
    }
    }
  } finally {
    exportMetric.stage('Clean FFmpeg workspace');
    // All virtual filesystem inputs and outputs created by this export are session-owned.
    // Clean them on every exit, including encoder recovery and a failed audio mix.
    if (ff) {
      for (const name of [...exportWorkspaceFiles]) {
        if (preserveOutputPath && name === preserveOutputPath) continue;
        await removeExportFile(name);
      }
    }
    exportWorkspaceFiles.clear();
    exportSourceMounts.clear();
    if (!captionRunning) {
      busyCancelButton.hidden = true;
      busyCancelButton.disabled = false;
      busyCancelButton.textContent = 'Request cancellation';
    }
    if (exportVisibilityHandler) document.removeEventListener('visibilitychange', exportVisibilityHandler);
    if (exportWakeLock) {
      try { await exportWakeLock.release(); } catch (_) {}
      exportWakeLock = null;
    }
    await Background.end(); // always balanced with Background.begin above
    const report = exportMetric.finish(exportOutcome);
    recentMediaYMetrics.export = report;
    renderMediaYPerformanceReport();
    if (activeExportMetric === exportMetric) activeExportMetric = null;
  }
  exportProgressHandler = null;
  btn.disabled = false;
  if (retryAfterCleanup) {
    // The previous FFmpeg job, workspace, wake lock, and foreground-service hold are now
    // cleaned up. Only now is it safe to create a replacement worker and retry once.
    return await $('goExport').onclick(null, retryAttempt);
  }
  if (!exportFailed) hideBusy();
  return delivered;
};
$('goExport').onclick = async (event, recoveryAttempt = 0) => {
  exportInProgress++;
  let result;
  try {
    result = await runExport(event, recoveryAttempt);
  } finally {
    exportInProgress--;
    if (!exportInProgress) {
      // The video engine's memory is returned after every export; it reloads on the next one.
      await releaseHeavyResources({ includeSpeech: !captionRunning });
      if (S.main.length) setTimeout(preloadEngine, 4000);
    }
  }
  return result;
};

/* ---------- Effects sheet, fades, text styles ---------- */
const sheet = $('sheet'), clipNow = () => (sel && sel.lane === 'main' ? S.main.find(x => x.id === sel.id) : (locate(t) || {}).c);
function markFx() { const c = clipNow(); [...$('fxList').children].forEach((b, i) => b.classList.toggle('on', i === ((c && c.fx) || 0))); }
function openSheet(name) {
  sheet.hidden = false; sheet.dataset.tab = name;
  sheet.classList.toggle('sheet-tall', name === 'adjust' || name === 'blend');
  document.querySelectorAll('[data-pane]').forEach(p => (p.hidden = p.dataset.pane !== name));
  document.querySelectorAll('.dock button').forEach(b => b.classList.toggle('on', b.dataset.sheet === name));
  if (name === 'fx') markFx(); else if (name === 'adjust') markAdjust(); else if (name === 'blend') markBlend(); else if (name === 'speed') markSp(); else if (name === 'vol') markVol(); else if (name === 'tr') markTr(); else if (name === 'text') markText(); else if (name === 'tpl') markTpl(); else if (name === 'key') markKey(); else if (window.MediaYIcons) MediaYIcons.render(document);
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

/* ---------- Adjustments + blending ---------- */
function markAdjust() {
  const c = clipNow(), a = adjustOf(c);
  document.querySelectorAll('[data-adjust]').forEach(input => {
    const key = input.dataset.adjust;
    input.value = String(a[key]);
    const output = $('adjustVal' + key[0].toUpperCase() + key.slice(1));
    if (output) output.textContent = (a[key] > 0 && (key === 'brightness' || key === 'highlights' || key === 'shadows') ? '+' : '') + a[key] + (key === 'contrast' || key === 'saturation' ? '%' : '');
  });
}
function adjustInputChanged(input) {
  const c = clipNow();
  if (!c) return say('Select a video clip before adjusting it.');
  c.adjust = adjustOf(c);
  c.adjust[input.dataset.adjust] = Number(input.value);
  const key = input.dataset.adjust, output = $('adjustVal' + key[0].toUpperCase() + key.slice(1));
  if (output) output.textContent = (c.adjust[key] > 0 && (key === 'brightness' || key === 'highlights' || key === 'shadows') ? '+' : '') + c.adjust[key] + (key === 'contrast' || key === 'saturation' ? '%' : '');
  refresh(t);
}
document.querySelectorAll('[data-adjust]').forEach(input => {
  input.oninput = () => adjustInputChanged(input);
  input.onchange = () => {
    const c = clipNow();
    if (c) { commit(); refresh(t); say('Adjustment saved. It will be included in the exported video.'); }
  };
});
$('adjustBtn').onclick = () => (sheet.hidden || sheet.dataset.tab !== 'adjust' ? openSheet('adjust') : closeSheet());
$('adjustApplyAll').onclick = () => {
  const c = clipNow();
  if (!c) return say('Select a video clip first.');
  const settings = adjustOf(c);
  S.main.forEach(item => { item.adjust = { ...settings }; });
  commit(); markAdjust(); refresh(t); say('Adjustment settings applied to all video clips.');
};

function blendItem() { return sel && sel.lane === 'overlay' ? S.overlays.find(o => o.id === sel.id) : null; }
function applyBlend(o) {
  const obj = o && objOf(o.id);
  if (!obj) return;
  obj.set({ opacity: bounded(o.opacity ?? 1, 0, 1), globalCompositeOperation: canvasBlendMode(o.blend || 'normal') });
  canvas.requestRenderAll();
}
function markBlend() {
  const o = blendItem(), opacity = o ? Math.round(bounded(o.opacity ?? 1, 0, 1) * 100) : 100;
  $('blendOpacity').value = opacity; $('blendOpacityLabel').textContent = opacity + '%';
  [...$('blendModes').children].forEach(b => b.classList.toggle('on', b.dataset.blend === ((o && o.blend) || 'normal')));
}
$('blendBtn').onclick = () => (sheet.hidden || sheet.dataset.tab !== 'blend' ? openSheet('blend') : closeSheet());
$('blendModes').innerHTML = BLEND_OPTIONS.map(([name, mode]) => '<button type="button" data-blend="' + mode + '">' + name + '</button>').join('');
$('blendModes').onclick = e => {
  const b = e.target.closest('[data-blend]'), o = blendItem();
  if (!b) return;
  if (!o || o.type === 'text') return say('Select a picture or video overlay first.');
  o.blend = b.dataset.blend; applyBlend(o); markBlend(); commit(); refresh(t);
  say((BLEND_OPTIONS.find(item => item[1] === o.blend) || BLEND_OPTIONS[0])[0] + ' blend applied.');
};
$('blendOpacity').oninput = e => {
  const o = blendItem();
  if (!o) return say('Select a picture or video overlay first.');
  o.opacity = Number(e.target.value) / 100;
  $('blendOpacityLabel').textContent = e.target.value + '%';
  applyBlend(o); refresh(t);
};
$('blendOpacity').onchange = () => { if (blendItem()) { commit(); say('Overlay opacity saved.'); } };
$('blendApplyAll').onclick = () => {
  const o = blendItem();
  if (!o) return say('Select a picture or video overlay first.');
  const opacity = bounded(o.opacity ?? 1, 0, 1), mode = o.blend || 'normal';
  S.overlays.forEach(item => { item.opacity = opacity; item.blend = mode; applyBlend(item); });
  commit(); markBlend(); refresh(t); say('Blending settings applied to all overlay layers.');
};

$('fadeBtn').onclick = () => { const c = volClip(); if (!c) return say('Import a video first.'); c.fade = !c.fade; commit(); say(c.fade ? 'Fade in and out added.' : 'Fade removed.'); };
let txtStyle = 0;
$('styleList').innerHTML = ['Classic', 'Neon', 'Label', 'Pop', 'Headline', 'News blue'].map((n, i) => `<button data-ts="${i}" class="${i ? '' : 'on'}">${n}</button>`).join('');
$('styleList').onclick = async e => {
  const b = e.target.closest('[data-ts]'); if (!b) return;
  txtStyle = +b.dataset.ts; [...$('styleList').children].forEach(x => x.classList.toggle('on', x === b));
  const o = sel && sel.lane === 'overlay' && S.overlays.find(x => x.id === sel.id && x.type === 'text');
  if (o) { const old = objOf(o.id); disposeOverlayObject(old, o); o.style = txtStyle; await buildObject(o); refresh(t); commit(); }
};
const textSel = () => { const o = sel && sel.lane === 'overlay' && S.overlays.find(x => x.id === sel.id); return o && o.type === 'text' ? o : null; };
function markText() { const o = textSel(); $('textInput').value = o ? o.text : ''; $('addText').textContent = o ? 'Update text' : 'Add to video'; }
$('addText').onclick = async () => {
  const s = $('textInput').value.trim(); if (!s) return say('Type your text first.');
  const o = textSel();
  if (o) { const old = objOf(o.id); disposeOverlayObject(old, o); o.text = s; await buildObject(o); restack(); commit(); refresh(t); closeSheet(); return; }
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
    slotLen: slot ? dur(slot) : 0, slotClip: slot, proto: slot ? { fx: slot.fx, fade: slot.fade, vol: slot.vol, speed: slot.speed, tr: slot.tr, trDur: slot.trDur } : {}, overlays: st.overlays, audio: st.audio };
  saveTpls([...loadTpls(), tpl]); $('tplName').value = ''; markTpl(); say('Template saved. Next time, tap Use and pick your news videos.');
};
$('tplInput').onchange = async e => {
  const tpl = loadTpls().find(x => x.id === pendingTpl), list = [...e.target.files]; e.target.value = ''; if (!tpl || !list.length) return;
  if ((S.main.length || S.overlays.length || S.audio.length) && !confirm('This replaces your current project. Continue?')) return;
  say('Building your video from the template…');
  updateBusy('Applying template…', 'Importing replacement clips and rebuilding the timeline.', 2, 'Template');
  try {
    await validateTemplateAssets(tpl, { skipSlotClip: true });
    const news = [];
    for (let fileIndex = 0; fileIndex < list.length; fileIndex++) { const file = list[fileIndex]; updateBusy('Applying template…', `Reading replacement video ${fileIndex + 1} of ${list.length}: ${file.name}.`, 5 + (fileIndex / Math.max(1, list.length)) * 60, 'Template'); const mediaId = await storeMedia(file), d = await probe(urls[mediaId]); if (!d || !Number.isFinite(d)) throw new Error('Could not read the duration of ' + file.name + '. Try a standard MP4 or MOV video.'); news.push({ ...tpl.proto, id: uid(), mediaId, name: file.name, in: 0, out: d, src: d, tr: (news.length > 0 || (tpl.pre || []).length > 0) ? tpl.proto.tr : undefined, trDur: tpl.proto.trDur || 0.5 }); }
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
let asr, asrBackend = 'wasm', captionCancelRequested = false, captionRunning = false;
const CAPTION_SAMPLE_RATE = 16000;
const CAPTION_CHUNK_SECONDS = 30;
const abortCaption = () => Object.assign(new Error('Caption generation cancelled.'), { name: 'AbortError' });
// ---- Speech engine: the JavaScript library, its WASM runtime and the model weights are three separate downloads ----
//  1. Library + WASM runtime (CPU engine): bundled in the app under vendor/transformers/ (works offline).
//     The CPU engine falls back to the same version on jsdelivr only if the bundled copy cannot be loaded.
//  2. Library for the optional GPU engine (transformers 3.x): loaded from jsdelivr; a failure falls back to the CPU engine.
//  3. Model weights (~40 MB): downloaded from huggingface.co on first use and kept in the browser Cache Storage
//     ("transformers-cache"), so later runs work offline for as long as Android keeps the app's storage.
const SPEECH_ENGINE = Object.freeze({
  bundledModule: './vendor/transformers/transformers.min.js',
  bundledRuntime: './vendor/transformers/',
  cpuRemote: 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js',
  gpuRemote: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js',
  modelCache: 'transformers-cache'
});
const speechModules = new Map();
const absoluteUrl = relative => { try { return new URL(relative, document.baseURI).href; } catch (_) { return relative; } };
let speechRetryDelayMs = 1500; // tests set this to 0
const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}
async function loadSpeechEngineModule(useWebGPU) {
  const key = useWebGPU ? 'gpu' : 'cpu';
  if (speechModules.has(key)) return speechModules.get(key);
  const sources = useWebGPU
    ? [{ url: SPEECH_ENGINE.gpuRemote, bundled: false, label: 'online GPU library' }]
    : [{ url: absoluteUrl(SPEECH_ENGINE.bundledModule), bundled: true, label: 'built-in library' },
       { url: SPEECH_ENGINE.cpuRemote, bundled: false, label: 'online library' }];
  let lastError = null;
  for (const source of sources) {
    for (let attempt = 1; attempt <= (source.bundled ? 1 : 3); attempt++) {
      if (captionCancelRequested) throw abortCaption();
      updateBusy('Loading speech engine…', `Loading the ${source.label}${attempt > 1 ? ` (attempt ${attempt})` : ''}. This is the code only, not the speech model.`, null, 'Speech engine');
      try {
        // A failed import() is remembered by the browser for that exact URL, so retries use a fresh one.
        const url = attempt > 1 ? `${source.url}${source.url.includes('?') ? '&' : '?'}retry=${attempt}` : source.url;
        const loaded = await withTimeout(import(url), source.bundled ? 15000 : 25000, `Timed out loading the ${source.label}.`);
        const api = loaded && typeof loaded.pipeline === 'function' ? loaded : (loaded && loaded.default);
        if (!api || typeof api.pipeline !== 'function' || !api.env) throw new Error('The speech library loaded but is not the expected version.');
        if (source.bundled && await bundledRuntimeAvailable()) {
          // Without this the library fetches its WASM runtime from the internet even though the code is local.
          api.env.backends.onnx.wasm.wasmPaths = absoluteUrl(SPEECH_ENGINE.bundledRuntime);
        }
        if (api.env.backends && api.env.backends.onnx && api.env.backends.onnx.wasm) api.env.backends.onnx.wasm.numThreads = 1;
        speechModules.set(key, api);
        return api;
      } catch (error) {
        lastError = error;
        if (captionCancelRequested) throw abortCaption();
        if (attempt < 3 && !source.bundled) await sleep(500 * attempt);
      }
    }
  }
  const detail = lastError && lastError.message ? lastError.message : String(lastError);
  throw new Error(isOnline()
    ? `The speech engine could not be loaded (${detail}). Check the connection and try again.`
    : 'The speech engine could not be loaded and this device looks offline. Reconnect and try again.');
}
// The runtime files are fetched into vendor/transformers/ by scripts/fetch_speech_engine.sh during the build. A source
// checkout without them still works (online) because the library then falls back to its own default download location.
async function bundledRuntimeAvailable() {
  const controller = new AbortController();
  try {
    const response = await withTimeout(fetch(absoluteUrl(SPEECH_ENGINE.bundledRuntime) + 'ort-wasm-simd.wasm', { signal: controller.signal }), 4000, 'runtime probe timed out');
    return response.ok;
  } catch (_) {
    return false;
  } finally {
    controller.abort(); // only the headers are needed, never the 10 MB body
  }
}
const looksLikeCorruptModelCache = error => /protobuf|parsing failed|unexpected end|unexpected token|invalid (model|json)|corrupt|deserialize|not a valid/i.test(String(error && error.message || error));
async function clearSpeechModelCache() {
  try { if (window.caches) await caches.delete(SPEECH_ENGINE.modelCache); } catch (_) { /* nothing to clear */ }
}
async function createSpeechPipeline(useWebGPU) {
  const { pipeline, env } = await loadSpeechEngineModule(useWebGPU);
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  // The model is several files; report one overall percentage instead of one that jumps back for each file.
  const files = new Map();
  let shown = 0; // never move backwards when another model file starts reporting
  const progress_callback = p => {
    if (!p || p.status !== 'progress' || !p.file) return;
    files.set(p.file, { loaded: Number(p.loaded) || 0, total: Number(p.total) || 0 });
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    const raw = total > 0 ? Math.min(100, loaded / total * 100) : (Number.isFinite(p.progress) ? p.progress : null);
    const percent = raw === null ? null : (shown = Math.max(shown, raw));
    const detail = `Downloading speech model… ${Math.round(percent || 0)}% (${(loaded / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB)`;
    say(detail);
    updateBusy('Downloading speech model…', detail, percent, 'Model download');
  };
  const options = { progress_callback };
  if (useWebGPU) {
    options.device = 'webgpu';
    options.dtype = { encoder_model: 'fp32', decoder_model_merged: 'q4' };
  }
  const modelId = useWebGPU ? 'onnx-community/whisper-tiny' : 'Xenova/whisper-tiny';
  let model = null, lastError = null, clearedCache = false;
  for (let attempt = 1; attempt <= 3 && !model; attempt++) {
    if (captionCancelRequested) throw abortCaption();
    updateBusy('Downloading speech model…', attempt === 1
      ? 'The speech model (about 40 MB) downloads once and is then kept on this device.'
      : `Retrying the speech model download (attempt ${attempt} of 3).`, null, 'Model download');
    try {
      model = await pipeline('automatic-speech-recognition', modelId, options);
    } catch (error) {
      lastError = error;
      if (captionCancelRequested) throw abortCaption();
      if (!clearedCache && looksLikeCorruptModelCache(error)) { // a damaged cached file would fail forever
        clearedCache = true; files.clear(); await clearSpeechModelCache(); continue;
      }
      if (attempt < 3) await sleep(speechRetryDelayMs * attempt);
    }
  }
  if (!model) {
    const detail = lastError && lastError.message ? lastError.message : String(lastError);
    throw new Error(!isOnline()
      ? 'The speech model has not been downloaded yet and this device is offline. Connect once to download it (about 40 MB); after that captions work offline.'
      : `The speech model could not be downloaded (${detail}). Check the connection and try again. Files already downloaded are kept.`);
  }
  asrBackend = useWebGPU ? 'webgpu' : 'wasm';
  return model;
}
function normalizeQuietCaptionAudio(pcm) {
  if (!pcm || !pcm.length) return pcm;
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  // Avoid boosting near-silence/noise or changing already healthy levels.
  if (!(peak > 0.006 && peak < 0.5)) return pcm;
  const gain = Math.min(12, 0.8 / peak);
  const normalized = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) normalized[i] = pcm[i] * gain;
  return normalized;
}
async function pcmOf(src, audioContext, decodeCache, onDecoded = () => {}) {
  // Reuse at most one decoded source buffer. This avoids decoding the same source twice
  // when a video and its audio track reference the same media without retaining many hours of PCM.
  await loadMedia(src.m);
  if (!files[src.m]) throw new Error('The selected audio source is missing.');
  let cached = decodeCache.get(src.m), buf;
  if (!cached) {
    decodeCache.clear();
    cached = audioContext.decodeAudioData(await files[src.m].arrayBuffer());
    decodeCache.set(src.m, cached);
  }
  try {
    buf = await cached;
    decodeCache.set(src.m, buf);
  } catch (error) {
    if (decodeCache.get(src.m) === cached) decodeCache.delete(src.m);
    throw error;
  }
  const inputRate = buf.sampleRate || audioContext.sampleRate || CAPTION_SAMPLE_RATE;
  onDecoded({ sampleRate: inputRate, channels: buf.numberOfChannels || 1, sourceDurationSeconds: buf.duration || (buf.length / inputRate) });
  const start = Math.max(0, Math.min(buf.length, Math.floor(src.in * inputRate)));
  const end = Math.max(start, Math.min(buf.length, Math.ceil(src.out * inputRate)));
  if (end - start < Math.floor(inputRate * 0.1)) throw new Error('The selected audio range is too short.');
  const count = end - start;
  let mono;
  if (buf.numberOfChannels === 1) {
    mono = buf.getChannelData(0).subarray(start, end);
  } else {
    mono = new Float32Array(count);
    for (let channel = 0; channel < buf.numberOfChannels; channel++) {
      const data = buf.getChannelData(channel);
      for (let i = 0, source = start; source < end; i++, source++) mono[i] += data[source] / buf.numberOfChannels;
    }
  }
  if (inputRate === CAPTION_SAMPLE_RATE) return normalizeQuietCaptionAudio(mono);
  const Core = window.MediaYCore;
  if (!Core || typeof Core.resamplePcm !== 'function') throw new Error('MediaY audio resampler did not load.');
  return normalizeQuietCaptionAudio(Core.resamplePcm(mono, inputRate, CAPTION_SAMPLE_RATE));
}
function hasAudibleSignal(pcm) {
  if (!pcm || !pcm.length) return false;
  // Sparse RMS/peak sampling is enough to skip genuinely silent tracks without scanning every sample.
  const stride = Math.max(1, Math.floor(pcm.length / 200000));
  let sum = 0, peak = 0, count = 0;
  for (let i = 0; i < pcm.length; i += stride) {
    const value = pcm[i], magnitude = Math.abs(value);
    sum += value * value; peak = Math.max(peak, magnitude); count++;
  }
  const rms = Math.sqrt(sum / Math.max(1, count));
  return !(rms < 0.0012 && peak < 0.006);
}
function captionPcmStats(pcm) {
  if (!pcm || !pcm.length) return { durationSeconds: 0, rms: 0, peak: 0 };
  const stride = Math.max(1, Math.floor(pcm.length / 200000));
  let sum = 0, peak = 0, count = 0;
  for (let i = 0; i < pcm.length; i += stride) {
    const value = pcm[i], magnitude = Math.abs(value);
    sum += value * value;
    peak = Math.max(peak, magnitude);
    count++;
  }
  return { durationSeconds: Number((pcm.length / CAPTION_SAMPLE_RATE).toFixed(3)), rms: Number(Math.sqrt(sum / Math.max(1, count)).toFixed(6)), peak: Number(peak.toFixed(6)) };
}
let asrWordTimestamps = false; // Whisper tiny's bundled DTW word alignment is unreliable; use native segment timestamps
async function transcribeChunk(audioChunk) {
  const lang = $('capLang').value;
  const options = {
    chunk_length_s: CAPTION_CHUNK_SECONDS,
    stride_length_s: 5,
    ...(lang ? { language: lang } : {}),
    ...($('capTr').checked
      ? (lang ? { task: 'translate' } : { forced_decoder_ids: [[1, null], [2, 50358]] })
      : {})
  };
  if (asrWordTimestamps) {
    try { return { result: await asr(audioChunk, { ...options, return_timestamps: 'word' }), wordMode: true }; }
    catch (error) {
      if (error && error.name === 'AbortError') throw error;
      // Only a model that cannot produce word times is downgraded; any other failure keeps its own recovery path.
      if (!/cross.?attention|extract timestamps|output_attentions|alignment/i.test(String(error && error.message || error))) throw error;
      asrWordTimestamps = false;
    }
  }
  return { result: await asr(audioChunk, { ...options, return_timestamps: true }), wordMode: false };
}
async function captionFrom(pcm, src, onProgress = () => {}, diagnostics = null) {
  // The speech model supplies the words; the audio itself supplies the timing (see mediay-core.js).
  const Core = window.MediaYCore;
  if (!Core) throw new Error('mediay-core.js did not load. Reload MediaY.');
  const duration = pcm.length / CAPTION_SAMPLE_RATE;
  const activity = Core.analyzeSpeechActivity(pcm, CAPTION_SAMPLE_RATE);
  const plan = Core.planCaptionChunks(duration, activity, { maxSeconds: CAPTION_CHUNK_SECONDS });
  if (diagnostics) Object.assign(diagnostics, {
    speechThresholdDb: Number(activity.thresholdDb.toFixed(2)),
    speechDynamicRangeDb: Number((activity.dynamicRangeDb || 0).toFixed(2)),
    speechVoicedRatio: Number((activity.voicedRatio || 0).toFixed(4)),
    speechIntervals: activity.intervals.length,
    speechAnalysisReliable: !!activity.reliable,
    plannedChunks: plan.length,
    chunksSentToWhisper: 0,
    rawWhisperSegments: 0
  });
  const mixedSegments = [];
  let lastCaptionStart = 0;
  for (let chunkIndex = 0; chunkIndex < plan.length; chunkIndex++) {
    if (captionCancelRequested) throw abortCaption();
    const [from, to] = plan[chunkIndex];
    const audioChunk = pcm.subarray(Math.round(from * CAPTION_SAMPLE_RATE), Math.min(pcm.length, Math.round(to * CAPTION_SAMPLE_RATE)));
    const progress = { chunkIndex, chunkCount: plan.length, percent: (chunkIndex + 1) / plan.length };
    // Whisper invents text ("Thank you.") on silence, so never feed it a window with no detected speech.
    if (!audioChunk.length || !Core.hasSpeech(activity, from, to)) { onProgress(progress); continue; }
    const { result, wordMode } = await transcribeChunk(audioChunk);
    if (diagnostics) {
      diagnostics.chunksSentToWhisper++;
      diagnostics.rawWhisperSegments += (result.chunks || []).length;
    }
    if (captionCancelRequested) throw abortCaption();
    const chunkDuration = audioChunk.length / CAPTION_SAMPLE_RATE;
    for (const chunk of result.chunks || []) {
      const text = String(chunk.text || '').trim();
      if (!text || /^[\[(].*[\])]$/.test(text)) continue;
      const stamp = Array.isArray(chunk.timestamp) ? chunk.timestamp : [];
      const rawStart = Number.isFinite(stamp[0]) ? Math.max(0, Math.min(chunkDuration, stamp[0])) : 0;
      const s0 = Math.max(rawStart, lastCaptionStart - from);
      const e0 = Number.isFinite(stamp[1]) ? Math.max(s0, Math.min(chunkDuration, stamp[1])) : NaN;
      const entry = { text, start: from + s0, end: Number.isFinite(e0) ? from + e0 : NaN };
      lastCaptionStart = entry.start;
      mixedSegments.push({ ...entry, word: wordMode && text.split(/\s+/).length === 1 });
    }
    onProgress(progress);
  }
  if (captionCancelRequested) throw abortCaption();
  const segments = Core.mergeCaptionSegments(mixedSegments);
  const speed = Number.isFinite(src.sp) && src.sp > 0 ? src.sp : 1;
  const timelineStart = Number.isFinite(src.start) ? src.start : 0;
  const lines = Core.buildCaptionLines(segments, activity, duration);
  if (diagnostics) diagnostics.finalCaptionLines = lines.length;
  return lines.map((line, index) => ({
    id: uid(),
    layer: S.nextLayer + index,
    type: 'text',
    caption: true, // appears instantly in the preview, exactly like the exported video
    text: line.text.replace(/\s+([,.;:!?%…])/g, '$1').replace(/([([{])\s+/g, '$1').trim(),
    style: txtStyle,
    start: Core.sourceToTimeline(line.start, timelineStart, speed),
    dur: Math.max(MIN_TIMELINE_FRAME, (line.end - line.start) / speed),
    top: RATIOS[S.ratio][1] * 0.72
  }));
}
// Large caption sources are decoded and transcribed one bounded window at a time.
// 16 kHz mono float32 PCM uses about 38.4 MB per 10-minute window.
const CAPTION_STREAM_THRESHOLD_BYTES = 96 * 1024 * 1024;
const CAPTION_STREAM_WINDOW_SECONDS = 10 * 60;
const CAPTION_STREAM_OVERLAP_SECONDS = 1.5;
const CAPTION_STREAM_MAX_SECONDS = 4 * 60 * 60;
function shouldStreamCaptionSource(file, src) {
  const selectedDuration = Math.max(0, Number(src && src.out) - Number(src && src.in));
  // A short trim can still point into a very large original source. Keep the
  // decode path bounded when either the selected range or source media is long.
  const sourceDuration = Math.max(0, Number(src && src.src) || 0);
  return !!file && (file.size > CAPTION_STREAM_THRESHOLD_BYTES ||
    selectedDuration > CAPTION_STREAM_WINDOW_SECONDS || sourceDuration > CAPTION_STREAM_WINDOW_SECONDS);
}
function rawCaptionBytesToPcm(raw) {
  if (!raw || raw.byteLength < 4 || raw.byteLength % 4 !== 0) return null;
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
}
async function* streamCaptionPcmWindows(src, file, onProgress = () => {}) {
  const clipStart = Math.max(0, Number(src.in) || 0);
  const clipLength = Math.max(0, (Number(src.out) || 0) - clipStart);
  if (!file || !file.size) throw new Error('The selected audio source is missing or empty.');
  if (clipLength < 0.1) throw new Error('The selected audio range is too short.');
  if (clipLength > CAPTION_STREAM_MAX_SECONDS) {
    throw new Error('This captioning pass is limited to 4 hours of selected audio. Split the clip into shorter sections and try again.');
  }
  if (!window.FFmpegWASM || typeof FFmpegWASM.FFmpeg !== 'function') {
    throw new Error('The local FFmpeg audio decoder is unavailable. Reload MediaY and try again.');
  }
  if (captionCancelRequested) throw abortCaption();
  const engine = await getFFmpeg();
  const token = uid();
  const ext = ((file.name || 'media.mp4').split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
  const inputName = `caption_source_${token}.${ext}`;
  const outputName = `caption_window_${token}.f32`;
  const mountDir = `/caption_source_${token}`;
  let mounted = false, directoryCreated = false;
  const Core = window.MediaYCore;
  if (!Core || typeof Core.planCaptionStreamWindows !== 'function') throw new Error('The caption window planner is unavailable. Reload MediaY.');
  const windows = Core.planCaptionStreamWindows(clipLength, CAPTION_STREAM_WINDOW_SECONDS, CAPTION_STREAM_OVERLAP_SECONDS);
  const windowCount = windows.length;
  try {
    if (typeof engine.createDir !== 'function' || typeof engine.mount !== 'function' || typeof engine.unmount !== 'function') {
      throw new Error('This FFmpeg build does not support safe file-backed audio streaming. Update the app before captioning this large file.');
    }
    await engine.createDir(mountDir);
    directoryCreated = true;
    const workerFs = (FFmpegWASM.FFFSType && FFmpegWASM.FFFSType.WORKERFS) || 'WORKERFS';
    await engine.mount(workerFs, { blobs: [{ name: inputName, data: file }] }, mountDir);
    mounted = true;
    const inputPath = `${mountDir}/${inputName}`;
    for (let index = 0; index < windowCount; index++) {
      if (captionCancelRequested) throw abortCaption();
      const planWindow = windows[index];
      const { offsetSeconds, durationSeconds } = planWindow;
      onProgress({ index, count: windowCount, percent: index / windowCount, stage: 'decode' });
      const code = await engine.exec([
        '-ss', String(clipStart + offsetSeconds), '-t', String(durationSeconds), '-i', inputPath,
        '-vn', '-ac', '1', '-ar', String(CAPTION_SAMPLE_RATE), '-f', 'f32le', outputName
      ]);
      if (code !== 0) throw new Error(`FFmpeg could not decode audio window ${index + 1} of ${windowCount}.`);
      let raw = null, pcm = null;
      try {
        raw = await engine.readFile(outputName);
        pcm = rawCaptionBytesToPcm(raw);
      } finally {
        try { await engine.deleteFile(outputName); } catch (_) {}
        raw = null;
      }
      if (!pcm || !pcm.length) throw new Error(`Audio window ${index + 1} of ${windowCount} decoded to no samples.`);
      const normalizedPcm = normalizeQuietCaptionAudio(pcm);
      pcm = null;
      yield { pcm: normalizedPcm, ...planWindow };
    }
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    if (/memory|out of memory|oom/i.test(String(error && error.message || error))) disposeFFmpeg();
    throw error;
  } finally {
    try { if (mounted) await engine.unmount(mountDir); } catch (_) {}
    try { if (directoryCreated && typeof engine.deleteDir === 'function') await engine.deleteDir(mountDir); } catch (_) {}
    try { await engine.deleteFile(outputName); } catch (_) {}
  }
}
async function transcribeCaptionPcmWithFallback(pcm, source, onChunk, diagnostics) {
  try {
    return await captionFrom(pcm, source, onChunk, diagnostics);
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    if (asrBackend !== 'webgpu') throw error;
    asr = null;
    updateBusy('Switching to compatible captions…', 'GPU inference failed on this device. Retrying this audio window with the CPU engine.', null, 'Compatibility');
    asr = await createSpeechPipeline(false);
    return await captionFrom(pcm, source, onChunk, diagnostics);
  }
}
async function commitCaptionDrafts(drafts) {
  if (!drafts.length) return 0;
  await ensureFontsReady();
  const originalNextLayer = S.nextLayer;
  const staged = drafts.map((draft, index) => ({ ...draft, layer: originalNextLayer + index }));
  const built = [];
  try {
    for (const overlay of staged) {
      if (captionCancelRequested) throw abortCaption();
      const object = await buildObject(overlay, { restackAfter: false });
      if (!object) throw new Error('A generated caption could not be added to the preview.');
      built.push(overlay.id);
    }
    if (captionCancelRequested) throw abortCaption();
    S.overlays.push(...staged);
    S.nextLayer = originalNextLayer + staged.length;

    // Persist immediately instead of relying only on the ordinary 800 ms debounce.
    // Confirm that the restart checkpoint really contains the new caption IDs/timings.
    await saveProject();
    if (captionCancelRequested) throw abortCaption();
    const checkpoint = await db.projects.get('current');
    const persisted = checkpoint && checkpoint.state ? normalizeState(checkpoint.state) : null;
    const verified = !!persisted && staged.every(draft => persisted.overlays.some(saved =>
      saved.id === draft.id &&
      Number.isFinite(saved.start) &&
      Number.isFinite(saved.dur) &&
      Math.abs(saved.start - draft.start) < 0.001 &&
      Math.abs(saved.dur - draft.dur) < 0.001
    ));
    if (!verified) throw new Error('Captions were generated but could not be verified in the saved project. Check device storage and try again.');

    restack();
    commit();
    return staged.length;
  } catch (error) {
    for (const id of built) {
      const object = objOf(id);
      if (object) disposeOverlayObject(object, staged.find(overlay => overlay.id === id));
    }
    canvas.requestRenderAll();
    S.overlays = S.overlays.filter(overlay => !staged.some(draft => draft.id === overlay.id));
    S.nextLayer = originalNextLayer;
    await saveProject().catch(() => {});
    throw error;
  }
}
function requestExportCancel() {
  if (!exportInProgress || exportCancelRequested) return;
  exportCancelRequested = true;
  const button = $('busyCancel');
  if (button) {
    button.disabled = true;
    button.textContent = 'Cancelling export…';
  }
  say('Cancelling export. MediaY is stopping the encoder and removing unfinished output.');
  // Terminating FFmpeg rejects its active command and releases the worker heap.
  // The WebCodecs path also receives isCancelled and closes its decoder/encoder between frames.
  if (ff) disposeFFmpeg();
}
function requestCaptionCancel() {
  if (!captionRunning || captionCancelRequested) return;
  captionCancelRequested = true;
  for (const button of [$('capCancelBtn'), $('busyCancel')]) {
    if (!button) continue;
    button.disabled = true;
    button.textContent = 'Cancellation requested…';
  }
  say('Cancellation requested. MediaY will finish the current model/audio operation and discard all generated captions.');
}
$('capCancelBtn').onclick = requestCaptionCancel;
$('busyCancel').onclick = () => exportInProgress ? requestExportCancel() : requestCaptionCancel();
$('capGo').onclick = async () => {
  const audioSelection = sel && sel.lane === 'audio' ? S.audio.find(x => x.id === sel.id) : null;
  const explicitVideo = !audioSelection && sel && sel.lane === 'main' ? S.main.find(x => x.id === sel.id) : null;
  const audioCandidate = item => ({ kind: 'audio', m: item.mediaId, in: item.in, out: item.out, src: item.src, start: item.start, sp: 1, label: item.name || 'audio track' });
  const videoCandidate = clip => ({ kind: 'video', m: clip.mediaId, in: clip.in, out: clip.out, src: clip.src, start: startOf(clip, 'main'), sp: clip.speed || 1, rev: !!clip.rev, label: clip.name || 'video clip' });
  // An explicit selection is authoritative: never silently switch to another lane.
  // With no selection, try the main video first and use separate audio tracks only as fallback.
  const candidates = audioSelection ? [audioCandidate(audioSelection)] :
    explicitVideo ? [videoCandidate(explicitVideo)] :
    [...S.main.map(videoCandidate), ...S.audio.map(audioCandidate)];
  if (!candidates.length) return say('Import a video or add audio first.');
  if (captionRunning) return;
  if (exportInProgress) return say('An export is running. Wait for it to finish, then generate captions.');
  const captionMetric = createMediaYMetric('Automatic captions', {
    selectedSources: candidates.length, language: $('capLang').value || 'auto',
    translateToEnglish: $('capTr').checked, modelWarm: !!asr
  });
  let captionOutcome = 'failed';
  const btn = $('capGo'), cancelBtn = $('capCancelBtn');
  btn.disabled = true;
  cancelBtn.hidden = false;
  cancelBtn.disabled = false;
  cancelBtn.textContent = 'Request cancellation';
  const busyCancelButton = $('busyCancel');
  busyCancelButton.hidden = false;
  busyCancelButton.disabled = false;
  busyCancelButton.textContent = 'Request cancellation';
  captionRunning = true;
  captionCancelRequested = false;
  await Background.begin(); // keeps captions running if the app goes to the background
  let captionFailed = false, audioContext = null;
  const decodeCache = new Map();
  captionMetric.stage('Load speech model and runtime');
  updateBusy('Preparing captions…', 'Loading the speech model and preparing audio.', 1, 'Captions');
  try {
    if (!asr) {
      let gpuReady = false;
      if (navigator.gpu && typeof navigator.gpu.requestAdapter === 'function') {
        try {
          updateBusy('Starting GPU captions…', 'Checking whether browser GPU acceleration is available.', null, 'GPU acceleration');
          asr = await createSpeechPipeline(true);
          gpuReady = true;
        } catch (_) {
          asr = null;
          updateBusy('Switching to compatibility mode…', 'GPU acceleration is unavailable. Using the compatible speech engine instead.', null, 'Compatibility');
        }
      }
      if (!asr) {
        say('Loading speech model (about 40 MB the first time)…');
        updateBusy('Loading speech model…', 'The first model download is cached by the browser when supported.', null, 'Model download');
        asr = await createSpeechPipeline(false);
      } else if (gpuReady) {
        updateBusy('Speech model ready', 'Using browser GPU acceleration for transcription.', null, 'GPU accelerated');
      }
    }
    if (captionCancelRequested) throw abortCaption();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('This browser does not support audio decoding for captions.');
    try { audioContext = new AudioContextClass({ sampleRate: CAPTION_SAMPLE_RATE }); }
    catch (_) { audioContext = new AudioContextClass(); }
    let chosenDrafts = [], usedLabels = [], skippedReversed = 0;
    const sourceDiagnostics = [];
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const source = candidates[candidateIndex];
      if (captionCancelRequested) throw abortCaption();
      // Audio tracks are only a fallback when the video clips themselves contain no speech.
      if (source.kind === 'audio' && chosenDrafts.length) {
        sourceDiagnostics.push({ kind: source.kind, label: source.label, decode: 'not attempted', transcription: 'skipped: video source already produced captions' });
        break;
      }
      if (source.rev) { skippedReversed++; continue; } // reversed audio cannot be transcribed
      say(`Preparing ${source.label} for captions…`);
      captionMetric.stage('Decode and resample audio');
      updateBusy('Decoding audio…', `Preparing the audio from ${source.label}. Large source files can take time to decode.`, 10 + candidateIndex / candidates.length * 5, 'Audio decode');
      const sourceDiagnostic = {
        kind: source.kind, label: source.label,
        selectedRangeSeconds: Number(Math.max(0, source.out - source.in).toFixed(3)),
        decode: 'pending', transcription: 'not attempted'
      };
      sourceDiagnostics.push(sourceDiagnostic);
      let drafts = [];
      const candidateBase = 20 + candidateIndex / candidates.length * 70;
      const candidateSpan = 70 / candidates.length;
      const clipLength = Math.max(0, Number(source.out) - Number(source.in));
      const onChunk = p => {
        const windowLabel = p.windowCount > 1 ? `, window ${(p.windowIndex || 0) + 1} of ${p.windowCount}` : '';
        const detail = `${source.label}: audio chunk ${p.chunkIndex + 1} of ${p.chunkCount}${windowLabel}. You can cancel between chunks.`;
        say(detail);
        const percent = p.windowCount > 1 ? ((p.windowIndex + p.percent) / p.windowCount) : p.percent;
        updateBusy('Transcribing speech…', detail, candidateBase + candidateSpan * percent, 'Transcription');
      };
      try {
        await loadMedia(source.m);
        const sourceFile = files[source.m];
        if (!sourceFile) throw new Error('The selected audio source is missing.');
        if (shouldStreamCaptionSource(sourceFile, source)) {
          sourceDiagnostic.decodeMode = 'ffmpeg-windowed';
          sourceDiagnostic.windowSeconds = CAPTION_STREAM_WINDOW_SECONDS;
          sourceDiagnostic.windowOverlapSeconds = CAPTION_STREAM_OVERLAP_SECONDS;
          sourceDiagnostic.windowCount = Math.ceil(clipLength / CAPTION_STREAM_WINDOW_SECONDS);
          sourceDiagnostic.durationSeconds = Number(clipLength.toFixed(3));
          let audibleWindows = 0, totalSamples = 0, totalPlanned = 0, totalSent = 0, totalRaw = 0, totalLines = 0;
          for await (const windowData of streamCaptionPcmWindows(source, sourceFile, progress => {
            const detail = `${source.label}: decoding audio window ${progress.index + 1} of ${progress.count}.`;
            say(detail);
            updateBusy('Decoding audio…', detail, 10 + (candidateIndex / candidates.length) * 5 + (progress.percent * 5 / candidates.length), 'Audio decode');
          })) {
            if (captionCancelRequested) throw abortCaption();
            sourceDiagnostic.decode = 'success';
            totalSamples += windowData.pcm.length;
            if (!hasAudibleSignal(windowData.pcm)) { windowData.pcm = null; continue; }
            audibleWindows++;
            const speed = Number.isFinite(source.sp) && source.sp > 0 ? source.sp : 1;
            const windowSource = { ...source, start: (Number(source.start) || 0) + windowData.offsetSeconds / speed };
            const windowDiagnostics = {};
            let windowDrafts;
            try {
              windowDrafts = await transcribeCaptionPcmWithFallback(windowData.pcm, windowSource, p => onChunk({
                ...p, windowIndex: windowData.index, windowCount: windowData.count
              }), windowDiagnostics);
            } finally {
              windowData.pcm = null;
            }
            const timelineStart = Number.isFinite(source.start) ? source.start : 0;
            const windowSpeed = Number.isFinite(source.sp) && source.sp > 0 ? source.sp : 1;
            const ownedDrafts = windowDrafts.filter(draft => {
              const sourcePosition = (draft.start - timelineStart) * windowSpeed;
              return sourcePosition >= windowData.ownershipStartSeconds - 0.001 &&
                sourcePosition < windowData.ownershipEndSeconds - 0.001;
            });
            drafts.push(...ownedDrafts);
            totalPlanned += Number(windowDiagnostics.plannedChunks) || 0;
            totalSent += Number(windowDiagnostics.chunksSentToWhisper) || 0;
            totalRaw += Number(windowDiagnostics.rawWhisperSegments) || 0;
            totalLines += Number(windowDiagnostics.finalCaptionLines) || 0;
            Object.assign(sourceDiagnostic, {
              speechThresholdDb: windowDiagnostics.speechThresholdDb,
              speechDynamicRangeDb: windowDiagnostics.speechDynamicRangeDb,
              speechVoicedRatio: windowDiagnostics.speechVoicedRatio,
              speechIntervals: (Number(sourceDiagnostic.speechIntervals) || 0) + (Number(windowDiagnostics.speechIntervals) || 0),
              speechAnalysisReliable: !!(sourceDiagnostic.speechAnalysisReliable || windowDiagnostics.speechAnalysisReliable)
            });
          }
          sourceDiagnostic.decode = 'success';
          sourceDiagnostic.decodeComplete = true;
          sourceDiagnostic.sampleRate = CAPTION_SAMPLE_RATE;
          sourceDiagnostic.channels = 1;
          sourceDiagnostic.rms = null;
          sourceDiagnostic.peak = null;
          sourceDiagnostic.durationSeconds = Number(clipLength.toFixed(3));
          sourceDiagnostic.decodedAudioSeconds = Number((totalSamples / CAPTION_SAMPLE_RATE).toFixed(3));
          sourceDiagnostic.plannedChunks = totalPlanned;
          sourceDiagnostic.chunksSentToWhisper = totalSent;
          sourceDiagnostic.rawWhisperSegments = totalRaw;
          sourceDiagnostic.finalCaptionLines = totalLines;
          sourceDiagnostic.audibleWindows = audibleWindows;
          sourceDiagnostic.transcription = drafts.length ? 'captions generated' : 'no caption lines';
          if (!audibleWindows) sourceDiagnostic.transcription = 'skipped: no audible signal';
        } else {
          let pcm;
          try {
            pcm = await pcmOf(source, audioContext, decodeCache, info => Object.assign(sourceDiagnostic, info));
            sourceDiagnostic.decode = 'success';
            Object.assign(sourceDiagnostic, captionPcmStats(pcm));
          } catch (decodeError) {
            sourceDiagnostic.decode = 'failed';
            sourceDiagnostic.decodeError = String(decodeError && decodeError.message || decodeError && decodeError.name || 'Error');
            continue;
          }
          if (!hasAudibleSignal(pcm)) {
            sourceDiagnostic.transcription = 'skipped: no audible signal';
            updateBusy('Skipping silent audio…', `No useful audio signal was detected in ${source.label}.`, 15 + (candidateIndex + 1) / candidates.length * 5, 'Audio check');
            continue;
          }
          captionMetric.stage('Whisper inference');
          drafts = await transcribeCaptionPcmWithFallback(pcm, source, onChunk, sourceDiagnostic);
          sourceDiagnostic.transcription = drafts.length ? 'captions generated' : 'no caption lines';
          pcm = null;
        }
      } catch (decodeOrInferenceError) {
        if (decodeOrInferenceError && decodeOrInferenceError.name === 'AbortError') throw decodeOrInferenceError;
        sourceDiagnostic.decode = sourceDiagnostic.decodeMode === 'ffmpeg-windowed' && !sourceDiagnostic.decodeComplete
          ? 'failed' : (sourceDiagnostic.decode === 'success' ? 'success' : 'failed');
        sourceDiagnostic.decodeError = String(decodeOrInferenceError && decodeOrInferenceError.message || decodeOrInferenceError || 'Error');
        sourceDiagnostic.transcription = 'failed';
        continue;
      }
      if (drafts.length) { chosenDrafts.push(...drafts); usedLabels.push(source.label); if (source.kind === 'audio') break; }
    }
    captionMetric.note('sourceDiagnostics', sourceDiagnostics);
    captionMetric.note('usedCaptionSources', usedLabels);
    const used = usedLabels.length > 1 ? `${usedLabels.length} clips` : (usedLabels[0] || '');
    if (captionCancelRequested) throw abortCaption();
    if (chosenDrafts.length) {
      updateBusy('Adding captions…', `Adding ${chosenDrafts.length} captions to the timeline.`, 95, 'Finishing captions');
      captionMetric.stage('Create caption overlays and commit');
      const count = await commitCaptionDrafts(chosenDrafts);
      captionOutcome = 'complete';
      refresh(t);
      closeSheet();
      // Does by itself what closing and reopening the app and project used to do.
      const refreshed = await reopenProjectInPlace('captions');
      say(`Added ${count} captions from ${used}.` + (refreshed.ok ? ' Project refreshed automatically.' : '') + ' Tap a caption to restyle or move it.');
    } else {
      captionOutcome = 'no speech detected';
      say(skippedReversed ? 'Captions cannot be generated for a reversed clip.' : (S.audio.length || audioSelection ? 'No speech was detected in the selected media.' : 'No audible speech was detected. Add or record audio, then try again.'));
    }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      captionOutcome = 'cancelled';
      say('Caption generation cancelled. No partial captions were added.');
    } else {
      const message = 'Captions failed: ' + (error && error.message || error) + ' (the first run needs internet access).';
      say(message);
      captionOutcome = 'failed';
      captionFailed = true;
      showBusyError('Caption generation failed', message);
    }
  } finally {
    captionMetric.stage('Release audio decode resources');
    decodeCache.clear();
    if (audioContext && audioContext.state !== 'closed') {
      try { await audioContext.close(); } catch (_) {}
    }
    captionRunning = false;
    captionCancelRequested = false;
    await Background.end();
    btn.disabled = false;
    cancelBtn.hidden = true;
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Request cancellation';
    busyCancelButton.hidden = true;
    busyCancelButton.disabled = false;
    busyCancelButton.textContent = 'Request cancellation';
    recentMediaYMetrics.captions = captionMetric.finish(captionOutcome);
    renderMediaYPerformanceReport();
    if (!captionFailed) hideBusy();
  }
};
const TR = [
  ['None', ''],
  ['Fade', 'fade'], ['Fade black', 'fadeblack'], ['Fade white', 'fadewhite'],
  ['Fade fast', 'fadefast'], ['Fade slow', 'fadeslow'], ['Fade grays', 'fadegrays'],
  ['Dissolve', 'dissolve'], ['Pixelate', 'pixelize'], ['Blur', 'hblur'], ['Distance', 'distance'],
  ['Circle crop', 'circlecrop'], ['Rectangle crop', 'rectcrop'], ['Radial', 'radial'],
  ['Circle open', 'circleopen'], ['Circle close', 'circleclose'],
  ['Vertical open', 'vertopen'], ['Vertical close', 'vertclose'],
  ['Horizontal open', 'horzopen'], ['Horizontal close', 'horzclose'],
  ['Smooth left', 'smoothleft'], ['Smooth right', 'smoothright'], ['Smooth up', 'smoothup'], ['Smooth down', 'smoothdown'],
  ['Slide left', 'slideleft'], ['Slide right', 'slideright'], ['Slide up', 'slideup'], ['Slide down', 'slidedown'],
  ['Wipe left', 'wipeleft'], ['Wipe right', 'wiperight'], ['Wipe up', 'wipeup'], ['Wipe down', 'wipedown'],
  ['Wipe top-left', 'wipetl'], ['Wipe top-right', 'wipetr'], ['Wipe bottom-left', 'wipebl'], ['Wipe bottom-right', 'wipebr'],
  ['Diagonal TL', 'diagtl'], ['Diagonal TR', 'diagtr'], ['Diagonal BL', 'diagbl'], ['Diagonal BR', 'diagbr'],
  ['Horizontal slice', 'hlslice'], ['Horizontal reverse slice', 'hrslice'],
  ['Vertical up-slice', 'vuslice'], ['Vertical down-slice', 'vdslice'],
  ['Squeeze horizontal', 'squeezeh'], ['Squeeze vertical', 'squeezev'], ['Zoom in', 'zoomin'],
  ['Wind left', 'hlwind'], ['Wind right', 'hrwind'], ['Wind up', 'vuwind'], ['Wind down', 'vdwind'],
  ['Cover left', 'coverleft'], ['Cover right', 'coverright'], ['Cover up', 'coverup'], ['Cover down', 'coverdown'],
  ['Reveal left', 'revealleft'], ['Reveal right', 'revealright'], ['Reveal up', 'revealup'], ['Reveal down', 'revealdown']
];
function markTr() {
  const c = clipNow();
  [...$('trList').children].forEach((b, i) => b.classList.toggle('on', ((c && c.tr) || '') === TR[i][1]));
  const d = c && c.trDur || 0.5;
  $('trDuration').value = d;
  $('trDurationLabel').textContent = Number(d).toFixed(1) + ' s';
  $('trDuration').disabled = !c || !c.tr;
  const hasPair = !!c && S.main.indexOf(c) > 0;
  $('trPreviewPlay').disabled = !hasPair || !c.tr;
  $('trPreviewStatus').textContent = !hasPair
    ? 'Select the second clip in a sequence of at least two clips.'
    : (!c.tr ? 'Choose a transition above, then preview it here.' : 'Preview the selected effect on your two clips before exporting.');
}

$('trBtn').onclick = () => (sheet.hidden || sheet.dataset.tab !== 'tr' ? openSheet('tr') : closeSheet());
$('trList').innerHTML = TR.map(([n, v]) => `<button data-tr="${v}">${n}</button>`).join('');
$('trList').onclick = e => {
  const b = e.target.closest('[data-tr]'), c = clipNow(); if (!b) return; if (!c) return say('Import a video first.');
  if (S.main.indexOf(c) < 1) return say('A transition goes between two clips. Select the second clip.');
  c.tr = b.dataset.tr || undefined; if (c.tr && !c.trDur) c.trDur = 0.5; commit(); markTr(); say(c.tr ? 'Transition added. Duration can be adjusted below; it is rendered on export.' : 'Transition removed.');
};
$('trDuration').oninput = e => { const c = clipNow(); if (!c || !c.tr) return; c.trDur = Number(e.target.value); $('trDurationLabel').textContent = c.trDur.toFixed(1) + ' s'; };
$('trDuration').onchange = () => { const c = clipNow(); if (c && c.tr) { commit(); say(`Transition duration set to ${c.trDur.toFixed(1)} seconds.`); } };

let transitionPreviewToken = 0;
let transitionPreviewAnimations = [];
let transitionPreviewAbortController = null;
function transitionPreviewAbortError() {
  const error = new Error('Transition preview was superseded.');
  error.name = 'AbortError';
  return error;
}
function assertTransitionPreviewCurrent(token, signal) {
  if (token !== transitionPreviewToken || signal.aborted) throw transitionPreviewAbortError();
}
function resetTransitionPreview() {
  transitionPreviewToken++;
  if (transitionPreviewAbortController) {
    transitionPreviewAbortController.abort();
    transitionPreviewAbortController = null;
  }
  transitionPreviewAnimations.forEach(animation => { try { animation.cancel(); } catch (_) {} });
  transitionPreviewAnimations = [];
  const before = $('trPreviewBefore'), after = $('trPreviewAfter');
  [before, after].forEach(element => {
    element.pause();
    element.style.transform = '';
    element.style.clipPath = '';
    element.style.opacity = '1';
  });
  after.style.opacity = '0';
}
async function setTransitionPreviewVideo(element, clip, sourceTime, token, signal) {
  const url = await loadMedia(clip.mediaId);
  assertTransitionPreviewCurrent(token, signal);
  if (!url) throw new Error('A clip needed for this transition preview is missing.');
  if (element.dataset.mediaId !== clip.mediaId || element.readyState < 1) {
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        element.removeEventListener('loadedmetadata', ready);
        element.removeEventListener('error', failed);
        signal.removeEventListener('abort', aborted);
      };
      const finish = error => {
        if (settled) return;
        settled = true;
        cleanup();
        error ? reject(error) : resolve();
      };
      const ready = () => finish();
      const failed = () => finish(new Error('Could not load a clip for the transition preview.'));
      const aborted = () => finish(transitionPreviewAbortError());
      const timer = setTimeout(() => finish(new Error('Timed out loading a clip for the transition preview. Check that the media is available and try again.')), 10000);
      element.addEventListener('loadedmetadata', ready, { once: true });
      element.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', aborted, { once: true });
      element.dataset.mediaId = clip.mediaId;
      element.src = url;
      element.load();
      if (signal.aborted) aborted();
    });
  }
  assertTransitionPreviewCurrent(token, signal);
  if (!Number.isFinite(element.duration) || element.duration <= 0) {
    throw new Error('The selected clip has no usable duration for transition preview.');
  }
  const target = Math.max(0, Math.min(Number(sourceTime) || 0, Math.max(0, element.duration - 0.04)));
  if (Math.abs((element.currentTime || 0) - target) < 0.03) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      element.removeEventListener('seeked', seeked);
      signal.removeEventListener('abort', aborted);
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? reject(error) : resolve();
    };
    const seeked = () => {
      if (Math.abs(element.currentTime - target) <= 0.12) finish();
    };
    const aborted = () => finish(transitionPreviewAbortError());
    const timer = setTimeout(() => finish(new Error('Timed out seeking media for the transition preview. Try again or re-import the affected clip.')), 2500);
    element.addEventListener('seeked', seeked);
    signal.addEventListener('abort', aborted, { once: true });
    try {
      element.currentTime = target;
      if (signal.aborted) aborted();
    } catch (error) {
      finish(new Error('Could not seek media for the transition preview: ' + (error.message || error)));
    }
  });
  assertTransitionPreviewCurrent(token, signal);
}
async function previewSelectedTransition() {
  const c = clipNow(), index = c ? S.main.indexOf(c) : -1;
  if (!c || index < 1 || !c.tr) {
    say('Select a transition on the second clip, then preview it.');
    return;
  }
  resetTransitionPreview();
  const token = transitionPreviewToken;
  const previewController = new AbortController();
  const previewSignal = previewController.signal;
  transitionPreviewAbortController = previewController;
  const before = $('trPreviewBefore'), after = $('trPreviewAfter');
  const previous = S.main[index - 1];
  const seconds = Math.min(c.trDur || 0.5, dur(previous) * 0.45, dur(c) * 0.45);
  const mode = c.tr;
  $('trPreviewEmpty').hidden = true;
  $('trPreviewStatus').textContent = 'Preparing preview…';
  try {
    await Promise.all([
      setTransitionPreviewVideo(before, previous, Math.max(previous.in, previous.out - seconds * (previous.speed || 1)), token, previewSignal),
      setTransitionPreviewVideo(after, c, c.in, token, previewSignal)
    ]);
    if (token !== transitionPreviewToken) return;
    before.muted = after.muted = true;
    before.style.opacity = '1';
    after.style.opacity = '0';
    await Promise.all([before.play().catch(() => {}), after.play().catch(() => {})]);
    const outgoing = [], incoming = [];
    if (mode === 'slideleft') {
      outgoing.push({ transform: 'translateX(0%)' }, { transform: 'translateX(-18%)' });
      incoming.push({ opacity: 1, transform: 'translateX(100%)' }, { opacity: 1, transform: 'translateX(0%)' });
    } else if (mode === 'slideright') {
      outgoing.push({ transform: 'translateX(0%)' }, { transform: 'translateX(18%)' });
      incoming.push({ opacity: 1, transform: 'translateX(-100%)' }, { opacity: 1, transform: 'translateX(0%)' });
    } else if (mode === 'slideup') {
      outgoing.push({ transform: 'translateY(0%)' }, { transform: 'translateY(-18%)' });
      incoming.push({ opacity: 1, transform: 'translateY(100%)' }, { opacity: 1, transform: 'translateY(0%)' });
    } else if (mode === 'slidedown') {
      outgoing.push({ transform: 'translateY(0%)' }, { transform: 'translateY(18%)' });
      incoming.push({ opacity: 1, transform: 'translateY(-100%)' }, { opacity: 1, transform: 'translateY(0%)' });
    } else if (/^(wipe|reveal|cover)/.test(mode)) {
      const horizontal = /up|down/.test(mode) ? 'vertical' : 'horizontal';
      const reverse = /right|down/.test(mode);
      const startClip = horizontal === 'horizontal'
        ? (reverse ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)')
        : (reverse ? 'inset(100% 0 0 0)' : 'inset(0 0 100% 0)');
      incoming.push({ opacity: 1, clipPath: startClip }, { opacity: 1, clipPath: 'inset(0 0 0 0)' });
    } else if (/circle(open|crop)|radial|rectcrop/.test(mode)) {
      incoming.push({ opacity: 1, clipPath: 'circle(0% at 50% 50%)' }, { opacity: 1, clipPath: 'circle(75% at 50% 50%)' });
    } else {
      // Fade/dissolve/blur/pixel and other filters use a clean cross-fade approximation.
      outgoing.push({ opacity: 1 }, { opacity: 0 });
      incoming.push({ opacity: 0 }, { opacity: 1 });
    }
    if (incoming.length) {
      transitionPreviewAnimations.push(after.animate(incoming, { duration: Math.max(200, seconds * 1000), easing: 'ease-in-out', fill: 'forwards' }));
    }
    if (outgoing.length) {
      transitionPreviewAnimations.push(before.animate(outgoing, { duration: Math.max(200, seconds * 1000), easing: 'ease-in-out', fill: 'forwards' }));
    }
    await Promise.all(transitionPreviewAnimations.map(animation => animation.finished.catch(() => {})));
    if (token !== transitionPreviewToken) return;
    before.pause();
    after.pause();
    before.style.opacity = '0';
    before.style.transform = '';
    before.style.clipPath = '';
    after.style.opacity = '1';
    after.style.transform = '';
    after.style.clipPath = '';
    $('trPreviewStatus').textContent = 'Preview complete. The exported FFmpeg transition is authoritative; complex effects may differ slightly here.';
  } catch (error) {
    if (token === transitionPreviewToken && error.name !== 'AbortError') {
      $('trPreviewStatus').textContent = error.message || 'Could not preview this transition.';
      say(error.message || 'Could not preview this transition.');
    }
  } finally {
    if (transitionPreviewAbortController === previewController) transitionPreviewAbortController = null;
  }
}
$('trPreviewPlay').onclick = previewSelectedTransition;

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
const opt = (id, vals, key) => { $(id).innerHTML = vals.map(v => `<button data-v="${v}" class="${EXP[key] === v ? 'on' : ''}">${key === 'res' ? (v === 1440 ? '2K' : v === 2160 ? '4K' : v + 'p' + (v === 720 ? ' · fast' : v === 1080 ? ' · HD' : '')) : v}</button>`).join(''); $(id).onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; EXP[key] = +b.dataset.v; EXP.fastDraft = false; [...$(id).children].forEach(x => x.classList.toggle('on', x === b)); }; };
opt('resList', [480, 720, 1080, 1440, 2160], 'res'); opt('fpsList', [24, 30, 60], 'fps');
function applyExportPreset(name) {
  const presets = { draft: { res: 480, fps: 24 } };
  const preset = presets[name];
  if (!preset) throw new Error('Unknown export preset: ' + name);
  EXP.res = preset.res; EXP.fps = preset.fps; EXP.fastDraft = name === 'draft';
  [['resList', 'res'], ['fpsList', 'fps']].forEach(([id, key]) => {
    [...$(id).children].forEach(button => button.classList.toggle('on', Number(button.dataset.v) === EXP[key]));
  });
}
$('fastExportBtn').onclick = () => {
  if ($('goExport').disabled) return;
  applyExportPreset('draft');
  say('Fast draft selected (480p / 24 fps).');
  $('goExport').click();
};

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
  if (window.MediaYIcons) MediaYIcons.render(document);
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
