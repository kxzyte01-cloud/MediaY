'use strict';
// Unit tests for mediay-fast.js that need no browser: MP4 parsing, Annex B conversion and the planning maths.
// The MP4 fixtures are generated with ffmpeg (skipped when ffmpeg is not installed).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Fast = require('../mediay-fast.js');

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediay-fast-'));
const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(cmd + ' failed: ' + r.stderr); return r.stdout; };
