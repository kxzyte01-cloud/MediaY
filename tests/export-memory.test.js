const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('video source staging mounts original Blob through WORKERFS instead of copying full ArrayBuffers', () => {
  const start = app.indexOf('const ensureExportSource = async');
  const end = app.indexOf('const ensureOverlayPng = async', start);
  assert.ok(start >= 0 && end > start);
  const source = app.slice(start, end);
  assert.ok(source.includes('mountExportFile(file, name)'));
  assert.ok(!source.includes('file.arrayBuffer()'));
  assert.ok(app.includes("ff.mount('WORKERFS', { blobs: [{ name, data: file }] }, mountDir)"));
});

test('repeated audio tracks reuse one file-backed source and one FFmpeg input per media ID', () => {
  const start = app.indexOf('const activeTracks = [], ins = [];');
  const end = app.indexOf('const originalHasAudio', start);
  assert.ok(start >= 0 && end > start);
  const audio = app.slice(start, end);
  assert.ok(audio.includes('const audioSources = new Map()'));
  assert.ok(audio.includes('ensureExportSource(track.m, new Set([track.m]), audioSources)'));
  assert.ok(audio.includes('const audioInputIndices = new Map()'));
  assert.ok(audio.includes('const audioStreamCache = new Map()'));
  assert.ok(audio.includes("ins.push('-i', sourceName)"));
  assert.ok(audio.includes('activeTracks.push({ ...track, inputIndex })'));
  assert.ok(!audio.includes('mountExportFile('));
  assert.ok(!audio.includes('arrayBuffer()'));
});

test('mounted source files are unmounted and their directories removed on eviction and final cleanup', () => {
  const start = app.indexOf('const removeExportFile = async name =>');
  const end = app.indexOf('const mountExportFile = async', start);
  const cleanup = app.slice(start, end);
  assert.ok(cleanup.includes('ff.unmount(mountDir)'));
  assert.ok(cleanup.includes('ff.deleteDir(mountDir)'));
  assert.ok(app.includes('for (const name of [...exportWorkspaceFiles]) await removeExportFile(name)'));
});
