'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const expected = {
  'fabric.min.js': 'uwRC1ppNRnMyD2ibxuFsBaDj8WzPv1UfOU2Qp+fPx3I=',
  'anime.min.js': 'tc4b48P1MPGS4PJXHRlChGCW1mEZy62jS/3JEsSHPzU=',
  'dexie.min.js': '2JhqFVK0mn2MsIWpLGaYWuvzuzO2Stb3uu0kYdm2R/8='
};

test('vendored editor libraries match their pinned SHA-256 SRI digests', () => {
  for (const [name, digest] of Object.entries(expected)) {
    const file = path.join(root, 'vendor', 'media-libraries', name);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64');
    assert.equal(actual, digest, name + ' integrity mismatch');
  }
});
