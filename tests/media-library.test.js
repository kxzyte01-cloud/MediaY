'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'built.yml'), 'utf8');

test('MediaY exposes an in-app Recent, Videos and Photos library without requesting access at launch', () => {
  assert.match(html, /id="mediaLibraryDialog"/);
  assert.match(html, /data-media-kind="all"/);
  assert.match(html, /data-media-kind="videos"/);
  assert.match(html, /data-media-kind="images"/);
  assert.match(html, /id="mediaLibrarySystemPicker"/);
  const open = app.slice(app.indexOf('async function openMediaLibrary'), app.indexOf("$('importBtn').onclick", app.indexOf('async function openMediaLibrary')));
  assert.match(open, /plugin\.requestMediaAccess\(\{ kind \}\)/);
  assert.match(app, /\$\('importBtn'\)\.onclick = \(\) => openMediaLibrary\('all'\)/);
  assert.doesNotMatch(app.slice(0, app.indexOf('async function openMediaLibrary')), /requestMediaAccess\(\)/,
    'broad media permission must be requested only after the user opens the library');
});

test('Android native media library requests version-appropriate image/video permissions including Android 14 partial access', () => {
  assert.match(workflow, /@Permission\(alias = "mediaImages", strings = \{ Manifest\.permission\.READ_MEDIA_IMAGES \}\)/);
  assert.match(workflow, /@Permission\(alias = "mediaVideos", strings = \{ Manifest\.permission\.READ_MEDIA_VIDEO \}\)/);
  assert.match(workflow, /@Permission\(alias = "selectedVisualMedia", strings = \{ Manifest\.permission\.READ_MEDIA_VISUAL_USER_SELECTED \}\)/);
  assert.match(workflow, /if \(!images && \("all"\.equals\(kind\) \|\| "images"\.equals\(kind\)\)\) missing\.add\("mediaImages"\)/);
  assert.match(workflow, /if \(!videos && \("all"\.equals\(kind\) \|\| "videos"\.equals\(kind\)\)\) missing\.add\("mediaVideos"\)/);
  assert.match(workflow, /requestPermissionForAlias\("legacyRead"/);
  assert.match(workflow, /call\.getString\("kind"\)/);
  assert.match(workflow, /missing\.add\("selectedVisualMedia"\)/);
  assert.match(workflow, /state\.put\("partial", \(images \|\| videos \|\| selected\) && !\(images && videos\)\)/);
});

test('native media browsing is paginated and stages content URIs through ContentResolver', () => {
  assert.match(workflow, /public void listMedia\(PluginCall call\)/);
  assert.match(workflow, /MediaStore\.Files\.getContentUri\("external"\)/);
  assert.match(workflow, /Math\.max\(1, Math\.min\(80/);
  assert.match(workflow, /DATE_ADDED \+ " DESC"/);
  assert.match(workflow, /resolver\.loadThumbnail\(uri, new Size\(180, 180\), null\)/);
  assert.match(workflow, /public void stageMedia\(PluginCall call\)/);
  assert.match(workflow, /getContentResolver\(\)\.openInputStream\(Uri\.parse\(uriValue\)\)/);
  assert.match(workflow, /private (?:static )?void copy\(InputStream input, OutputStream output\)/);
  assert.match(workflow, /public void deleteStagedMedia\(PluginCall call\)/);
  assert.match(workflow, /cache\.equals\(staged\.getParentFile\(\)\)/,
    'staged-file cleanup must be confined to MediaY cache files');
  assert.match(app, /plugin\.listMedia\(\{ kind: mediaLibraryKind, offset: mediaLibraryOffset, limit: 36 \}\)/);
  assert.match(app, /plugin\.stageMedia\(\{ uri: item\.uri/);
  assert.match(app, /window\.Capacitor\.convertFileSrc\(staged\.path\)/);
  assert.match(app, /plugin\.deleteStagedMedia\(\{ path: staged\.path \}\)/);
});

test('native media plugin is registered in the generated Android activity', () => {
  assert.match(workflow, /registerPlugin\(MediaYMediaStorePlugin\.class\)/);
  assert.match(workflow, /android\.permission\.READ_MEDIA_VISUAL_USER_SELECTED/);
});
