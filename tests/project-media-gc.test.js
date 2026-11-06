'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const setup = fs.readFileSync(path.join(__dirname, '..', 'setup.js'), 'utf8');

test('project media GC saves current state and retains every media reference across all projects', () => {
  const start = setup.indexOf('async function collectUnreferencedMedia()');
  const end = setup.indexOf('async function deleteSavedProject', start);
  assert.ok(start >= 0 && end > start);
  const gc = setup.slice(start, end);
  assert.match(gc, /await saveProject\(\)/);
  assert.match(gc, /await db\.projects\.toArray\(\)/);
  assert.match(gc, /\[state\.main, state\.audio, state\.overlays\]/);
  assert.match(gc, /referenced\.add\(item\.mediaId\)/);
  assert.match(gc, /return 0; \/\/ Unknown references must never cause user media to be deleted/);
  assert.match(gc, /!Array\.isArray\(state\.main\)/);
  assert.match(gc, /!Array\.isArray\(state\.audio\)/);
  assert.match(gc, /!Array\.isArray\(state\.overlays\)/);
  assert.match(gc, /db\.media\.bulkDelete\(orphanIds\)/);
  assert.match(gc, /URL\.revokeObjectURL\(urls\[id\]\)/);
  assert.match(gc, /delete files\[id\]/);
});

test('deleting a named project invokes best-effort cleanup without deleting shared media', () => {
  const start = setup.indexOf('async function deleteSavedProject');
  const end = setup.indexOf('async function renderProjectLibrary', start);
  assert.ok(start >= 0 && end > start);
  const deletion = setup.slice(start, end);
  assert.match(deletion, /await db\.projects\.delete\(id\)/);
  assert.match(deletion, /await collectUnreferencedMedia\(\)/);
  assert.match(deletion, /Media used by other projects will be kept/);
});
