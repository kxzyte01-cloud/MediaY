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
  () => ({ fill: '#ffe14a', stroke: '#000', strokeWidth: 5, fontStyle: 'italic', paintFirst: 'stroke' })];
const PX = 30; // timeline pixels per second
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
const dur = c => (c.out - c.in) / (c.speed || 1);
const total = () => S.main.reduce((a, c) => a + dur(c), 0);
const video = $('sourceVideo');

/* ---------- Fabric canvas ---------- */
const canvas = new fabric.Canvas('overlayCanvas', { enableRetinaScaling: false, preserveObjectStacking: true, selection: false });
Object.assign(canvas.wrapperEl.style, { position: 'absolute', inset: '0' });
function sizeCanvas() {
  const [w, h] = RATIOS[S.ratio];
  canvas.setDimensions({ width: w, height: h });
  canvas.setDimensions({ width: '100%', height: '100%' }, { cssOnly: true });
  $('previewFrame').style.aspectRatio = `${w} / ${h}`;
  $('previewFrame').style.width = `min(100%, calc(100cqh * ${w / h}))`;
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
    obj = new fabric.Textbox(o.text, { width: w * 0.8, fontFamily: 'DM Sans', fontWeight: 700, fontSize: 56, textAlign: 'center', ...TS[o.style || 0]() });
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
$('importBtn').onclick = () => { $('mediaInput').accept = 'video/*,image/*,audio/*'; $('mediaInput').click(); };
$('audioBtn').onclick = () => { $('mediaInput').accept = 'audio/*'; $('mediaInput').click(); };
$('mediaInput').onchange = async e => {
  say('Importing…');
  for (const f of e.target.files) {
    const mediaId = await storeMedia(f);
    const dur = f.type.startsWith('image') ? 5 : await probe(urls[mediaId]);
    if (f.type.startsWith('video')) S.main.push({ id: uid(), mediaId, name: f.name, in: 0, out: dur, src: dur });
    else if (f.type.startsWith('audio')) S.audio.push({ id: uid(), mediaId, name: f.name, start: t, in: 0, out: dur, src: dur });
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
$('textBtn').onclick = () => openSheet('text');
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
const pack = (items, st, ln) => { const rows = []; return [...items].sort((a, b) => st(a) - st(b)).map(c => { let r = rows.findIndex(e => e <= st(c) + 1e-6); if (r < 0) r = rows.length; rows[r] = st(c) + ln(c); return [c, r]; }); };
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
}
const snapT = v => { let a = 0; const e = [0, t, ...S.main.map(c => (a += dur(c)))].find(x => Math.abs(x - v) < 8 / PX); return e != null ? e : v; };
function clampTrim(c, lane, side, dt) {
  const sp = lane === 'main' ? c.speed || 1 : 1, len = lenOf(c, lane), max = lane === 'overlay' ? 120 : ((c.src || c.out) - c.in) / sp;
  if (side === 'r') return Math.min(Math.max(dt, 0.2 - len), max - len);
  const lo = lane === 'main' ? -c.in / sp : lane === 'audio' ? -Math.min(c.in, c.start) : -c.start;
  return Math.min(Math.max(dt, lo), len - 0.2);
}
function applyTrim(c, lane, side, dt) {
  const sp = lane === 'main' ? c.speed || 1 : 1;
  if (side === 'r') { if (lane === 'overlay') c.dur += dt; else c.out += dt * sp; }
  else if (lane === 'overlay') { c.start += dt; c.dur -= dt; } else { c.in += dt * sp; if (lane === 'audio') c.start += dt; }
}
function autoScroll() { if (!drag || drag.mode !== 'move' || !drag.edge) { if (drag) drag.auto = false; return; } tl.scrollLeft += drag.edge * 10; tl.dispatchEvent(new PointerEvent('pointermove', { clientX: drag.cx, pointerType: 'touch' })); requestAnimationFrame(autoScroll); }
function lift() { const c = itemOf(drag.id, drag.lane); if (!c) return; drag.mode = 'move'; navigator.vibrate && navigator.vibrate(15); select(c.id, drag.lane); drag.el = tl.querySelector(`[data-id="${c.id}"]`); drag.el && drag.el.classList.add('lift'); }
tl.addEventListener('pointerdown', e => {
  if (playing) stop();
  const b = e.target.closest('.clip'); if (!b) return; const lane = b.dataset.lane, c = itemOf(b.dataset.id, lane); if (!c) return;
  const side = e.target.dataset.side;
  drag = { id: c.id, lane, x: e.clientX, side, mode: side ? 'trim' : 'wait', el: b, s0: startOf(c, lane), len: lenOf(c, lane), sl0: tl.scrollLeft };
  tl.setPointerCapture(e.pointerId);
  if (!side) drag.timer = setTimeout(() => drag && drag.mode === 'wait' && lift(), 320);
});
tl.addEventListener('pointermove', e => {
  if (!drag) return; drag.cx = e.clientX; const dx = e.clientX - drag.x + (drag.mode === 'move' ? tl.scrollLeft - drag.sl0 : 0), c = itemOf(drag.id, drag.lane); if (!c) return;
  if (drag.mode === 'wait') { if (Math.abs(dx) > 8) { if (e.pointerType === 'mouse') { clearTimeout(drag.timer); lift(); } else { clearTimeout(drag.timer); drag = null; } } return; }
  if (!drag.el) return;
  if (drag.mode === 'trim') {
    const dt = (drag.dt = clampTrim(c, drag.lane, drag.side, dx / PX)), r = drag.side === 'r', st = drag.lane === 'main' ? drag.s0 : drag.s0 + (r ? 0 : dt);
    drag.el.style.left = st * PX + 'px'; drag.el.style.width = Math.max((drag.len + (r ? dt : -dt)) * PX, 18) + 'px';
  } else if (drag.lane === 'main') drag.el.style.transform = `translateX(${dx}px)`;
  else { drag.ns = snapT(Math.max(0, drag.s0 + dx / PX)); drag.el.style.left = drag.ns * PX + 'px'; }
  if (drag.mode === 'move') { const r = tl.getBoundingClientRect(); drag.edge = e.clientX < r.left + 50 ? -1 : e.clientX > r.right - 50 ? 1 : 0; if (drag.edge && !drag.auto) { drag.auto = true; autoScroll(); } }
});
tl.addEventListener('pointerup', e => {
  if (!drag) return; clearTimeout(drag.timer); const d = drag, c = itemOf(d.id, d.lane); drag = null; if (!c) return;
  if (d.mode === 'wait') return select(c.id, d.lane);
  if (d.mode === 'trim') applyTrim(c, d.lane, d.side, d.dt || 0);
  else if (d.lane === 'main') {
    const cx = d.s0 + d.len / 2 + (e.clientX - d.x + tl.scrollLeft - d.sl0) / PX; let acc = 0, idx = 0;
    S.main.filter(x => x !== c).forEach(x => { const l = dur(x); if (acc + l / 2 < cx) idx++; acc += l; });
    S.main.splice(S.main.indexOf(c), 1); S.main.splice(idx, 0, c);
  } else if (d.ns != null) c.start = d.ns;
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
  video.style.display = 'block'; $('emptyState').hidden = true;
  const url = await loadMedia(hit.c.mediaId);
  if (video.dataset.mid !== hit.c.mediaId) { video.dataset.mid = hit.c.mediaId; video.src = url; await new Promise(r => (video.onloadedmetadata = r)); }
  const target = hit.c.in + hit.local * (hit.c.speed || 1);
  if (video.fastSeek) video.fastSeek(target); else video.currentTime = target;
}
let pending = null, raf = 0;
$('playhead').oninput = e => { // throttle: at most one seek per animation frame, latest value wins
  pending = e.target.time != null ? e.target.time : (e.target.value / 1000) * total();
  if (!raf) raf = requestAnimationFrame(async () => { raf = 0; if (video.seeking) return setTimeout(() => $('playhead').oninput({ target: { time: pending } }), 40); t = pending; await seek(t); refresh(t); });
};
function refresh(time) {
  t = time; const d = total() || 1;
  const hit = locate(t); video.style.filter = (hit && FX[hit.c.fx || 0].c) || ''; video.playbackRate = hit ? hit.c.speed || 1 : 1; video.volume = hit ? Math.min(1, hit.c.vol ?? 1) : 1;
  if (Date.now() - lastScroll > 200) tl.scrollLeft = t * PX;
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
      t = S.main.slice(0, i + 1).reduce((a, x) => a + dur(x), 0); seek(t).then(() => video.play());
    } else t = hit.start + (ct - c.in) / (c.speed || 1);
  }
  refresh(t); S.audio.forEach(a => playAudio(a)); requestAnimationFrame(tick);
}
const audios = {};
function playAudio(a) {
  const el = audios[a.id] || (audios[a.id] = Object.assign(new Audio(urls[a.mediaId]), { preload: 'auto' }));
  el.volume = Math.min(1, a.vol ?? 1);
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

const EXP = { res: 720, fps: 30 };
$('goExport').onclick = async () => {
  if (!S.main.length) return say('Nothing to export yet.');
  if (playing) stop();
  closeSheet(); const btn = $('goExport'); btn.disabled = true;
  try {
    say('Loading video engine (first time only)…'); await getFFmpeg();
    ff.on('progress', ({ progress }) => say(`Rendering… ${Math.round(Math.min(progress, 1) * 100)}%`));
    const [bw, bh] = RATIOS[S.ratio], kk = EXP.res / Math.min(bw, bh), W = Math.round(bw * kk / 2) * 2, H = Math.round(bh * kk / 2) * 2, segs = []; let offset = 0, cached = null;
    const TD = S.main.map((c, i) => (i && c.tr ? Math.min(0.5, dur(S.main[i - 1]) * 0.45, dur(c) * 0.45) : 0)); // overlap length at each clip's start
    for (let i = 0; i < S.main.length; i++) {
      const c = S.main[i], d = c.out - c.in, sp = c.speed || 1, td = d / sp, ext = (files[c.mediaId].name || 'v.mp4').split('.').pop().toLowerCase();
      const src = `src_${c.mediaId}.${ext}`;
      say(`Clip ${i + 1} of ${S.main.length}…`);
      if (cached !== src) { if (cached) await ff.deleteFile(cached).catch(() => {}); await ff.writeFile(src, new Uint8Array(await files[c.mediaId].arrayBuffer())); cached = src; }
      const live = S.overlays.filter(o => o.type !== 'video' && o.start < offset + td && o.start + o.dur > offset);
      const inputs = [], names = [];
      for (let k = 0; k < live.length; k++) { const n = `ov${k}.png`; await ff.writeFile(n, await overlayPNG(live[k])); names.push(n); inputs.push('-i', n); }
      let g = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1${c.rev ? ',reverse' : ''}${sp !== 1 ? `,setpts=PTS/${sp}` : ''},fps=${EXP.fps}${FX[c.fx || 0].f ? ',' + FX[c.fx || 0].f : ''}${c.fade ? `,fade=t=in:d=.4,fade=t=out:st=${Math.max(0, td - .4).toFixed(2)}:d=.4` : ''}[b0]`, last = 'b0';
      live.sort((a, b) => a.layer - b.layer).forEach((o, k) => { // lower layers first so stacking matches the preview
        g += `;[${k + 1}:v]scale=${W}:${H}[s${k}];[${last}][s${k}]overlay=0:0:enable='between(t,${Math.max(0, o.start - offset).toFixed(2)},${(o.start + o.dur - offset).toFixed(2)})'[b${k + 1}]`; last = `b${k + 1}`;
      });
      const tx = TD[i + 1] || 0; // hold the last frame so the blend has something to fade from
      if (tx) { g += `;[${last}]tpad=stop_mode=clone:stop_duration=${tx.toFixed(2)}[bt]`; last = 'bt'; }
      const seg = `seg${i}.mp4`;
      const af = [c.rev && 'areverse', sp !== 1 && `atempo=${sp}`, (c.vol ?? 1) !== 1 && `volume=${c.vol}`, c.fade && `afade=t=in:d=.4,afade=t=out:st=${Math.max(0, td - .4).toFixed(2)}:d=.4`, tx > 0 && `apad=pad_dur=${tx.toFixed(2)}`].filter(Boolean).join(','), enc = a => ['-ss', String(c.in), '-t', String(d), '-i', src, ...inputs, '-filter_complex', g, '-map', `[${last}]`, '-map', '0:a:0?', ...a, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2', seg];
      try { await run(enc(af ? ['-af', af] : [])); } catch (e) { if (!af) throw e; await run(enc(['-an'])); }
      for (const n of names) await ff.deleteFile(n);
      segs.push(seg); offset += td;
    }
    if (cached) await ff.deleteFile(cached).catch(() => {});
    const groups = []; segs.forEach((sg, i) => (i && TD[i] ? groups[groups.length - 1].push(i) : groups.push([i])));
    const pieces = [];
    for (const [gi, grp] of groups.entries()) {
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
    say('Joining clips…');
    await ff.writeFile('list.txt', new TextEncoder().encode(pieces.map(s => `file '${s}'`).join('\n')));
    await run(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'joined.mp4']);
    for (const s of new Set([...segs, ...pieces])) await ff.deleteFile(s).catch(() => {});
    let out = 'joined.mp4';
    if (S.audio.length) { // mix music / voice-over on top
      say('Mixing audio…');
      const ins = [], parts = [];
      for (let k = 0; k < S.audio.length; k++) {
        const a = S.audio[k], n = `aud${k}`; await ff.writeFile(n, new Uint8Array(await files[a.mediaId].arrayBuffer()));
        ins.push('-i', n); const ms = Math.round(a.start * 1000);
        parts.push(`[${k + 1}:a]atrim=start=${a.in}:end=${a.out},asetpts=PTS-STARTPTS${(a.vol ?? 1) !== 1 ? `,volume=${a.vol}` : ''}${a.fade ? `,afade=t=in:d=1,afade=t=out:st=${Math.max(0, a.out - a.in - 1).toFixed(2)}:d=1` : ''},adelay=${ms}|${ms}[a${k}]`);
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

/* ---------- Effects sheet, fades, text styles ---------- */
const sheet = $('sheet'), clipNow = () => (sel && sel.lane === 'main' ? S.main.find(x => x.id === sel.id) : (locate(t) || {}).c);
function markFx() { const c = clipNow(); [...$('fxList').children].forEach((b, i) => b.classList.toggle('on', i === ((c && c.fx) || 0))); }
function openSheet(name) {
  sheet.hidden = false; sheet.dataset.tab = name;
  document.querySelectorAll('[data-pane]').forEach(p => (p.hidden = p.dataset.pane !== name));
  document.querySelectorAll('.dock button').forEach(b => b.classList.toggle('on', b.dataset.sheet === name));
  if (name === 'fx') markFx(); else if (name === 'speed') markSp(); else if (name === 'vol') markVol(); else if (name === 'tr') markTr(); else if (window.lucide) lucide.createIcons();
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
$('styleList').innerHTML = ['Classic', 'Neon', 'Label', 'Pop'].map((n, i) => `<button data-ts="${i}" class="${i ? '' : 'on'}">${n}</button>`).join('');
$('styleList').onclick = async e => {
  const b = e.target.closest('[data-ts]'); if (!b) return;
  txtStyle = +b.dataset.ts; [...$('styleList').children].forEach(x => x.classList.toggle('on', x === b));
  const o = sel && sel.lane === 'overlay' && S.overlays.find(x => x.id === sel.id && x.type === 'text');
  if (o) { const old = objOf(o.id); if (old) canvas.remove(old); o.style = txtStyle; await buildObject(o); refresh(t); commit(); }
};
$('addText').onclick = () => {
  const s = $('textInput').value.trim(); if (!s) return say('Type your caption first.');
  addOverlay({ type: 'text', text: s, style: txtStyle, top: RATIOS[S.ratio][1] * 0.7 }); $('textInput').value = ''; closeSheet();
};

$('exportBtn').onclick = () => openSheet('export');
const TR = [['None', ''], ['Fade', 'fade'], ['Dip black', 'fadeblack'], ['Flash', 'fadewhite'], ['Slide', 'slideleft'], ['Wipe', 'wipeleft'], ['Circle', 'circleopen']];
function markTr() { const c = clipNow(); [...$('trList').children].forEach((b, i) => b.classList.toggle('on', ((c && c.tr) || '') === TR[i][1])); }
$('trBtn').onclick = () => (sheet.hidden || sheet.dataset.tab !== 'tr' ? openSheet('tr') : closeSheet());
$('trList').innerHTML = TR.map(([n, v]) => `<button data-tr="${v}">${n}</button>`).join('');
$('trList').onclick = e => {
  const b = e.target.closest('[data-tr]'), c = clipNow(); if (!b) return; if (!c) return say('Import a video first.');
  if (S.main.indexOf(c) < 1) return say('A transition goes between two clips. Select the second clip.');
  c.tr = b.dataset.tr || undefined; commit(); markTr(); say(c.tr ? 'Transition added. You will see it in the exported video.' : 'Transition removed.');
};
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
const opt = (id, vals, key) => { $(id).innerHTML = vals.map(v => `<button data-v="${v}" class="${EXP[key] === v ? 'on' : ''}">${key === 'res' ? v + 'p' : v}</button>`).join(''); $(id).onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; EXP[key] = +b.dataset.v; [...$(id).children].forEach(x => x.classList.toggle('on', x === b)); }; };
opt('resList', [480, 720, 1080], 'res'); opt('fpsList', [24, 30, 60], 'fps');

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
