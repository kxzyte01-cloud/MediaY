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
