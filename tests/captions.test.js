'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = app.indexOf('async function transcribeChunk');
const end = app.indexOf('async function captionFrom', start);
assert.ok(start >= 0 && end > start, 'transcribeChunk implementation must exist');
const source = app.slice(start, end);

test('Whisper uses its default transcription task unless translation is requested', () => {
  assert.match(source, /\.\.\.\(\$\('capTr'\)\.checked\s*\s*\?\s*\(lang\s*\?\s*\{\s*task:\s*'translate'\s*\}\s*:\s*\{\s*forced_decoder_ids:\s*\[\[1,\s*null\],\s*\[2,\s*50358\]\]\s*\}\)\s*:\s*\{\s*\}\)/);
  assert.doesNotMatch(source, /task:\s*\$\('capTr'\)\.checked\s*\?\s*'translate'\s*:\s*'transcribe'/);
});

test('selected language is still passed to Whisper when explicitly chosen', () => {
  assert.match(source, /\.\.\.\(lang\s*\?\s*\{\s*language:\s*lang\s*\}\s*:\s*\{\s*\}\)/);
});


test('Whisper word-level DTW is disabled for the bundled tiny model', () => {
  assert.match(app, /let asrWordTimestamps = false/);
});

test('WebGPU speech inference selects explicit encoder and decoder precision', () => {
  assert.match(app, /options\.dtype = \{ encoder_model: 'fp32', decoder_model_merged: 'q4' \}/);
});

test('quiet selected audio is peak-normalized without amplifying near-silence', () => {
  assert.match(app, /function normalizeQuietCaptionAudio\(pcm\)/);
  assert.match(app, /peak > 0\.006 && peak < 0\.5/);
  assert.match(app, /Math\.min\(12, 0\.8 \/ peak\)/);
});


test('an explicitly selected audio track is the only caption source', () => {
  assert.match(app, /const candidates = audioSelection \? \[audioCandidate\(audioSelection\)\]/);
});

test('an explicitly selected video clip does not silently switch to another lane', () => {
  assert.match(app, /explicitVideo \? \[videoCandidate\(explicitVideo\)\]/);
});

test('with no selection, separate audio tracks remain fallback sources after main video clips', () => {
  assert.match(app, /\[\.\.\.S\.main\.map\(videoCandidate\), \.\.\.S\.audio\.map\(audioCandidate\)\]/);
});


test('caption diagnostics record decoded audio format and signal measurements without storing transcript text', () => {
  assert.match(app, /function captionPcmStats\(pcm\)/);
  assert.match(app, /sampleRate: inputRate, channels: buf\.numberOfChannels/);
  assert.match(app, /Object\.assign\(sourceDiagnostic, captionPcmStats\(pcm\)\)/);
  assert.match(app, /speechVoicedRatio:/);
  assert.match(app, /chunksSentToWhisper\+\+/);
  assert.match(app, /rawWhisperSegments \+= \(result\.chunks \|\| \[\]\)\.length/);
  assert.match(app, /captionMetric\.note\('sourceDiagnostics', sourceDiagnostics\)/);
  assert.doesNotMatch(app, /sourceDiagnostic\.rawText\s*=|sourceDiagnostic\.transcript\s*=/);
});
