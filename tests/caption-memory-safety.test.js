'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('large caption sources use bounded 10-minute file-backed windows', () => {
  assert.match(app, /CAPTION_STREAM_WINDOW_SECONDS = 10 \* 60/);
  assert.match(app, /CAPTION_STREAM_MAX_SECONDS = 4 \* 60 \* 60/);
  assert.match(app, /shouldStreamCaptionSource\(sourceFile, source\)/);
  assert.match(app, /for await \(const windowData of streamCaptionPcmWindows\(/);
  assert.match(app, /engine\.mount\(workerFs, \{ blobs: \[\{ name: inputName, data: file \}\] \}, mountDir\)/);
  assert.match(app, /yield \\{ pcm: normalizedPcm, offsetSeconds/);
});

test('windowed decode does not use invalid compressed-byte slicing or retain all PCM windows', () => {
  const start = app.indexOf('async function* streamCaptionPcmWindows');
  const end = app.indexOf('async function transcribeCaptionPcmWithFallback', start);
  assert.ok(start >= 0 && end > start, 'windowed decoder must be present');
  const decoder = app.slice(start, end);
  assert.doesNotMatch(decoder, /file\.slice\s*\(/);
  assert.doesNotMatch(decoder, /windowChunks|totalSamples\s*\+?=/);
  assert.match(decoder, /await engine\.deleteFile\(outputName\)/);
  assert.match(decoder, /await engine\.unmount\(mountDir\)/);
  assert.match(decoder, /WORKERFS/);
});

test('each streamed caption window is transcribed before its PCM buffer is released', () => {
  assert.match(app, /const windowSource = \{ \.\.\.source, start: \(Number\(source\.start\) \|\| 0\) \+ windowData\.offsetSeconds \/ speed \}/);
  assert.match(app, /await transcribeCaptionPcmWithFallback\(windowData\.pcm, windowSource/);
  assert.match(app, /windowData\.pcm = null/);
  assert.match(app, /decodeComplete = true/);
});

test('the global fallback helper does not reach into the capGo handler local scope', () => {
  const start = app.indexOf('async function transcribeCaptionPcmWithFallback');
  const end = app.indexOf('async function commitCaptionDrafts', start);
  assert.ok(start >= 0 && end > start);
  const helper = app.slice(start, end);
  assert.doesNotMatch(helper, /captionMetric/);
});
