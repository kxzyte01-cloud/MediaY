'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('overlay PNG rasterization scales to the selected export width', () => {
  assert.match(app, /async function overlayPNG\(o, outputWidth = canvas\.getWidth\(\)\)/);
  assert.match(app, /const multiplier = Math\.max\(1, Number\(outputWidth\) \/ Math\.max\(1, canvas\.getWidth\(\)\)\)/);
  assert.match(app, /canvas\.toDataURL\(\{ format: 'png', multiplier \}\)/);
});

test('both FFmpeg and WebCodecs export paths request output-resolution overlay PNGs', () => {
  assert.match(app, /overlayPNG\(overlay, W\)/);
  assert.match(app, /overlayPNG\(o, W\), W, H/);
});

test('WebCodecs frame-count mismatch declines the fast path before muxing', () => {
  assert.match(app, /sink\.frameCount !== chunkFrames/);
  assert.match(app, /using the FFmpeg fallback/);
});
