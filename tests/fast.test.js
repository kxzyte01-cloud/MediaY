'use strict';
// Unit tests for mediay-fast.js that need no browser: MP4 parsing, Annex B conversion and the planning maths.
// The MP4 fixtures are generated with ffmpeg (skipped when ffmpeg is not installed).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Fast = require('../mediay-fast.js');

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediay-fast-'));
const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(cmd + ' failed: ' + r.stderr); return r.stdout; };+const blobOf = file => new Blob([fs.readFileSync(file)]);
const gen = (name, extra, vcodec = ['-c:v', 'libx264', '-preset', 'veryfast', '-bf', '2', '-g', '15', '-pix_fmt', 'yuv420p']) => {
  const out = path.join(tmp, name);
  sh('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2',
    ...vcodec, '-c:a', 'aac', '-shortest', ...extra, out]);
  return out;
};
const packets = file => sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,dts_time,size,pos,flags', '-of', 'json', file]);

test('planning maths', () => {
  assert.equal(Fast.frameCount(1, 30), 30);
  assert.equal(Fast.frameCount(1.01, 30), 31);
  assert.equal(Fast.frameCount(0.001, 30), 1);
  assert.equal(Fast.avcLevelIdc(720, 1280, 30), 31);
  assert.equal(Fast.avcLevelIdc(1080, 1920, 30), 40);
  assert.equal(Fast.avcLevelIdc(2160, 3840, 30), 51);
  assert.deepEqual(Fast.fitRect(1920, 1080, 720, 1280), { x: 0, y: 436, w: 720, h: 406 });
  assert.deepEqual(Fast.fitRect(1080, 1920, 720, 1280), { x: 0, y: 0, w: 720, h: 1280 });
  const clip = { in: 2, speed: 2 };
  assert.ok(Math.abs(Fast.sourceLimit(clip, 0, 30) - (2 + (0.5 / 30) * 2)) < 1e-9);
  assert.ok(Fast.targetBitrate(720, 1280, 30) >= 1.5e6 && Fast.targetBitrate(3840, 2160, 60) <= 40e6);
});

test('eligibility reasons', () => {
  assert.equal(Fast.ineligibleReason({ clips: [{}], overlays: [{ type: 'text' }] }), null);
  assert.match(Fast.ineligibleReason({ clips: [{ reverse: true }] }), /reversed/);
  assert.match(Fast.ineligibleReason({ clips: [{}, { transition: true }] }), /clip 2 has a transition/);
  assert.match(Fast.ineligibleReason({ clips: [{}], overlays: [{ type: 'video' }] }), /video overlay/);
  assert.match(Fast.ineligibleReason({ clips: [{}], overlays: [{ type: 'image', blend: 'multiply' }] }), /blend/);
  assert.match(Fast.ineligibleReason({ clips: [] }), /no clips/);
});

test('HEVC codec string layout', () => {
  // hvcC for Main profile, level 4.0 (120), as written by common encoders
  const cfg = new Uint8Array(23);
  cfg[0] = 1; cfg[1] = 0x01; cfg[2] = 0x60; cfg[3] = 0; cfg[4] = 0; cfg[5] = 0; cfg[6] = 0x90; cfg[12] = 120;
  assert.equal(Fast.codecFromConfig('hvc1', cfg), 'hvc1.1.6.L120.90');
});

test('avcC / Annex B conversion on a synthetic sample', () => {
  const avcC = Uint8Array.from([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 3, 0x67, 1, 2, 1, 0, 2, 0x68, 9]);
  const p = Fast.parseAvcC(avcC);
  assert.equal(p.nalLength, 4); assert.equal(p.sps.length, 1); assert.equal(p.pps.length, 1);
  const sample = Uint8Array.from([0, 0, 0, 3, 0x65, 0xaa, 0xbb, 0, 0, 0, 2, 0x41, 0xcc]);
  assert.deepEqual(Array.from(Fast.avccToAnnexB(sample, 4, null)), [0, 0, 0, 1, 0x65, 0xaa, 0xbb, 0, 0, 0, 1, 0x41, 0xcc]);
  assert.deepEqual(Array.from(Fast.avccToAnnexB(sample, 4, p)).slice(0, 12), [0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x68]);
});

test('demux matches ffprobe: sample table, key frames, timing (B-frames, moov at end and at start)', { skip: !haveFfmpeg }, async () => {
  for (const [name, extra] of [['plain.mp4', []], ['faststart.mp4', ['-movflags', '+faststart']]]) {
    const file = gen(name, extra);
    const { video, hasAudio } = await Fast.demux(blobOf(file));
    const ref = JSON.parse(packets(file)).packets;
    assert.equal(hasAudio, true);
    assert.equal(video.count, ref.length, name);
    assert.equal(video.width, 320); assert.equal(video.height, 240);
    assert.match(video.codec, /^avc1\.[0-9a-f]{6}$/);
    assert.equal(video.rotation, 0);
    // packets from ffprobe are in file (decode) order, like our sample table
    for (let i = 0; i < ref.length; i++) {
      assert.equal(video.sizes[i], Number(ref[i].size), `size ${i}`);
      assert.equal(video.offsets[i], Number(ref[i].pos), `offset ${i}`);
      assert.equal(video.key[i], ref[i].flags.startsWith('K') ? 1 : 0, `key ${i}`);
      assert.ok(Math.abs(video.pts[i] - Number(ref[i].pts_time)) < 1e-4, `pts ${i}: ${video.pts[i]} vs ${ref[i].pts_time}`);
    }
  }
});

test('rotation metadata is read (90 and 270)', { skip: !haveFfmpeg }, async () => {
  for (const deg of [90, 270, 180]) {
    const base = gen('rot_src.mp4', []);
    const out = path.join(tmp, `rot${deg}.mp4`);
    sh('ffmpeg', ['-y', '-loglevel', 'error', '-display_rotation', String(deg), '-i', base, '-c', 'copy', out]);
    const { video } = await Fast.demux(blobOf(out));
    // ffmpeg's -display_rotation is counter-clockwise; the displayed picture is rotated that way,
    // so the clockwise rotation we must apply to the stored picture is the complement.
    assert.equal(video.rotation, (360 - deg) % 360 || 0, `deg ${deg}`);
  }
});

test('AVCC to Annex B: the converted stream decodes to the same frames as the original file', { skip: !haveFfmpeg }, async () => {
  // No B-frames here on purpose: that is what a WebCodecs encoder produces, and ffmpeg's raw .h264 reader
  // itself loses leading frames of B-frame streams (verified against ffmpeg's own h264_mp4toannexb).
  const file = gen('annexb.mp4', [], ['-c:v', 'libx264', '-preset', 'veryfast', '-bf', '0', '-g', '15', '-pix_fmt', 'yuv420p']);
  const { video } = await Fast.demux(blobOf(file));
  const params = Fast.parseAvcC(video.description);
  const bytes = fs.readFileSync(file);
  const parts = [];
  for (let i = 0; i < video.count; i++) {
    parts.push(Fast.avccToAnnexB(bytes.subarray(video.offsets[i], video.offsets[i] + video.sizes[i]), params.nalLength, video.key[i] ? params : null));
  }
  const es = path.join(tmp, 'annexb.h264');
  fs.writeFileSync(es, Buffer.concat(parts));
  const remuxed = path.join(tmp, 'annexb_out.mp4');
  sh('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'h264', '-framerate', '30', '-i', es, '-c:v', 'copy', remuxed]);
  const md5 = f => sh('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'framemd5', '-']).split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').pop().trim());
  assert.deepEqual(md5(remuxed), md5(file));
});

test('unsupported inputs are rejected with Unsupported (so the caller can fall back)', { skip: !haveFfmpeg }, async () => {
  const webm = path.join(tmp, 'a.webm');
  sh('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1', '-c:v', 'libvpx', webm]);
  await assert.rejects(() => Fast.demux(blobOf(webm)), Fast.Unsupported);
  const frag = path.join(tmp, 'frag.mp4');
  sh('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1', '-c:v', 'libx264', '-movflags', 'frag_keyframe+empty_moov', frag]);
  await assert.rejects(() => Fast.demux(blobOf(frag)), Fast.Unsupported);
  const ten = path.join(tmp, 'ten.mp4');
  sh('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', ten]);
  await assert.rejects(() => Fast.demux(blobOf(ten)), Fast.Unsupported);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ } });
test('encoder self-test times out and closes a stuck encoder', async () => {
  const saved = {
    VideoEncoder: globalThis.VideoEncoder,
    VideoFrame: globalThis.VideoFrame,
    OffscreenCanvas: globalThis.OffscreenCanvas,
  };
  class FakeCanvas {
    getContext() { return { fillRect() {}, set fillStyle(_) {} }; }
  }
  class FakeFrame { close() {} }
  try {
    for (const mode of ['queue', 'flush']) {
      let closed = false;
      globalThis.OffscreenCanvas = FakeCanvas;
      globalThis.VideoFrame = FakeFrame;
      globalThis.VideoEncoder = class {
        constructor() { this.encodeQueueSize = mode === 'queue' ? 5 : 0; }
        configure() {}
        encode() {}
        flush() { return mode === 'flush' ? new Promise(() => {}) : Promise.resolve(); }
        close() { closed = true; }
      };
      await assert.rejects(
        () => Fast.benchmarkEncoder({ config: { width: 16, height: 16, framerate: 30 } }, 1, 15),
        /Timed out/
      );
      assert.equal(closed, true, `${mode} timeout must close the encoder`);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
