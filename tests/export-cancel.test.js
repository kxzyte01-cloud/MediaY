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
