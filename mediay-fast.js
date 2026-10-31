/* MediaY fast export engine (WebCodecs).
   Decodes the source video with the device's own video decoder, composites trim/speed/fade/overlays on a canvas,
   and encodes with the device's own H.264 encoder (hardware where the phone has it). Audio and the final MP4 are
   still produced by FFmpeg (cheap work). Every public function either returns a result or throws; the caller
   falls back to the FFmpeg-only export on ANY problem, so this module can never be the reason an export fails.

   Loaded as a browser global (window.MediaYFast) and as a Node module (parsing/planning helpers are unit-tested in Node;
   the decode/encode parts need a browser with WebCodecs). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MediaYFast = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class Unsupported extends Error {
    constructor(message) { super(message); this.name = 'Unsupported'; }
  }
  const TS_BIAS_US = 5e6; // chunk timestamps must not be negative; edit lists can make early frames negative
  const even = n => Math.max(2, Math.round(n / 2) * 2);

  /* ------------------------------------------------------------------
     1. MP4 / MOV parsing (moov box only; sample data is read later, in ranges)
     ------------------------------------------------------------------ */
  const fourcc = (v, o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  const u64 = (v, o) => Number(v.getBigUint64(o));

  function listBoxes(v, start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = v.getUint32(p);
      const type = fourcc(v, p + 4);
      let header = 8;
      if (size === 1) { size = u64(v, p + 8); header = 16; } else if (size === 0) size = end - p;
      if (size < header || p + size > end) break;
      out.push({ type, start: p + header, end: p + size });
      p += size;
    }
    return out;
  }
  const child = (v, box, type) => listBoxes(v, box.start, box.end).find(b => b.type === type) || null;
  const childrenOf = (v, box, type) => listBoxes(v, box.start, box.end).filter(b => b.type === type);

  async function readMoov(file) {
    let pos = 0;
    const size = file.size;
    while (pos + 8 <= size) {
      const head = new DataView(await file.slice(pos, Math.min(size, pos + 16)).arrayBuffer());
      if (head.byteLength < 8) break;
      let boxSize = head.getUint32(0);
      const type = fourcc(head, 4);
      let header = 8;
      if (boxSize === 1 && head.byteLength >= 16) { boxSize = u64(head, 8); header = 16; } else if (boxSize === 0) boxSize = size - pos;
      if (boxSize < header) throw new Unsupported('damaged MP4 box');
      if (type === 'moof') throw new Unsupported('fragmented MP4');
      if (type === 'moov') {
        if (boxSize > 512 * 1024 * 1024) throw new Unsupported('moov too large');
        return await file.slice(pos + header, pos + boxSize).arrayBuffer();
      }
      pos += boxSize;
    }
    throw new Unsupported('not an MP4/MOV file (no moov box)');
  }

  function hex2(n) { return (n & 255).toString(16).padStart(2, '0'); }

  function codecFromConfig(fourccName, cfg) {
    if (fourccName === 'avc1' || fourccName === 'avc3') return 'avc1.' + hex2(cfg[1]) + hex2(cfg[2]) + hex2(cfg[3]);
    if (fourccName === 'hvc1' || fourccName === 'hev1') {
      const profileSpace = cfg[1] >> 6, tier = (cfg[1] >> 5) & 1, profile = cfg[1] & 31;
      let compat = ((cfg[2] << 24) | (cfg[3] << 16) | (cfg[4] << 8) | cfg[5]) >>> 0, rev = 0;
      for (let i = 0; i < 32; i++) { rev = ((rev << 1) | (compat & 1)) >>> 0; compat >>>= 1; }
      const constraints = Array.from(cfg.subarray(6, 12));
      while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
      return fourccName + '.' + ['', 'A', 'B', 'C'][profileSpace] + profile + '.' + rev.toString(16).toUpperCase() +
        '.' + (tier ? 'H' : 'L') + cfg[12] + (constraints.length ? '.' + constraints.map(b => b.toString(16).toUpperCase()).join('.') : '');
    }
    if (fourccName === 'vp09') { // vpcC: 4 bytes version/flags, profile, level, bitDepth(4) chroma(3) range(1)
      return 'vp09.' + String(cfg[4]).padStart(2, '0') + '.' + String(cfg[5]).padStart(2, '0') + '.' + String(cfg[6] >> 4).padStart(2, '0');
    }
    return null;
  }

  function parseTrack(v, trak) {
    const tkhd = child(v, trak, 'tkhd'), mdia = child(v, trak, 'mdia');
    if (!tkhd || !mdia) return null;
    const mdhd = child(v, mdia, 'mdhd'), hdlr = child(v, mdia, 'hdlr'), minf = child(v, mdia, 'minf');
    if (!mdhd || !hdlr || !minf) return null;
    const handler = fourcc(v, hdlr.start + 8);
    const mdhdVersion = v.getUint8(mdhd.start);
    const timescale = mdhdVersion === 1 ? v.getUint32(mdhd.start + 20) : v.getUint32(mdhd.start + 12);
    const mediaDuration = mdhdVersion === 1 ? u64(v, mdhd.start + 24) : v.getUint32(mdhd.start + 16);
    const track = { handler, timescale, mediaDuration };
    // display matrix -> rotation (clockwise degrees as shown on screen)
    const m = v.getUint8(tkhd.start) === 1 ? tkhd.start + 52 : tkhd.start + 40;
    const a = v.getInt32(m) / 65536, b = v.getInt32(m + 4) / 65536;
    const angle = Math.round(Math.atan2(b, a) * 180 / Math.PI);
    track.rotation = ((angle % 360) + 360) % 360;
    if (![0, 90, 180, 270].includes(track.rotation)) track.rotation = 0;
    const stbl = child(v, minf, 'stbl');
    if (!stbl) return null;
    const stsd = child(v, stbl, 'stsd');
    const entry = stsd && listBoxes(v, stsd.start + 8, stsd.end)[0];
    track.sampleEntry = entry ? entry.type : null;
    if (handler === 'soun') return track;
    if (handler !== 'vide' || !entry) return null;

    const entryChildren = listBoxes(v, entry.start + 78, entry.end);
    track.width = v.getUint16(entry.start + 24);
    track.height = v.getUint16(entry.start + 26);
    const cfgBox = entryChildren.find(b => ['avcC', 'hvcC', 'vpcC'].includes(b.type));
    if (!cfgBox) throw new Unsupported('video codec ' + track.sampleEntry + ' is not supported by the fast export');
    const cfg = new Uint8Array(v.buffer, v.byteOffset + cfgBox.start, cfgBox.end - cfgBox.start);
    track.codec = codecFromConfig(track.sampleEntry, cfg);
    if (!track.codec) throw new Unsupported('video codec ' + track.sampleEntry + ' is not supported by the fast export');
    track.description = cfgBox.type === 'vpcC' ? null : new Uint8Array(cfg);
    track.configType = cfgBox.type;
    // 10-bit / HDR sources look wrong when drawn to an 8-bit canvas, so leave those to the FFmpeg path.
    if (cfgBox.type === 'avcC' && cfg[1] >= 100 && cfg[1] !== 100) track.highBitDepth = true; // High 10 / 4:2:2 / 4:4:4
    if (cfgBox.type === 'hvcC' && (cfg[1] & 31) !== 1) track.highBitDepth = true; // anything but Main
    if (cfgBox.type === 'vpcC' && (cfg[6] >> 4) > 8) track.highBitDepth = true;
    const colr = entryChildren.find(b => b.type === 'colr');
    if (colr && fourcc(v, colr.start) === 'nclx') {
      const transfer = v.getUint16(colr.start + 6);
      if (transfer === 16 || transfer === 18) track.hdr = true; // PQ / HLG
    }

    // ---- sample tables ----
    const stts = child(v, stbl, 'stts'), stsz = child(v, stbl, 'stsz'), stsc = child(v, stbl, 'stsc');
    const stco = child(v, stbl, 'stco') || child(v, stbl, 'co64'), ctts = child(v, stbl, 'ctts'), stss = child(v, stbl, 'stss');
    if (!stts || !stsz || !stsc || !stco) throw new Unsupported('incomplete MP4 sample tables');
    const count = v.getUint32(stsz.start + 8);
    const fixed = v.getUint32(stsz.start + 4);
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || v.getUint32(stsz.start + 12 + i * 4);

    const dts = new Float64Array(count), cts = new Float64Array(count);
    let n = 0, t = 0;
    const sttsCount = v.getUint32(stts.start + 4);
    for (let e = 0; e < sttsCount && n < count; e++) {
      const c = v.getUint32(stts.start + 8 + e * 8), d = v.getUint32(stts.start + 12 + e * 8);
      for (let k = 0; k < c && n < count; k++) { dts[n++] = t; t += d; }
    }
    if (n !== count) throw new Unsupported('inconsistent MP4 timing table');
    cts.set(dts);
    if (ctts) {
      const signed = v.getUint8(ctts.start) === 1, cc = v.getUint32(ctts.start + 4);
      let idx = 0;
      for (let e = 0; e < cc && idx < count; e++) {
        const c = v.getUint32(ctts.start + 8 + e * 8);
        const off = signed ? v.getInt32(ctts.start + 12 + e * 8) : v.getUint32(ctts.start + 12 + e * 8);
        for (let k = 0; k < c && idx < count; k++, idx++) cts[idx] += off;
      }
    }

    const key = new Uint8Array(count);
    if (stss) {
      const kc = v.getUint32(stss.start + 4);
      for (let i = 0; i < kc; i++) { const s = v.getUint32(stss.start + 8 + i * 4) - 1; if (s >= 0 && s < count) key[s] = 1; }
    } else key.fill(1);

    const is64 = stco.type === 'co64', chunkCount = v.getUint32(stco.start + 4);
    const stscCount = v.getUint32(stsc.start + 4);
    const offsets = new Float64Array(count);
    let s = 0;
    for (let e = 0; e < stscCount; e++) {
      const first = v.getUint32(stsc.start + 8 + e * 12), per = v.getUint32(stsc.start + 12 + e * 12);
      const last = e + 1 < stscCount ? v.getUint32(stsc.start + 8 + (e + 1) * 12) - 1 : chunkCount;
      for (let ch = first; ch <= last; ch++) {
        let off = is64 ? u64(v, stco.start + 8 + (ch - 1) * 8) : v.getUint32(stco.start + 8 + (ch - 1) * 4);
        for (let k = 0; k < per && s < count; k++) { offsets[s] = off; off += sizes[s]; s++; }
      }
    }
    if (s !== count) throw new Unsupported('inconsistent MP4 chunk table');

    // edit list: the first real edit's media_time is where presentation starts
    let editStart = 0;
    const edts = child(v, trak, 'edts'), elst = edts && child(v, edts, 'elst');
    if (elst) {
      const ver = v.getUint8(elst.start), ec = v.getUint32(elst.start + 4);
      for (let e = 0; e < ec; e++) {
        const base = elst.start + 8 + e * (ver === 1 ? 20 : 12);
        const mediaTime = ver === 1 ? Number(v.getBigInt64(base + 8)) : v.getInt32(base + 4);
        if (mediaTime >= 0) { editStart = mediaTime; break; }
      }
    }
    const pts = new Float64Array(count);
    for (let i = 0; i < count; i++) { pts[i] = (cts[i] - editStart) / timescale; dts[i] = dts[i] / timescale; }
    let maxEnd = 0;
    for (let i = 0; i < count; i++) if (pts[i] > maxEnd) maxEnd = pts[i];
    Object.assign(track, { count, sizes, offsets, key, pts, dts, duration: maxEnd });
    return track;
  }

  /** Reads an MP4/MOV and returns { video, hasAudio }. Throws Unsupported for anything the fast path should not touch. */
  async function demux(file) {
    const buf = await readMoov(file);
    const v = new DataView(buf);
    const moov = { start: 0, end: buf.byteLength };
    let video = null, hasAudio = false;
    for (const trak of childrenOf(v, moov, 'trak')) {
      const t = parseTrack(v, trak);
      if (!t) continue;
      if (t.handler === 'vide' && !video) video = t;
      else if (t.handler === 'soun') hasAudio = true;
    }
    if (!video) throw new Unsupported('no video track');
    if (video.highBitDepth || video.hdr) throw new Unsupported('10-bit or HDR video');
    if (video.count < 1) throw new Unsupported('video track has no frames');
    return { video, hasAudio };
  }

  /* ------------------------------------------------------------------
     2. H.264 helpers: avcC parsing and AVCC -> Annex B conversion
     ------------------------------------------------------------------ */
  function parseAvcC(d) {
    const u8 = d instanceof Uint8Array ? d : new Uint8Array(d);
    const nalLength = (u8[4] & 3) + 1;
    let p = 6;
    const sps = [], pps = [];
    for (let i = 0, n = u8[5] & 31; i < n; i++) { const len = (u8[p] << 8) | u8[p + 1]; sps.push(u8.subarray(p + 2, p + 2 + len)); p += 2 + len; }
    const ppsCount = u8[p++];
    for (let i = 0; i < ppsCount; i++) { const len = (u8[p] << 8) | u8[p + 1]; pps.push(u8.subarray(p + 2, p + 2 + len)); p += 2 + len; }
    return { nalLength, sps, pps };
  }

  /** Converts one length-prefixed H.264 sample to Annex B (00 00 00 01 start codes). When `params` is given
      (key frames), SPS and PPS are written first so every key frame is a valid stream start. */
  function avccToAnnexB(sample, nalLength, params) {
    const data = sample instanceof Uint8Array ? sample : new Uint8Array(sample);
    let total = 0, p = 0;
    const lens = [];
    while (p + nalLength <= data.length) {
      let len = 0;
      for (let i = 0; i < nalLength; i++) len = len * 256 + data[p + i];
      p += nalLength;
      if (len <= 0 || p + len > data.length) break;
      lens.push([p, len]); total += 4 + len; p += len;
    }
    let extra = 0;
    if (params) for (const x of [...params.sps, ...params.pps]) extra += 4 + x.length;
    const out = new Uint8Array(extra + total);
    let o = 0;
    const startCode = () => { out[o++] = 0; out[o++] = 0; out[o++] = 0; out[o++] = 1; };
    if (params) for (const x of [...params.sps, ...params.pps]) { startCode(); out.set(x, o); o += x.length; }
    for (const [start, len] of lens) { startCode(); out.set(data.subarray(start, start + len), o); o += len; }
    return out;
  }

  /* ------------------------------------------------------------------
     3. Planning helpers (pure, unit-tested)
     ------------------------------------------------------------------ */
  /** Output frame count for a clip that lasts `seconds` on the timeline. Matches `-t` + the fps filter. */
  const frameCount = (seconds, fps) => Math.max(1, Math.ceil(seconds * fps - 1e-6));

  /** Source time (seconds) below which the source frame for output slot k is chosen. Same rule as FFmpeg's `fps` filter (round to nearest). */
  const sourceLimit = (clip, k, fps) => clip.in + ((k + 0.5) / fps) * (clip.speed || 1);

  /** Level_idc for H.264 at this size and rate (Annex A limits for MaxFS and MaxMBPS). */
  function avcLevelIdc(W, H, fps) {
    const mbs = Math.ceil(W / 16) * Math.ceil(H / 16), mbps = mbs * fps;
    const levels = [[30, 1620, 40500], [31, 3600, 108000], [40, 8192, 245760], [42, 8704, 522240], [50, 22080, 589824], [51, 36864, 983040], [52, 36864, 2073600]];
    for (const [idc, maxFs, maxMbps] of levels) if (mbs <= maxFs && mbps <= maxMbps) return idc;
    return 52;
  }

  /** Bits per second: about what libx264 -crf 28 produces, never absurd. */
  function targetBitrate(W, H, fps) {
    return Math.round(Math.min(40e6, Math.max(1.5e6, W * H * fps * 0.09)));
  }

  /** Rectangle (output pixels) a video of displayW x displayH occupies when scaled to fit and centered, like scale(decrease)+pad. */
  function fitRect(displayW, displayH, W, H) {
    const sc = Math.min(W / displayW, H / displayH);
    const w = Math.min(W, even(displayW * sc)), h = Math.min(H, even(displayH * sc));
    return { x: Math.floor((W - w) / 2 / 2) * 2, y: Math.floor((H - h) / 2 / 2) * 2, w, h };
  }

  /** Decode range for one clip: first sample to feed (a key frame at or before `in`) and last sample needed. */
  function clipSampleRange(track, clip, frames, fps) {
    const limit = sourceLimit(clip, frames - 1, fps);
    let start = 0;
    for (let i = 0; i < track.count; i++) if (track.key[i] && track.pts[i] <= clip.in + 1e-4) start = i;
    let end = start;
    for (let i = start; i < track.count; i++) if (track.pts[i] < limit + 1e-4) end = i; // feeding one extra frame is harmless
    return { start, end };
  }

  /** Why the fast path cannot be used for this project, or null when it can. `project` carries plain booleans. */
  function ineligibleReason(project) {
    if (!project || !project.clips || !project.clips.length) return 'no clips';
    for (const [i, c] of project.clips.entries()) {
      if (c.reverse) return `clip ${i + 1} is reversed`;
      if (c.effect) return `clip ${i + 1} has a filter`;
      if (c.adjust) return `clip ${i + 1} has color adjustments`;
      if (c.transition) return `clip ${i + 1} has a transition`;
    }
    for (const o of project.overlays || []) {
      if (o.type === 'video') return 'a video overlay is present';
      if (o.blend && o.blend !== 'normal') return 'an overlay uses a blend mode';
    }
    return null;
  }

  /* ------------------------------------------------------------------
     4. Encoder configuration and self-test (browser only)
     ------------------------------------------------------------------ */
  function requireWebCodecs() {
    const g = typeof self !== 'undefined' ? self : globalThis;
    if (typeof g.VideoEncoder !== 'function' || typeof g.VideoDecoder !== 'function' || typeof g.EncodedVideoChunk !== 'function' || typeof g.VideoFrame !== 'function') {
      throw new Unsupported('this browser has no WebCodecs video support');
    }
    if (typeof g.OffscreenCanvas !== 'function' && typeof g.document === 'undefined') throw new Unsupported('no canvas available');
    if (typeof g.createImageBitmap !== 'function') throw new Unsupported('no createImageBitmap');
  }

  function h264Candidates(W, H, fps) {
    const level = hex2(avcLevelIdc(W, H, fps));
    return ['64', '4d', '42'].map(profile => 'avc1.' + profile + '00' + level); // High, Main, Baseline
  }

  /** First encoder configuration the device accepts, preferring hardware. Returns { config, codec, acceleration } or throws Unsupported. */
  async function chooseEncoderConfig(opts) {
    requireWebCodecs();
    const { W, H, fps } = opts;
    const bitrate = opts.bitrate || targetBitrate(W, H, fps);
    const codecs = opts.codecs || h264Candidates(W, H, fps);
    // Some phone encoders reject optional settings (variable bitrate, quality mode); retry with fewer of them before giving up on a codec.
    const variants = [{ bitrateMode: 'variable', latencyMode: 'quality' }, { bitrateMode: 'variable' }, {}];
    for (const acceleration of opts.acceleration || ['prefer-hardware', 'no-preference']) {
      for (const codec of codecs) {
        for (const extra of variants) {
          const cfg = Object.assign({ codec, width: W, height: H, bitrate, framerate: fps, hardwareAcceleration: acceleration }, extra);
          try {
            const r = await VideoEncoder.isConfigSupported(cfg);
            if (r && r.supported) return { config: cfg, codec, acceleration };
          } catch (_) { /* try the next one */ }
        }
      }
    }
    throw new Unsupported('this device has no usable video encoder for ' + W + 'x' + H + ' at ' + fps + ' fps');
  }

  /** Encodes a few synthetic frames and reports real speed, so a device whose "fast" encoder is slow is detected up front. */
  async function benchmarkEncoder(choice, frames = 12, timeoutMs = 15000) {
    const { config } = choice, W = config.width, H = config.height;
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = canvas.getContext('2d');
    let err = null, outputs = 0;
    const enc = new VideoEncoder({ output: () => { outputs++; }, error: e => { err = e; } });
    const t0 = performance.now();
    const deadline = t0 + timeoutMs;
    const remaining = label => {
      const ms = deadline - performance.now();
      if (ms <= 0) throw new Error('Timed out: encoder self-test ' + label);
      return ms;
    };
    try {
      enc.configure(config);
      for (let i = 0; i < frames; i++) {
        if (err) throw new Unsupported('encoder self-test failed: ' + (err.message || err));
        ctx.fillStyle = `hsl(${(i * 37) % 360},70%,50%)`; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#fff'; ctx.fillRect((i * 17) % W, H / 3, W / 4, H / 4);
        const f = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / config.framerate) });
        try { enc.encode(f, { keyFrame: i === 0 }); } finally { f.close(); }
        while (enc.encodeQueueSize > 4) {
          await withTimeout(new Promise(r => setTimeout(r, 2)), remaining('waiting for encoder queue'));
        }
      }
      await withTimeout(enc.flush(), remaining('flush'));
      if (err) throw new Unsupported('encoder self-test failed: ' + (err.message || err));
      if (outputs < 1) throw new Unsupported('encoder self-test produced no output');
      const ms = performance.now() - t0;
      return { fps: frames / (ms / 1000), ms };
    } finally {
      // A stuck encoder must not keep the export pipeline alive or retain device resources.
      try { enc.close(); } catch (_) { /* already closed or failed to configure */ }
    }
  }

  /* ------------------------------------------------------------------
     5. Sources: ranged file reads and a decoder that yields frames in display order
     ------------------------------------------------------------------ */
  class RangeReader {
    constructor(file, windowBytes = 8 * 1024 * 1024) { this.file = file; this.win = windowBytes; this.buf = null; this.start = 0; this.end = 0; }
    async read(offset, size) {
      if (this.buf && offset >= this.start && offset + size <= this.end) return this.buf.subarray(offset - this.start, offset - this.start + size);
      const end = Math.min(this.file.size, offset + Math.max(size, this.win));
      this.buf = new Uint8Array(await this.file.slice(offset, end).arrayBuffer());
      this.start = offset; this.end = end;
      return this.buf.subarray(0, size);
    }
  }

  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /** True when this device can decode the track (checked up front so an unsupported phone never starts a long render). */
  async function checkDecoder(track) {
    requireWebCodecs();
    const cfg = { codec: track.codec, codedWidth: track.width, codedHeight: track.height };
    if (track.description) cfg.description = track.description;
    try { const r = await VideoDecoder.isConfigSupported(cfg); return !!(r && r.supported); } catch (_) { return false; }
  }

  class ClipDecoder {
    constructor(track, reader, range, opts = {}) {
      this.track = track; this.reader = reader; this.range = range;
      this.q = []; this.waiters = []; this.gates = [];
      this.err = null; this.done = false; this.closed = false;
      this.maxQueued = opts.maxQueued || 3;
      this.timeoutMs = opts.timeoutMs || 30000;
      this.decodeAcceleration = opts.acceleration || 'no-preference';
      this.dec = new VideoDecoder({
        output: frame => { if (this.closed) frame.close(); else { this.q.push(frame); this._wake(); } },
        error: e => { this.err = e; this._wake(); this._openGate(); }
      });
      this.dec.ondequeue = () => this._openGate();
    }
    async start() {
      const t = this.track;
      const cfg = { codec: t.codec, codedWidth: t.width, codedHeight: t.height, hardwareAcceleration: this.decodeAcceleration, optimizeForLatency: true };
      if (t.description) cfg.description = t.description;
      const support = await VideoDecoder.isConfigSupported(cfg);
      if (!support || !support.supported) throw new Unsupported('this device cannot decode ' + t.codec);
      this.dec.configure(cfg);
      this._feed();
    }
    _wake() { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
    _openGate() { const g = this.gates; this.gates = []; for (const r of g) r(); }
    async _feed() {
      const t = this.track;
      try {
        for (let i = this.range.start; i <= this.range.end && !this.closed; i++) {
          while (!this.closed && !this.err && (this.dec.decodeQueueSize > 6 || this.q.length >= this.maxQueued)) {
            await withTimeout(new Promise(r => this.gates.push(r)), this.timeoutMs, 'decoder did not accept more input');
          }
          if (this.closed || this.err) return;
          const data = await this.reader.read(t.offsets[i], t.sizes[i]);
          this.dec.decode(new EncodedVideoChunk({
            type: t.key[i] ? 'key' : 'delta',
            timestamp: Math.round(t.pts[i] * 1e6) + TS_BIAS_US,
            data
          }));
        }
        if (!this.closed && !this.err) await withTimeout(this.dec.flush(), this.timeoutMs, 'decoder flush');
        this.done = true;
      } catch (e) {
        if (!this.closed) this.err = e;
      } finally { this._wake(); }
    }
    /** Next decoded frame in display order as { frame, pts } (pts in source seconds), or null at the end. */
    async next() {
      for (;;) {
        if (this.q.length) { const frame = this.q.shift(); this._openGate(); return { frame, pts: (frame.timestamp - TS_BIAS_US) / 1e6 }; }
        if (this.err) throw this.err;
        if (this.done) return null;
        await withTimeout(new Promise(r => this.waiters.push(r)), this.timeoutMs, 'decoder produced no frame');
      }
    }
    close() {
      this.closed = true;
      try { if (this.dec.state !== 'closed') this.dec.close(); } catch (_) { /* already closed */ }
      for (const f of this.q) { try { f.close(); } catch (_) { /* ignore */ } }
      this.q = []; this._openGate(); this._wake();
    }
  }

  /* ------------------------------------------------------------------
     6. Output sinks
     ------------------------------------------------------------------ */
  /** Collects H.264 as an Annex B elementary stream (what `ffmpeg -f h264` reads). */
  class AnnexBSink {
    constructor() { this.parts = []; this.bytes = 0; this.params = null; this.nalLength = 4; }
    onChunk(chunk, meta) {
      if (meta && meta.decoderConfig && meta.decoderConfig.description) {
        const parsed = parseAvcC(meta.decoderConfig.description);
        this.params = parsed; this.nalLength = parsed.nalLength;
      }
      const raw = new Uint8Array(chunk.byteLength);
      chunk.copyTo(raw);
      let out;
      if (this.params) out = avccToAnnexB(raw, this.nalLength, chunk.type === 'key' ? this.params : null);
      else out = raw; // encoder already produced Annex B
      this.parts.push(out); this.bytes += out.length;
    }
    finish() {
      const all = new Uint8Array(this.bytes);
      let o = 0;
      for (const p of this.parts) { all.set(p, o); o += p.length; }
      this.parts = [];
      return all;
    }
  }

  /** IVF container, used by tests to inspect VP8/VP9 output with ffmpeg. Not used in production. */
  class IvfSink {
    constructor(fourccName, W, H, fps) { this.fourcc = fourccName; this.W = W; this.H = H; this.fps = fps; this.frames = []; }
    onChunk(chunk) { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); this.frames.push({ d, ts: chunk.timestamp }); }
    finish() {
      const size = 32 + this.frames.reduce((s, f) => s + 12 + f.d.length, 0);
      const out = new Uint8Array(size), v = new DataView(out.buffer);
      out.set([0x44, 0x4b, 0x49, 0x46]); v.setUint16(4, 0, true); v.setUint16(6, 32, true);
      for (let i = 0; i < 4; i++) out[8 + i] = this.fourcc.charCodeAt(i);
      v.setUint16(12, this.W, true); v.setUint16(14, this.H, true); v.setUint32(16, this.fps, true); v.setUint32(20, 1, true); v.setUint32(24, this.frames.length, true);
      let o = 32;
      this.frames.forEach((f, i) => { v.setUint32(o, f.d.length, true); v.setBigUint64(o + 4, BigInt(i), true); out.set(f.d, o + 12); o += 12 + f.d.length; });
      return out;
    }
  }

  /* ------------------------------------------------------------------
     7. The render loop
     ------------------------------------------------------------------ */
  /**
   * Renders the main timeline to an encoded elementary stream.
   * opts.clips: [{ file, track, in, out, speed, fade }]  (track from demux().video)
   * opts.overlays: [{ bitmap, x, y, w, h, start, end }]  start/end in timeline seconds, x/y/w/h in output pixels
   * opts.choice: result of chooseEncoderConfig; opts.sink: AnnexBSink (or IvfSink in tests)
   * Resolves { frames, clipFrames:[n...], bytes, ms }.
   */
  async function renderTimeline(opts) {
    requireWebCodecs();
    const { clips, W, H, fps, choice, sink } = opts;
    const overlays = opts.overlays || [];
    const onProgress = opts.onProgress || (() => {});
    const isCancelled = opts.isCancelled || (() => false);
    const timeoutMs = opts.timeoutMs || 30000;
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';

    let encErr = null, encoderWaiters = [];
    const encoder = new VideoEncoder({
      output: (chunk, meta) => { try { sink.onChunk(chunk, meta); } catch (e) { encErr = e; } },
      error: e => { encErr = e; }
    });
    encoder.ondequeue = () => { const w = encoderWaiters; encoderWaiters = []; for (const r of w) r(); };
    encoder.configure(choice.config);

    const plan = clips.map(c => ({ c, td: (c.out - c.in) / (c.speed || 1) }));
    plan.forEach(p => { p.frames = frameCount(p.td, fps); });
    const totalFrames = plan.reduce((s, p) => s + p.frames, 0);
    const gop = Math.max(1, Math.round(fps * 2));
    const frameUs = Math.round(1e6 / fps);
    let globalFrame = 0, timelineOffset = 0;
    const t0 = performance.now();
    const cleanup = [];
    try {
      for (const p of plan) {
        const { c } = p;
        const track = c.track, reader = new RangeReader(c.file);
        const range = clipSampleRange(track, c, p.frames, fps);
        const decoder = new ClipDecoder(track, reader, range, { timeoutMs });
        cleanup.push(() => decoder.close());
        await decoder.start();
        const rot = track.rotation, swap = rot === 90 || rot === 270;
        const fd = Math.min(0.4, Math.max(0.05, p.td / 2));
        let cur = null, nxt = await decoder.next();
        for (let k = 0; k < p.frames; k++) {
          if (isCancelled()) throw new Error('Export cancelled');
          if (encErr) throw encErr;
          const limit = sourceLimit(c, k, fps);
          // A frame exactly on the half-slot boundary belongs to the NEXT slot (FFmpeg rounds .5 up). Timestamps are whole
          // microseconds, so allow for rounding: without this, 60 fps footage exported at 30 fps picks the wrong neighbour.
          while (nxt && nxt.pts < limit - 2e-6) { if (cur) cur.frame.close(); cur = nxt; nxt = await decoder.next(); }
          if (!cur && nxt) { cur = nxt; nxt = await decoder.next(); }
          if (!cur) throw new Error('The video has no decodable frames in the selected range.');

          const tClip = k / fps;
          let alpha = 1;
          if (c.fade) alpha = Math.max(0, Math.min(1, tClip / fd, (p.td - tClip) / fd));
          ctx.globalAlpha = 1; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
          const f = cur.frame;
          const dw = swap ? f.displayHeight : f.displayWidth, dh = swap ? f.displayWidth : f.displayHeight;
          const r = fitRect(dw, dh, W, H);
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
          ctx.rotate(rot * Math.PI / 180);
          const pw = swap ? r.h : r.w, ph = swap ? r.w : r.h;
          ctx.drawImage(f, -pw / 2, -ph / 2, pw, ph);
          ctx.restore();
          ctx.globalAlpha = 1;
          const tl = timelineOffset + tClip;
          for (const o of overlays) {
            if (tl >= o.start - 1e-6 && tl <= o.end + 1e-6) ctx.drawImage(o.bitmap, o.x, o.y, o.w, o.h);
          }

          const vf = new VideoFrame(canvas, { timestamp: globalFrame * frameUs, duration: frameUs });
          try { encoder.encode(vf, { keyFrame: globalFrame % gop === 0 }); } finally { vf.close(); }
          globalFrame++;
          while (!encErr && encoder.encodeQueueSize > 6) {
            await withTimeout(new Promise(res => encoderWaiters.push(res)), timeoutMs, 'video encoder stopped accepting frames');
          }
          if (globalFrame % 8 === 0 || globalFrame === totalFrames) onProgress(globalFrame / totalFrames);
        }
        if (cur) cur.frame.close();
        if (nxt) nxt.frame.close();
        decoder.close();
        timelineOffset += p.td;
      }
      await withTimeout(encoder.flush(), timeoutMs * 2, 'video encoder flush');
      if (encErr) throw encErr;
    } finally {
      for (const fn of cleanup) { try { fn(); } catch (_) { /* ignore */ } }
      try { if (encoder.state !== 'closed') encoder.close(); } catch (_) { /* ignore */ }
    }
    return { frames: globalFrame, clipFrames: plan.map(p => p.frames), ms: performance.now() - t0, totalFrames };
  }

  /** Crops a full-canvas transparent overlay (the PNG of the whole editor canvas) to the pixels that matter, so 100 captions
      do not cost 100 full frames of memory. outW x outH is the exported video size; the PNG is stretched over the whole
      frame exactly like FFmpeg's scale=W:H did. Returns null for a fully transparent overlay. */
  async function overlayFromPng(pngBytes, outW, outH) {
    const full = await createImageBitmap(new Blob([pngBytes], { type: 'image/png' }));
    const width = full.width, height = full.height;
    const probe = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    pctx.drawImage(full, 0, 0);
    const data = pctx.getImageData(0, 0, width, height).data;
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0, i = y * width * 4 + 3; x < width; x++, i += 4) {
        if (data[i] !== 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) { full.close(); return null; }
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const bitmap = await createImageBitmap(full, x0, y0, cw, ch);
    full.close();
    const sx = outW / width, sy = outH / height;
    const x = Math.floor(x0 * sx), y = Math.floor(y0 * sy);
    return { bitmap, x, y, w: Math.max(1, Math.min(outW - x, Math.ceil((x0 + cw) * sx) - x)), h: Math.max(1, Math.min(outH - y, Math.ceil((y0 + ch) * sy) - y)) };
  }

  return {
    Unsupported, demux, parseAvcC, avccToAnnexB, codecFromConfig,
    frameCount, sourceLimit, avcLevelIdc, targetBitrate, fitRect, clipSampleRange, ineligibleReason,
    chooseEncoderConfig, benchmarkEncoder, checkDecoder, renderTimeline, overlayFromPng,
    AnnexBSink, IvfSink, RangeReader, ClipDecoder
  };
}));
