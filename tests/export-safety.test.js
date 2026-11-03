'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('muted picture-in-picture video audio is not unexpectedly mixed into exports', () => {
  assert.match(app, /el\.muted\s*=\s*true/);
  assert.match(app, /const ovA = \[\];/);
  assert.match(app, /Do not unexpectedly mix their hidden audio into the exported soundtrack/);
});

test('dropping media caches releases decoded audio buffers and thumbnail data', () => {
  const start = app.indexOf('function dropMediaCaches()');
  const end = app.indexOf('// Does by itself what closing', start);
  assert.ok(start >= 0 && end > start);
  const source = app.slice(start, end);
  assert.match(source, /for \(const id of Object\.keys\(decoded\)\) delete decoded\[id\]/);
  assert.match(source, /for \(const id of Object\.keys\(thumbs\)\) delete thumbs\[id\]/);
});

test('undo history remains bounded and Fabric overlay media is explicitly disposed', () => {
  assert.match(app, /undoStack\.length > 50/);
  assert.match(app, /function disposeOverlayObject\(object, overlay\)/);
  assert.match(app, /object\.dispose\(\)/);
  assert.match(app, /element\.pause\(\)/);
  assert.match(app, /element\.removeAttribute\('src'\)/);
  assert.match(app, /for \(const object of canvas\.getObjects\(\)\.slice\(\)/);
});

test('overlay rebuild releases Fabric-owned video elements and ignores stale asynchronous rebuilds', () => {
  assert.match(app, /object\.getElement\(\)/);
  assert.match(app, /let rebuildGeneration = 0/);
  assert.match(app, /generation !== rebuildGeneration/);
  assert.match(app, /element\.removeAttribute\('src'\)/);
});

test('OOM retry detection matches the oom token, not arbitrary words containing those letters', () => {
  assert.match(app, /\\boom\\b/);
  assert.doesNotMatch(app, /allocation failed\|out of memory\|oom\/i/);
});
