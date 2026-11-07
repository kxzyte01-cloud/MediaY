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

test('failed Android cache appends remove the partially written MP4', () => {
  const start = app.indexOf('async function saveVideo');
  const end = app.indexOf('// Native Android builds register this plugin', start);
  const save = app.slice(start, end);
  const firstWrite = save.indexOf('await Filesystem.writeFile(options)');
  const markCreated = save.indexOf('cacheFileCreated = true', firstWrite);
  const append = save.indexOf('await Filesystem.appendFile(options)');
  const cleanup = save.lastIndexOf('if (cacheFileCreated) await Filesystem.deleteFile');
  assert.ok(firstWrite >= 0 && markCreated > firstWrite, 'cache creation must be recorded after the first successful write');
  assert.ok(append > markCreated, 'the partial cache must be marked before a later append can fail');
  assert.ok(cleanup > append, 'the catch path must delete a partial cache file');
});

test('Android build registers a MediaStore plugin that publishes MP4s to public Movies/MediaY', () => {
  assert.match(workflow, /registerPlugin\(MediaYMediaStorePlugin\.class\)/);
  assert.match(workflow, /MediaStore\.Video\.Media\.RELATIVE_PATH/);
  assert.match(workflow, /Environment\.DIRECTORY_MOVIES \+ "\/MediaY"/);
  assert.match(workflow, /MediaStore\.Video\.Media\.IS_PENDING/);
});


test('a completed render remains in FFmpeg storage after a delivery failure and can be retried', () => {
  assert.match(app, /let pendingExportSave = null/);
  assert.match(app, /pendingExportSave = \{ engine: ff, path: out \}/);
  assert.match(app, /if \(preserveOutputPath && name === preserveOutputPath\) continue/);
  assert.match(app, /async function retryPendingExportSave\(\)/);
  assert.match(app, /retry\.onclick = retryPendingExportSave/);
  assert.match(app, /pendingExportSave && pendingExportSave\.engine === ff/);
  assert.match(app, /error\.renderedData = data/);
  assert.match(app, /pendingExportSave = \{ engine: null, path: null, data: saveError\.renderedData \}/);
  assert.match(app, /pending\.data \? await saveVideo\(pending\.data\)/);
  assert.match(app, /if \(pending\.engine\) \{ try \{ await pending\.engine\.deleteFile\(pending\.path\)/);
  assert.match(app, /A completed render is waiting to be saved/);
});

test('Android notification uses a dedicated monochrome small icon and bounded idle heartbeat', () => {
  assert.match(workflow, /ic_stat_mediay\.xml/);
  assert.match(workflow, /builder\.setSmallIcon\(R\.drawable\.ic_stat_mediay\)/);
  assert.doesNotMatch(workflow, /builder\.setSmallIcon\(getApplicationInfo\(\)\.icon\)/);
  assert.match(workflow, /MAX_IDLE_MS = 15L \* 60L \* 1000L/);
  assert.match(workflow, /public void renew\(PluginCall call\)/);
  assert.match(app, /nativeExportServiceActive/);
  assert.match(app, /plugin\.renew\(\)/);
});

test('legacy Android export delivery writes FFmpeg output in bounded chunks', () => {
  const start = app.indexOf('async function saveFFmpegLegacyNative');
  const end = app.indexOf('async function saveFFmpegOutput', start);
  assert.ok(start >= 0 && end > start);
  const legacy = app.slice(start, end);
  assert.match(legacy, /engine\.readFileChunk\(outputPath, offset, CHUNK_BYTES\)/);
  assert.match(legacy, /Filesystem\.writeFile\(options\)/);
  assert.match(legacy, /Filesystem\.appendFile\(options\)/);
  assert.match(legacy, /nativeStore\.saveVideo\(\{ fileName: name \}\)/);
  assert.doesNotMatch(legacy, /engine\.readFile\(/);
});

test('legacy MediaStore save is serialized against streaming save operations', () => {
  assert.match(workflow, /private synchronized void saveVideoInternal\(PluginCall call\)/);
});
