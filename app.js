/* ProjectMedia Y — app.js
   Libraries: Fabric.js (layers), Anime.js (motion), Dexie (storage), FFmpeg.wasm (export, loaded on first Export) */
'use strict';
const $ = id => document.getElementById(id);
const RATIOS = { '9:16': [540, 960], '16:9': [960, 540], '1:1': [720, 720] };
const PX = 24; // timeline pixels per second
const uid = () => Math.random().toString(36).slice(2, 10);
const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const say = m => ($('status').textContent = m);

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
  if (!row) return null;
  files[id] = row.blob; return (urls[id] = URL.createObjectURL(row.blob));
}

/* ---------- State (single source of truth) ---------- */
let S = { ratio: '9:16', main: [], audio: [], overlays: [], nextLayer: 1 };
let sel = null, t = 0, playing = false, undoStack = [], redoStack = [], saveTimer;
const total = () => S.main.reduce((a, c) => a + (c.out - c.in), 0);
const video = $('sourceVideo');

/* ---------- Fabric canvas ---------- */
const canvas = new fabric.Canvas('overlayCanvas', { enableRetinaScaling: false, preserveObjectStacking: true, selection: false });
Object.assign(canvas.wrapperEl.style, { position: 'absolute', inset: '0' });
function sizeCanvas() {
  const [w, h] = RATIOS[S.ratio];
  canvas.setDimensions({ width: w, height: h });
  canvas.setDimensions({ width: '100%', height: '100%' }, { cssOnly: true });
  $('previewFrame').style.aspectRatio = `${w} / ${h}`;
  $('previewFrame').style.width = `min(100%, calc(44vh * ${w / h}))`;
  $('previewFrame').style.maxWidth = 'none';
  $('aspectRatio').value = S.ratio;
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
    obj = new fabric.Textbox(o.text, { width: w * 0.8, fontFamily: 'DM Sans', fontWeight: 700, fontSize: 56, fill: '#fff', stroke: '#000', strokeWidth: 2, textAlign: 'center' });
  } else {
    const url = await loadMedia(o.mediaId); if (!url) return;
    let el;
    if (o.type === 'video') {
      el = document.createElement('video'); el.src = url; el.muted = true; el.playsInline = true; o.el = el;
      await new Promise(r => { el.onloadeddata = r; });
      el.width = el.videoWidth; el.height = el.videoHeight;
      obj = new fabric.Image(el);
    } else {
      el = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = url; });
      obj = new fabric.Image(el);
    }
    if (o.scaleX == null) { o.scaleX = o.scaleY = (w * 0.4) / obj.width; }
  }
  Object.assign(obj, { pmId: o.id, layer: o.layer });
  obj.set({ left: o.left ?? w * 0.1, top: o.top ?? h * 0.1, scaleX: o.scaleX ?? 1, scaleY: o.scaleY ?? 1, angle: o.angle || 0, cornerSize: 22, transparentCorners: false });
  Object.assign(o, { left: obj.left, top: obj.top, scaleX: obj.scaleX, scaleY: obj.scaleY });
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
  drawTimeline(); clearTimeout(saveTimer); saveTimer = setTimeout(saveProject, 800);
}
async function restore(json) { S = JSON.parse(json); sel = null; await rebuildCanvas(); drawTimeline(); }
$('undoBtn').onclick = async () => { if (undoStack.length < 2) return; redoStack.push(undoStack.pop()); await restore(undoStack[undoStack.length - 1]); };
$('redoBtn').onclick = async () => { if (!redoStack.length) return; const s = redoStack.pop(); undoStack.push(s); await restore(s); };
async function saveProject() { await db.projects.put({ id: 'current', state: snap(), updated: Date.now() }); say('Saved on this device.'); }
$('saveBtn').onclick = saveProject;

/* ---------- Import ---------- */
$('importBtn').onclick = () => $('mediaInput').click();
$('mediaInput').onchange = async e => {
  say('Importing…');
  for (const f of e.target.files) {
    const mediaId = await storeMedia(f);
    const dur = f.type.startsWith('image') ? 5 : await probe(urls[mediaId]);
    if (f.type.startsWith('video')) S.main.push({ id: uid(), mediaId, name: f.name, in: 0, out: dur });
    else if (f.type.startsWith('audio')) S.audio.push({ id: uid(), mediaId, name: f.name, start: 0, in: 0, out: dur });
    else await addOverlay({ type: 'image', mediaId, name: f.name, start: t, dur: 5 });
  }
  e.target.value = ''; commit(); refresh(t); say('Media added.');
};
const probe = url => new Promise(r => { const m = document.createElement('video'); m.preload = 'metadata'; m.onloadedmetadata = () => r(m.duration || 0); m.onerror = () => r(0); m.src = url; });

/* ---------- Overlays (PiP, stickers, text) ---------- */
async function addOverlay(o) {
  o = { id: uid(), layer: S.nextLayer++, dur: 3, start: t, ...o };
  S.overlays.push(o);
  const obj = await buildObject(o);
  if (obj && o.type === 'text') anime({ targets: obj, opacity: [0, 1], top: [obj.top + 50, obj.top], duration: 700, easing: 'easeOutElastic(1, .6)', update: () => canvas.requestRenderAll() });
  commit();
}
$('textBtn').onclick = () => { const s = prompt('Caption text:'); if (s) addOverlay({ type: 'text', text: s, top: RATIOS[S.ratio][1] * 0.7 }); };
const pipInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'video/*,image/*', hidden: true });
document.body.appendChild(pipInput);
$('pipBtn').onclick = () => { pipInput.dataset.replace = sel && sel.lane === 'overlay' ? sel.id : ''; pipInput.click(); };
pipInput.onchange = async () => {
  const f = pipInput.files[0]; if (!f) return;
  const mediaId = await storeMedia(f), type = f.type.startsWith('video') ? 'video' : 'image', rid = pipInput.dataset.replace;
  if (rid) { // Locked layering: replace the media but keep layer, position, size and timing
    const o = S.overlays.find(x => x.id === rid); const old = objOf(rid); if (old) canvas.remove(old);
    Object.assign(o, { mediaId, type, name: f.name }); delete o.el; delete o.scaleX; delete o.scaleY;
    await buildObject(o); restack(); commit(); say('Replaced — layer kept.');
  } else await addOverlay({ type, mediaId, name: f.name, dur: type === 'video' ? await probe(urls[mediaId]) : 5 });
  pipInput.value = '';
};

/* ---------- Timeline ---------- */
function select(id, lane) {
  const L = lane || (S.main.some(c => c.id === id) ? 'main' : S.audio.some(c => c.id === id) ? 'audio' : S.overlays.some(c => c.id === id) ? 'overlay' : null);
  sel = id ? { id, lane: L } : null;
  if (L === 'overlay') { const ob = objOf(id); if (ob && canvas.getActiveObject() !== ob) canvas.setActiveObject(ob); } else canvas.discardActiveObject();
  drawTimeline();
}
function chip(c, lane, cls, label) {
  const b = document.createElement('div');
  b.className = `clip ${cls}` + (sel && sel.id === c.id ? ' selected' : '');
  b.style.width = Math.max(75, (c.out != null ? c.out - c.in : c.dur) * PX) + 'px';
  if (sel && sel.id === c.id) b.style.outline = '2px solid var(--red)';
  b.textContent = label; b.onclick = () => select(c.id, lane);
  return b;
}
function drawTimeline() {
  const lanes = { main: $('videoLane'), overlay: $('overlayLane'), audio: $('audioLane') };
  Object.values(lanes).forEach(l => (l.textContent = ''));
  if (!S.main.length) lanes.main.innerHTML = '<span class="empty-track">Import a video to begin</span>';
  S.main.forEach(c => lanes.main.appendChild(chip(c, 'main', 'video-clip', c.name)));
  [...S.overlays].sort((a, b) => b.layer - a.layer).forEach(o => lanes.overlay.appendChild(chip(o, 'overlay', '', `L${o.layer} ${o.type === 'text' ? o.text : o.name}`)));
  S.audio.forEach(c => lanes.audio.appendChild(chip(c, 'audio', 'audio-clip', c.name)));
  const d = total(); $('timelineRuler').innerHTML = [0, 1, 2, 3].map(i => `<span>${fmt(d * i / 3)}</span>`).join('');
  $('timeDisplay').textContent = `${fmt(t)} / ${fmt(d)}`;
}
$('addTrackBtn').onclick = () => say('Overlay layers stack automatically: each new PiP, sticker or text gets its own layer.');

/* ---------- Playback + anti-scrub jamming ---------- */
function locate(time) {
  let acc = 0;
  for (const c of S.main) { const d = c.out - c.in; if (time < acc + d || c === S.main[S.main.length - 1]) return { c, local: Math.min(Math.max(time - acc, 0), d), start: acc }; acc += d; }
  return null;
}
async function seek(time) {
  const hit = locate(time); if (!hit) return;
  video.style.display = 'block'; $('emptyState').hidden = true;
  const url = await loadMedia(hit.c.mediaId);
  if (video.dataset.mid !== hit.c.mediaId) { video.dataset.mid = hit.c.mediaId; video.src = url; await new Promise(r => (video.onloadedmetadata = r)); }
  const target = hit.c.in + hit.local;
  if (video.fastSeek) video.fastSeek(target); else video.currentTime = target;
}
let pending = null, raf = 0;
$('playhead').oninput = e => { // throttle: at most one seek per animation frame, latest value wins
  pending = (e.target.value / 1000) * total();
  if (!raf) raf = requestAnimationFrame(async () => { raf = 0; if (video.seeking) return setTimeout(() => $('playhead').oninput({ target: $('playhead') }), 40); t = pending; await seek(t); refresh(t); });
};
function refresh(time) {
  t = time; const d = total() || 1;
  $('playhead').value = (t / d) * 1000; $('timeDisplay').textContent = `${fmt(t)} / ${fmt(total())}`;
  S.overlays.forEach(o => {
    const ob = objOf(o.id); if (!ob) return;
    const on = t >= o.start && t <= o.start + o.dur;
    if (on && !ob.visible && o.type === 'text') anime({ targets: ob, opacity: [0, 1], duration: 400, easing: 'easeOutCubic', update: () => canvas.requestRenderAll() });
    ob.visible = on;
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
      t = S.main.slice(0, i + 1).reduce((a, x) => a + x.out - x.in, 0); seek(t).then(() => video.play());
    } else t = hit.start + (ct - c.in);
  }
  refresh(t); S.audio.forEach(a => playAudio(a)); requestAnimationFrame(tick);
}
const audios = {};
function playAudio(a) {
  const el = audios[a.id] || (audios[a.id] = Object.assign(new Audio(urls[a.mediaId]), { preload: 'auto' }));
  if (t >= a.start && el.paused) { el.currentTime = a.in + t - a.start; el.play().catch(() => {}); }
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
  const c = hit.c, at = c.in + hit.local; if (at <= c.in + 0.1 || at >= c.out - 0.1) return say('Move the playhead inside a clip to split.');
  S.main.splice(S.main.indexOf(c), 1, { ...c, out: at }, { ...c, id: uid(), in: at });
  commit(); say('Split.');
};
$('trimBtn').onclick = () => {
  const c = sel && sel.lane === 'main' ? S.main.find(x => x.id === sel.id) : null;
  if (!c) return say('Tap a video clip on the timeline first.');
  const a = parseFloat(prompt(`Keep from (seconds, 0–${c.out - c.in}):`, '0')), b = parseFloat(prompt('Keep until (seconds):', (c.out - c.in).toFixed(1)));
  if (isNaN(a) || isNaN(b) || b - a < 0.2) return say('Trim cancelled.');
  const base = c.in; c.in = base + Math.max(0, a); c.out = Math.min(c.out, base + b); commit(); refresh(0);
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
let ff;
async function getFFmpeg() {
  if (ff) return ff;
  const CDN = 'https://cdn.jsdelivr.net/npm/';
  await loadScript(CDN + '@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js');
  await loadScript(CDN + '@ffmpeg/util@0.12.1/dist/umd/index.js');
  const { toBlobURL } = FFmpegUtil, core = CDN + '@ffmpeg/core@0.12.6/dist/umd/';
  ff = new FFmpegWASM.FFmpeg();
  await ff.load({
    classWorkerURL: await toBlobURL(CDN + '@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js', 'text/javascript'),
    coreURL: await toBlobURL(core + 'ffmpeg-core.js', 'text/javascript'),
    wasmURL: await toBlobURL(core + 'ffmpeg-core.wasm', 'application/wasm'),
  });
  return ff;
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
  const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
}

$('exportBtn').onclick = async () => {
  if (!S.main.length) return say('Nothing to export yet.');
  if (playing) stop();
  const btn = $('exportBtn'); btn.disabled = true;
  try {
    say('Loading video engine (first time only)…'); await getFFmpeg();
    ff.on('progress', ({ progress }) => say(`Rendering… ${Math.round(Math.min(progress, 1) * 100)}%`));
    const [W, H] = RATIOS[S.ratio], segs = []; let offset = 0, cached = null;
    for (let i = 0; i < S.main.length; i++) {
      const c = S.main[i], d = c.out - c.in, ext = (files[c.mediaId].name || 'v.mp4').split('.').pop().toLowerCase();
      const src = `src_${c.mediaId}.${ext}`;
      say(`Clip ${i + 1} of ${S.main.length}…`);
      if (cached !== src) { if (cached) await ff.deleteFile(cached).catch(() => {}); await ff.writeFile(src, new Uint8Array(await files[c.mediaId].arrayBuffer())); cached = src; }
      const live = S.overlays.filter(o => o.type !== 'video' && o.start < offset + d && o.start + o.dur > offset);
      const inputs = [], names = [];
      for (let k = 0; k < live.length; k++) { const n = `ov${k}.png`; await ff.writeFile(n, await overlayPNG(live[k])); names.push(n); inputs.push('-i', n); }
      let g = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30[b0]`, last = 'b0';
      live.sort((a, b) => a.layer - b.layer).forEach((o, k) => { // lower layers first so stacking matches the preview
        g += `;[${last}][${k + 1}:v]overlay=0:0:enable='between(t,${Math.max(0, o.start - offset).toFixed(2)},${(o.start + o.dur - offset).toFixed(2)})'[b${k + 1}]`; last = `b${k + 1}`;
      });
      const seg = `seg${i}.mp4`;
      await run(['-ss', String(c.in), '-t', String(d), '-i', src, ...inputs, '-filter_complex', g, '-map', `[${last}]`, '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2', seg]);
      for (const n of names) await ff.deleteFile(n);
      segs.push(seg); offset += d;
    }
    if (cached) await ff.deleteFile(cached).catch(() => {});
    say('Joining clips…');
    await ff.writeFile('list.txt', new TextEncoder().encode(segs.map(s => `file '${s}'`).join('\n')));
    await run(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'joined.mp4']);
    for (const s of segs) await ff.deleteFile(s);
    let out = 'joined.mp4';
    if (S.audio.length) { // mix music / voice-over on top
      say('Mixing audio…');
      const ins = [], parts = [];
      for (let k = 0; k < S.audio.length; k++) {
        const a = S.audio[k], n = `aud${k}`; await ff.writeFile(n, new Uint8Array(await files[a.mediaId].arrayBuffer()));
        ins.push('-i', n); const ms = Math.round(a.start * 1000);
        parts.push(`[${k + 1}:a]atrim=start=${a.in}:end=${a.out},asetpts=PTS-STARTPTS,adelay=${ms}|${ms}[a${k}]`);
      }
      const ids = S.audio.map((_, k) => `[a${k}]`).join('');
      const tryMix = (withOrig) => run(['-i', 'joined.mp4', ...ins, '-filter_complex', `${parts.join(';')};${withOrig ? '[0:a]' : ''}${ids}amix=inputs=${S.audio.length + (withOrig ? 1 : 0)}:duration=first:normalize=0[m]`, '-map', '0:v', '-map', '[m]', '-c:v', 'copy', '-c:a', 'aac', 'final.mp4']);
      try { await tryMix(true); } catch { await tryMix(false); }
      out = 'final.mp4';
    }
    const data = await ff.readFile(out);
    await saveVideo(data);
    ['joined.mp4', 'final.mp4', 'list.txt'].forEach(n => ff.deleteFile(n).catch(() => {}));
    say('Done — your video was downloaded.');
  } catch (err) { console.error(err); say('Export problem: ' + err.message); }
  btn.disabled = false;
};

/* ---------- Start up ---------- */
(async function init() {
  sizeCanvas();
  const row = await db.projects.get('current').catch(() => null);
  if (row) { try { S = JSON.parse(row.state); await rebuildCanvas(); if (S.main.length) await seek(0); say('Restored your last project.'); } catch (e) { console.warn(e); } }
  undoStack = [snap()]; drawTimeline(); refresh(0);
  if (window.lucide) lucide.createIcons();
})();

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
