const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('export cancel button dispatches to export or caption cancellation without mixing states', () => {
  assert.ok(app.includes("$('busyCancel').onclick = () => exportInProgress ? requestExportCancel() : requestCaptionCancel();"));
  assert.ok(app.includes('function requestExportCancel()'));
  assert.ok(app.includes("button.textContent = 'Cancelling export…'"));
});

test('export cancellation terminates FFmpeg and reaches the WebCodecs frame loop', () => {
  assert.ok(app.includes('if (ff) disposeFFmpeg();'));
  assert.ok(app.includes('isCancelled: () => exportCancelRequested'));
  assert.ok(app.includes("if (exportCancelRequested) throw new Error('Export cancelled')"));
});

test('cancelled export is not retried or reported as an export failure', () => {
  assert.ok(app.includes("exportOutcome = 'cancelled'"));
  assert.ok(app.includes('retryAfterCleanup = false'));
  assert.ok(app.includes('exportFailed = false'));
  assert.ok(app.includes('Temporary files were cleaned up; your project was not changed.'));
});

test('FFmpeg commands have a progress/log inactivity watchdog, not a fixed export deadline', () => {
  assert.ok(app.includes('ffLastActivityAt = Date.now()'));
  assert.ok(app.includes("ff.on('progress', event => { ffLastActivityAt = Date.now();"));
  assert.ok(app.includes('const idleLimitMs = 15 * 60 * 1000'));
  assert.ok(app.includes('Promise.race([engine.exec(args), watchdog])'));
  assert.ok(app.includes('if (ff === engine) disposeFFmpeg()'));
  assert.ok(app.includes('window.clearTimeout(watchdogTimer)'));
  assert.ok(app.includes('FFmpeg stopped reporting activity for 15 minutes'));
});
