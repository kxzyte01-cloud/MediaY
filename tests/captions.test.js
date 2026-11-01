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
  assert.match(source, /\.\.\.\(\$\('capTr'\)\.checked\s*\?\s*\{\s*task:\s*'translate'\s*\}\s*:\s*\{\s*\}\)/);
  assert.doesNotMatch(source, /task:\s*\$\('capTr'\)\.checked\s*\?\s*'translate'\s*:\s*'transcribe'/);
});

test('selected language is still passed to Whisper when explicitly chosen', () => {
  assert.match(source, /\.\.\.\(lang\s*\?\s*\{\s*language:\s*lang\s*\}\s*:\s*\{\s*\}\)/);
});
