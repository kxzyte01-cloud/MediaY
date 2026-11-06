'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('windowed caption transcription decodes overlap but commits each caption in one ownership window', () => {
  assert.match(app, /CAPTION_STREAM_OVERLAP_SECONDS = 1\.5/);
  assert.match(app, /Core\.planCaptionStreamWindows\(clipLength, CAPTION_STREAM_WINDOW_SECONDS, CAPTION_STREAM_OVERLAP_SECONDS\)/);
  assert.match(app, /windowData\.ownershipStartSeconds/);
  assert.match(app, /windowData\.ownershipEndSeconds/);
  assert.match(app, /const ownedDrafts = windowDrafts\.filter/);
  assert.match(app, /drafts\.push\(\.\.\.ownedDrafts\)/);
  assert.match(app, /sourceDiagnostic\.decodedAudioSeconds/);
});
