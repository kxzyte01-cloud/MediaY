// Run with: node --test tests/
// Verifies the caption timing logic against synthetic speech whose true timing is known exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../mediay-core.js');

const SR = 16000;
// Deterministic "speech": noise bursts (words) with known start/end, separated by pauses, over a faint noise floor.
function makeSpeech(words, seconds, seed = 7) {
  let state = seed;
  const rand = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5;
  const pcm = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < pcm.length; i++) pcm[i] = rand() * 0.004;
  for (const w of words) {
    const a = Math.round(w.start * SR), b = Math.min(pcm.length, Math.round(w.end * SR));
    for (let i = a; i < b; i++) {
      const env = Math.sin(Math.PI * (i - a) / (b - a)) ** 0.5;
      pcm[i] += rand() * 1.2 * env * Math.sin(2 * Math.PI * 180 * i / SR + 1);
    }
  }
  return pcm;
}
// Three sentences, 4 words each, 0.9 s of silence between sentences.
function buildScript() {
  const words = []; let t = 0.7;
  const sentences = [['The', 'city', 'council', 'approved'], ['new', 'roads', 'and', 'schools'], ['Residents', 'say', 'thanks', 'today']];
  const segs = [];
  for (const s of sentences) {
    const start = t;
    for (const text of s) { const len = 0.2 + text.length * 0.05; words.push({ text, start: t, end: t + len }); t += len + 0.06; }
    segs.push({ text: s.join(' '), start, end: t - 0.06 });
    t += 0.9;
  }
  return { words, segs, seconds: t + 0.5 };
}
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

test('speech activity finds each sentence', () => {
  const { words, seconds } = buildScript();
  const activity = Core.analyzeSpeechActivity(makeSpeech(words, seconds), SR);
  assert.equal(activity.reliable, true);
  assert.equal(activity.intervals.length, 3);
  assert.ok(Math.abs(activity.intervals[0][0] - words[0].start) < 0.08);
});

test('noise-only or constant audio is reported unreliable so the model timestamps are kept', () => {
  let s = 3; const pcm = new Float32Array(SR * 10);
  for (let i = 0; i < pcm.length; i++) pcm[i] = ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5) * 0.5;
  assert.equal(Core.analyzeSpeechActivity(pcm, SR).reliable, false);
  assert.equal(Core.analyzeSpeechActivity(new Float32Array(SR * 5), SR).reliable, false);
  assert.equal(Core.analyzeSpeechActivity(new Float32Array(10), SR).reliable, false);
});

test('captions start where speech starts even when the model timestamps are 0.4 s early and 0.6 s late', () => {
  const { words, segs, seconds } = buildScript();
  const duration = seconds;
  const activity = Core.analyzeSpeechActivity(makeSpeech(words, seconds), SR);
  const wrong = segs.map(s => ({ text: s.text, start: Math.max(0, s.start - 0.4), end: s.end + 0.6 }));
  const lines = Core.buildCaptionLines(wrong, activity, duration);
  assert.equal(lines.length, 3);
  const errors = lines.map((line, i) => Math.abs(line.start - words[i * 4].start));
  assert.ok(median(errors) < 0.12, `median start error ${median(errors)}`);
  assert.ok(Math.max(...errors) < 0.3, `max start error ${Math.max(...errors)}`);
  // The old behaviour (trust the model) would have been off by the full 0.4 s:
  assert.ok(Math.abs(wrong[0].start - words[0].start) >= 0.39);
});

test('lines never overlap, stay inside the audio, and keep a minimum duration', () => {
  const { words, segs, seconds } = buildScript();
  const activity = Core.analyzeSpeechActivity(makeSpeech(words, seconds), SR);
  const lines = Core.buildCaptionLines(segs, activity, seconds);
  lines.forEach((line, i) => {
    assert.ok(line.start >= 0 && line.end <= seconds + 1e-9);
    assert.ok(line.end - line.start >= 0.03);
    if (lines[i + 1]) assert.ok(line.end <= lines[i + 1].start + 1e-9);
  });
});

test('model word times are blended with speech timing and still land on the right word', () => {
  const { words, seconds } = buildScript();
  const activity = Core.analyzeSpeechActivity(makeSpeech(words, seconds), SR);
  const biased = words.map(w => ({ text: w.text, start: w.start + 0.25, end: w.end + 0.25 }));
  const lines = Core.buildCaptionLines(Core.groupWordsIntoPhrases(biased), activity, seconds);
  const errors = lines.map((line, i) => Math.abs(line.start - words[i * 4].start));
  assert.ok(median(errors) < 0.12, `median ${median(errors)}`);
});

test('unreliable audio falls back to the model times and never crashes', () => {
  const lines = Core.buildCaptionLines([{ text: 'alpha beta gamma delta', start: 0, end: 1 }], { reliable: false, intervals: [] }, 5);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'alpha beta gamma delta');
  assert.ok(lines[0].start >= 0 && lines[0].end > lines[0].start);
  assert.deepEqual(Core.buildCaptionLines([], null, 5), []);
  assert.deepEqual(Core.buildCaptionLines([{ text: '[MUSIC]', start: 0, end: 2 }], null, 5), []);
  assert.equal(Core.buildCaptionLines([{ text: 'late', start: 1, end: NaN }], null, 5).length, 1); // missing end time
});

test('chunk planning cuts in a pause, never mid-speech, and never exceeds 30 s', () => {
  // 70 s: speech everywhere except a pause at 26–27.5 s and 54–55.5 s.
  const words = [];
  for (let t = 0.5; t < 69; t += 0.8) if (!((t > 26 && t < 27.5) || (t > 54 && t < 55.5))) words.push({ start: t, end: t + 0.5 });
  const activity = Core.analyzeSpeechActivity(makeSpeech(words, 70), SR);
  const plan = Core.planCaptionChunks(70, activity);
  assert.ok(plan.every(([a, b]) => b - a <= 30.0001));
  assert.equal(plan[0][0], 0); assert.equal(plan[plan.length - 1][1], 70);
  for (let i = 1; i < plan.length; i++) assert.equal(plan[i][0], plan[i - 1][1]); // contiguous, nothing dropped
  assert.ok(plan[0][1] > 26 && plan[0][1] < 27.5, `first cut ${plan[0][1]} should be inside the pause`);
  // Without usable speech information the old fixed 30-second windows are kept.
  assert.deepEqual(Core.planCaptionChunks(61, { reliable: false }), [[0, 30], [30, 60], [60, 61]]);
});

test('silent windows are not sent to the speech model', () => {
  const { words, seconds } = buildScript();
  const activity = Core.analyzeSpeechActivity(makeSpeech(words, seconds), SR);
  assert.equal(Core.hasSpeech(activity, words[0].start, words[3].end), true);
  assert.equal(Core.hasSpeech(activity, words[3].end + 0.1, words[3].end + 0.7), false);
  assert.equal(Core.hasSpeech({ reliable: false }, 0, 1), true); // unknown: let the model decide
});

test('source time maps onto the timeline using clip start and speed', () => {
  assert.equal(Core.sourceToTimeline(2, 10, 1), 12);
  assert.equal(Core.sourceToTimeline(2, 10, 2), 11);
  assert.equal(Core.sourceToTimeline(2, 10, 0.5), 14);
  assert.equal(Core.sourceToTimeline(2, 10, 0), 12); // invalid speed behaves as 1x
});

test('word grouping joins stray punctuation and breaks on pauses and sentence ends', () => {
  const phrases = Core.groupWordsIntoPhrases([
    { text: 'Hello', start: 1, end: 1.1 }, { text: 'there', start: 1.15, end: 1.4 }, { text: ',', start: 1.4, end: 1.45 },
    { text: 'friend.', start: 1.5, end: 1.9 }, { text: 'Again', start: 2.0, end: 2.3 }, { text: 'later', start: 5, end: 5.3 }
  ]);
  assert.deepEqual(phrases.map(p => p.text), ['Hello there, friend.', 'Again', 'later']);
});
