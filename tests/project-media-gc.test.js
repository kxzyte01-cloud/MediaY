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
  assert.match(gc, /localStorage\.getItem\('pmy-templates'\)/);
  assert.match(gc, /template\.pre, template\.post, template\.overlays, template\.audio/);
  assert.match(gc, /template\.slotClip\.mediaId/);
  assert.match(gc, /saved templates could not be read/);
  assert.match(gc, /saved template is damaged/);
  assert.match(gc, /await db\.projects\.toArray\(\)/);
  assert.match(gc, /typeof undoStack !== 'undefined'/);
  assert.match(gc, /typeof redoStack !== 'undefined'/);
  assert.match(gc, /undo\/redo snapshot could not be read/);
  assert.match(gc, /undo\/redo snapshot has an unsupported state shape/);
  assert.match(gc, /\[state\.main, state\.audio, state\.overlays\]/);
  assert.match(gc, /referenced\.add\(item\.mediaId\)/);
  assert.match(gc, /return 0; \/\/ Unknown references must never cause user media to be deleted/);
  assert.match(gc, /!Array\.isArray\(state\.main\)/);
  assert.match(gc, /!Array\.isArray\(state\.audio\)/);
  assert.match(gc, /!Array\.isArray\(state\.overlays\)/);
  assert.match(gc, /db\.media\.bulkDelete\(orphanIds\)/);
  assert.match(gc, /URL\.revokeObjectURL\(urls\[id\]\)/);
  assert.match(gc, /delete files\[id\]/);
  assert.match(gc, /delete decoded\[id\]/);
  assert.match(gc, /delete thumbs\[id\]/);
  assert.match(gc, /delete audioLoads\[id\]/);
  assert.doesNotMatch(gc, /dropMediaCaches\(\)/);
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

test('clip and template deletion schedule debounced, export-safe media collection', () => {
  assert.match(setup, /function scheduleMediaGc\(\)/);
  assert.match(setup, /window\.scheduleMediaGc = scheduleMediaGc/);
  assert.match(setup, /exportInProgress/);
  assert.match(setup, /captionRunning/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(app, /if \(typeof window\.scheduleMediaGc === 'function'\) window\.scheduleMediaGc\(\)/);
  assert.match(app, /Delete template[\s\S]{0,300}scheduleMediaGc/);
  assert.match(app, /historyWillReleaseMedia = undoStack\.length >= 50 \|\| redoStack\.length > 0/);
  assert.match(app, /historyWillReleaseMedia[\s\S]{0,180}window\.scheduleMediaGc\(\)/);
});

test('malformed template references produce an actionable visible cleanup warning', () => {
  assert.match(setup, /Storage cleanup skipped because saved templates could not be read/);
  assert.match(setup, /Storage cleanup skipped because a saved template is damaged/);
  assert.match(setup, /if \(typeof say === 'function'\) say\(warning\)/);
});


test('damaged template storage exposes an explicit reset that preserves projects and imported media', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="tplReset"[^>]*hidden/);
  assert.match(app, /function templateStorageIsDamaged\(\)/);
  assert.match(app, /templates\.some\(template =>[\s\S]*!Array\.isArray\(template\.audio\)/);
  assert.match(app, /localStorage\.removeItem\(TPLKEY\)/);
  assert.match(app, /does not delete projects or imported media/);
  assert.match(app, /window\.scheduleMediaGc\(\)/);
});
