'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('history autosave is debounced and reports storage failures without losing editor state', () => {
  const start = app.indexOf('function scheduleProjectSave()');
  const end = app.indexOf('function commit()', start);
  assert.ok(start >= 0 && end > start, 'shared autosave helper must exist');
  const helper = app.slice(start, end);
  assert.match(helper, /clearTimeout\(saveTimer\)/);
  assert.match(helper, /setTimeout\(/);
  assert.match(helper, /\), 800\)/);
  assert.match(helper, /saveProject\(\)\.catch/);
  assert.match(helper, /Auto-save failed/);
});

test('normal edit commits schedule persistence and retain bounded undo history', () => {
  const start = app.indexOf('function commit()');
  const end = app.indexOf('function normalizeState', start);
  assert.ok(start >= 0 && end > start);
  const commit = app.slice(start, end);
  assert.match(commit, /undoStack\.push\(snap\(\)\)/);
  assert.match(commit, /undoStack\.length > 50/);
  assert.match(commit, /redoStack = \[\]/);
  assert.match(commit, /scheduleProjectSave\(\)/);
});

test('undo and redo schedule persistence only after the restored state is applied', () => {
  const undoStart = app.indexOf("$('undoBtn').onclick");
  const redoStart = app.indexOf("$('redoBtn').onclick", undoStart);
  const saveStart = app.indexOf('async function saveProject()', redoStart);
  assert.ok(undoStart >= 0 && redoStart > undoStart && saveStart > redoStart);
  const undo = app.slice(undoStart, redoStart);
  const redo = app.slice(redoStart, saveStart);
  assert.match(undo, /await restore\(undoStack\[undoStack\.length - 1\]\)/);
  assert.match(undo, /await restore[\s\S]*scheduleProjectSave\(\)/);
  assert.match(redo, /await restore\(s\)/);
  assert.match(redo, /await restore[\s\S]*scheduleProjectSave\(\)/);
  assert.match(undo, /if \(undoStack\.length < 2\) return/);
  assert.match(redo, /if \(!redoStack\.length\) return/);
});
