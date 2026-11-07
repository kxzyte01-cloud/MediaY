'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('caption commit checks cancellation immediately before committing staged overlays', () => {
  const start = app.indexOf('async function commitCaptionDrafts(drafts)');
  const end = app.indexOf('\nasync function ', start + 1);
  assert.ok(start >= 0 && end > start, 'caption commit function must exist');
  const commit = app.slice(start, end);
  const cancel = commit.lastIndexOf('if (captionCancelRequested) throw abortCaption();');
  const restack = commit.indexOf('restack();');
  const persist = commit.indexOf('await saveProject();');
  assert.ok(persist >= 0 && cancel > persist, 'cancellation must be checked after persistence verification');
  assert.ok(restack > cancel, 'cancellation check must occur before timeline commit');
  assert.ok(commit.indexOf('commit();', cancel) > cancel, 'cancelled captions must not be committed');
  assert.match(commit, /for \(const id of built\)[\s\S]*disposeOverlayObject/,
    'staged overlay objects must be disposed when cancellation aborts the commit');
});
