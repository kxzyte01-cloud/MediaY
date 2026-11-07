'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('caption text uses the editor system-font stack without an unbundled web-font dependency', () => {
  assert.match(app, /fontFamily: 'Avenir Next, Avenir, Segoe UI, system-ui, sans-serif'/);
  assert.doesNotMatch(app, /DM Sans|fonts\.googleapis\.com/);
  const start = app.indexOf('function ensureFontsReady()');
  const end = app.indexOf('// Reference-counted wrapper', start);
  assert.ok(start >= 0 && end > start);
  const ready = app.slice(start, end);
  assert.match(ready, /document\.fonts\.ready/);
  assert.doesNotMatch(ready, /document\.fonts\.load/);
  assert.match(ready, /setTimeout\(resolve, 800\)/);
});
