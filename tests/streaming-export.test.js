const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const app = read('app.js');
const wrapper = read('vendor/ffmpeg/ffmpeg.js');
const worker = read('vendor/ffmpeg/814.ffmpeg.js');
const workflow = read('.github/workflows/built.yml');

test('native export reads FFmpeg output in bounded worker chunks', () => {
  assert.match(app, /async function saveFFmpegOutput\\(engine, outputPath\\)/);
  assert.match(app, /engine\\.readFileChunk\\(outputPath, offset, CHUNK_BYTES\\)/);
  assert.match(app, /nativeStore\\.appendStreamingChunk\\(\\{ data: btoa\\(binary\\) \\}\\)/);
  const nativePath = app.slice(app.indexOf('async function saveFFmpegOutput'), app.indexOf('// Native Android builds register'))
    .split('if (!nativeStore')[0];
  assert.doesNotMatch(nativePath, /readFile\\(outputPath\\)/);
  assert.match(wrapper, /readFileChunk=/);
  assert.match(worker, /case t\\.READ_FILE_CHUNK/);
});

test('Android MediaStore streaming export publishes only after all chunks are written', () => {
  const begin = workflow.indexOf('public synchronized void beginStreamingSave');
  const append = workflow.indexOf('public synchronized void appendStreamingChunk');
  const finish = workflow.indexOf('public synchronized void finishStreamingSave');
  assert.ok(begin >= 0 && append > begin && finish > append);
  const section = workflow.slice(begin, workflow.indexOf('public void saveVideo(PluginCall call)', finish));
  assert.match(section, /MediaStore\\.Video\\.Media\\.IS_PENDING, 1/);
  assert.match(section, /MediaStore\\.Video\\.Media\\.IS_PENDING, 0/);
  assert.match(section, /abortStreamingSaveInternal\\(\\)/);
  assert.match(section, /4 \\* 1024 \\* 1024/);
});

test('build workflow uses read-only contents permission and isolates release write permission', () => {
  assert.match(workflow, /^permissions:\\n  contents: read/m);
  assert.match(workflow, /  build:\\n    permissions:\\n      contents: read/);
  assert.match(workflow, /  publish-release:[\\s\\S]*?permissions:\\n      contents: write/);
  assert.match(workflow, /actions\\/download-artifact@v4/);
});

test('FFmpeg worker range reads return exact offsets and end-of-file metadata', async () => {
  const bytes = new TextEncoder().encode('abcdefghij');
  const messages = [];
  const fakeFS = {
    stat: () => ({ size: bytes.length }),
    open: filePath => ({ path: filePath }),
    read: (stream, target, targetOffset, length, position) => {
      const count = Math.max(0, Math.min(length, bytes.length - position));
      target.set(bytes.subarray(position, position + count), targetOffset);
      return count;
    },
    close: () => {}
  };
  const self = {
    postMessage: message => messages.push(message),
    createFFmpegCore: async () => ({
      FS: fakeFS,
      setLogger: () => {},
      setProgress: () => {}
    })
  };
  const context = {
    self,
    importScripts: () => {},
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    Uint8Array, Math, Number, Error, Promise, JSON
  };
  vm.runInNewContext(worker, context);
  await self.onmessage({ data: { id: 1, type: 'LOAD', data: { coreURL: 'core.js', wasmURL: 'core.wasm' } } });
  await self.onmessage({ data: { id: 2, type: 'READ_FILE_CHUNK', data: { path: 'final.mp4', offset: 5, length: 4 } } });
  await self.onmessage({ data: { id: 3, type: 'READ_FILE_CHUNK', data: { path: 'final.mp4', offset: 8, length: 4 } } });
  const first = messages.find(message => message.id === 2).data;
  const last = messages.find(message => message.id === 3).data;
  assert.equal(new TextDecoder().decode(first.data), 'fghi');
  assert.equal(first.bytesRead, 4);
  assert.equal(first.fileSize, 10);
  assert.equal(first.eof, false);
  assert.equal(new TextDecoder().decode(last.data), 'ij');
  assert.equal(last.bytesRead, 2);
  assert.equal(last.eof, true);
});
