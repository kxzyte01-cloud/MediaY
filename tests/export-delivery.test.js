const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'built.yml'), 'utf8');

test('Android export saves to Movies/MediaY before offering a share fallback', () => {
  const start = app.indexOf('async function saveVideo');
  const end = app.indexOf('// Native Android builds register this plugin', start);
  assert.ok(start >= 0 && end > start, 'saveVideo implementation must exist');
  const save = app.slice(start, end);
  const deviceSave = save.indexOf('MediaYMediaStore.saveVideo');
  const deviceResult = save.indexOf("method: 'device'");
  const fallbackShare = save.indexOf('Share.share');
  assert.ok(deviceSave >= 0, 'Android direct-save plugin call must exist');
  assert.ok(deviceResult > deviceSave, 'successful device save must be reported');
  assert.ok(fallbackShare > deviceResult, 'sharing may only be a fallback after direct saving');
  assert.match(save, /location:.*Movies\/MediaY/);
  assert.doesNotMatch(app, /pendingExportShare/, 'successful background exports must not queue an automatic share sheet');
});

test('Android build registers a MediaStore plugin that publishes MP4s to public Movies/MediaY', () => {
  assert.match(workflow, /registerPlugin\(MediaYMediaStorePlugin\.class\)/);
  assert.match(workflow, /MediaStore\.Video\.Media\.RELATIVE_PATH/);
  assert.match(workflow, /Environment\.DIRECTORY_MOVIES \+ "\/MediaY"/);
  assert.match(workflow, /MediaStore\.Video\.Media\.IS_PENDING/);
});
