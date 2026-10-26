/* MediaY core logic — pure functions with no DOM, no network and no global state.
   Loaded as a browser global (window.MediaYCore) and as a Node module (for tests).
   Everything here is deterministic so it can be verified automatically. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MediaYCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TIMELINE_FPS = 30;
  const MIN_FRAME = 1 / TIMELINE_FPS;
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ------------------------------------------------------------------
     1. Speech activity detection (energy based, adaptive, no model)
     ------------------------------------------------------------------ */
  const ACTIVITY = Object.freeze({
    hopSeconds: 0.02,        // 20 ms analysis frames
    closeGapSeconds: 0.15,   // bridge short pauses inside a phrase
    minRunSeconds: 0.06,     // ignore clicks/pops shorter than this
    minDynamicRangeDb: 14,   // below this the signal has no usable speech/noise contrast
    maxVoicedRatio: 0.92     // above this it is music/noise everywhere: do not trust it
  });

  function percentile(sortedAscending, q) {
    if (!sortedAscending.length) return 0;
    const i = clamp(Math.round(q * (sortedAscending.length - 1)), 0, sortedAscending.length - 1);
    return sortedAscending[i];
  }

  /** Returns { hop, frames, voiced:Uint8Array, intervals:[[s,e]...], reliable, thresholdDb, duration } */
  function analyzeSpeechActivity(pcm, sampleRate = 16000) {
    const hopSamples = Math.max(1, Math.round(sampleRate * ACTIVITY.hopSeconds));
    const frames = Math.floor((pcm ? pcm.length : 0) / hopSamples);
    const duration = pcm ? pcm.length / sampleRate : 0;
    const result = { hop: ACTIVITY.hopSeconds, frames, voiced: new Uint8Array(frames), intervals: [], reliable: false, thresholdDb: -60, duration, voicedRatio: 0 };
    if (frames < 5) return result;

    const db = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      const from = f * hopSamples;
      for (let i = from; i < from + hopSamples; i++) sum += pcm[i] * pcm[i];
      db[f] = 20 * Math.log10(Math.sqrt(sum / hopSamples) + 1e-9);
    }
    const sorted = Array.from(db).sort((a, b) => a - b);
    const low = percentile(sorted, 0.10), high = percentile(sorted, 0.95);
    result.dynamicRangeDb = high - low;
    // Threshold: above the noise floor, but always well below the loud speech level.
    const threshold = Math.min(Math.max(low + 10, -55), high - 18);
    result.thresholdDb = threshold;
    if (high < -50) return result; // essentially silent

    const raw = new Uint8Array(frames);
    for (let f = 0; f < frames; f++) raw[f] = db[f] > threshold ? 1 : 0;

    // 1) close short gaps, 2) drop short runs
    const closeFrames = Math.round(ACTIVITY.closeGapSeconds / ACTIVITY.hopSeconds);
    const minRun = Math.max(1, Math.round(ACTIVITY.minRunSeconds / ACTIVITY.hopSeconds));
    const runs = [];
    let start = -1;
    for (let f = 0; f <= frames; f++) {
      const on = f < frames && raw[f] === 1;
      if (on && start < 0) start = f;
      if (!on && start >= 0) { runs.push([start, f]); start = -1; }
    }
    const merged = [];
    for (const run of runs) {
      const last = merged[merged.length - 1];
      if (last && run[0] - last[1] <= closeFrames) last[1] = run[1];
      else merged.push([run[0], run[1]]);
    }
    let voicedFrames = 0;
    for (const [a, b] of merged) {
      if (b - a < minRun) continue;
      result.intervals.push([a * ACTIVITY.hopSeconds, b * ACTIVITY.hopSeconds]);
      for (let f = a; f < b; f++) result.voiced[f] = 1;
      voicedFrames += b - a;
    }
    result.voicedRatio = voicedFrames / frames;
    result.reliable = result.dynamicRangeDb >= ACTIVITY.minDynamicRangeDb &&
      result.voicedRatio <= ACTIVITY.maxVoicedRatio && result.intervals.length > 0;
    return result;
  }

  /* ------------------------------------------------------------------
     2. Silence-aware chunk planning for Whisper (max 30 s windows)
     ------------------------------------------------------------------ */
  /** Splits [0,total) into windows <= maxSeconds, preferring to cut in the middle of a pause. */
  function planCaptionChunks(totalSeconds, activity, opts = {}) {
    const maxS = opts.maxSeconds || 30, searchS = opts.searchSeconds || 8, minS = opts.minSeconds || 12;
    const plan = [];
    let start = 0;
    while (totalSeconds - start > maxS + 1e-6) {
      let cut = start + maxS;
      if (activity && activity.reliable) {
        // Look for the longest pause (unvoiced run) in [start+maxS-searchS, start+maxS].
        const lo = Math.max(start + minS, start + maxS - searchS), hi = start + maxS;
        let best = null;
        let gapStart = null;
        const f0 = Math.floor(lo / activity.hop), f1 = Math.min(activity.frames, Math.floor(hi / activity.hop));
        for (let f = f0; f <= f1; f++) {
          const silent = f < f1 && !activity.voiced[f];
          if (silent && gapStart === null) gapStart = f;
          if (!silent && gapStart !== null) {
            const len = f - gapStart;
            if (len >= 5 && (!best || len > best.len)) best = { from: gapStart, len };
            gapStart = null;
          }
        }
        if (best) cut = (best.from + best.len / 2) * activity.hop;
      }
      plan.push([start, cut]);
      start = cut;
    }
    if (totalSeconds - start > 1e-6) plan.push([start, totalSeconds]);
    return plan;
  }

  /* ------------------------------------------------------------------
     3. Caption alignment: ASR segments + speech activity -> timed lines
     ------------------------------------------------------------------ */
  const CAPTION = Object.freeze({
    maxWords: 4, maxChars: 30, pauseBreakSeconds: 0.55,
    startSlackBefore: 0.9, endSlackAfter: 0.9,
    lead: 0.04, hold: 0.14, minDuration: 0.45, bridgeGap: 0.3, wordTrust: 0.5
  });

  const wordWeight = w => Math.max(1, w.replace(/[^\p{L}\p{N}]/gu, '').length) + 0.6;

  function voicedWithin(activity, a, b) {
    const out = [];
    for (const [s, e] of activity.intervals) {
      if (e <= a) continue;
      if (s >= b) break;
      out.push([Math.max(s, a), Math.min(e, b)]);
    }
    return out;
  }

  function saneWordTimes(list) {
    let previous = -Infinity;
    for (const w of list) {
      const a = Number(w.start), b = Number(w.end);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b < a || a < previous - 0.05 || b - a > 4) return false;
      previous = a;
    }
    return true;
  }

  /** Joins model word-level output ([{text,start,end}]) into phrase segments at pauses and sentence ends. */
  function groupWordsIntoPhrases(wordList, opts = {}) {
    const gap = opts.gapSeconds || 0.35, maxWords = opts.maxWords || 14;
    const phrases = [];
    let cur = null;
    const cleaned = (wordList || []).map(w => ({ text: String(w.text || '').trim(), start: num(w.start), end: Number.isFinite(Number(w.end)) ? Number(w.end) : NaN }))
      .filter(w => w.text);
    cleaned.forEach((w, i) => {
      if (!Number.isFinite(w.end)) w.end = Math.max(w.start + 0.2, cleaned[i + 1] ? cleaned[i + 1].start : w.start + 0.4);
      if (/^[,.;:!?%…]+$/.test(w.text) && cur) { // stray punctuation token joins the previous word
        cur.words[cur.words.length - 1].text += w.text; cur.words[cur.words.length - 1].end = Math.max(cur.words[cur.words.length - 1].end, w.end);
        cur.text += w.text; cur.end = Math.max(cur.end, w.end); return;
      }
      if (cur && (w.start - cur.end > gap || cur.words.length >= maxWords || /[.!?…]["')\]]?$/.test(cur.words[cur.words.length - 1].text))) { phrases.push(cur); cur = null; }
      if (!cur) cur = { text: '', start: w.start, end: w.end, words: [] };
      cur.words.push({ text: w.text, start: w.start, end: w.end });
      cur.text = cur.words.map(x => x.text).join(' ');
      cur.end = Math.max(cur.end, w.end);
    });
    if (cur) phrases.push(cur);
    return phrases;
  }

  /** True when at least `minSeconds` of detected speech lies inside [a,b]. */
  function hasSpeech(activity, a, b, minSeconds = 0.25) {
    if (!activity || !activity.reliable) return true; // unknown: let the speech model decide
    let total = 0;
    for (const [s, e] of voicedWithin(activity, a, b)) total += e - s;
    return total >= minSeconds;
  }

  /** Map a position along the voiced axis (0..total) back to real time. */
  function voicedToTime(intervals, position) {
    let remaining = position;
    for (const [s, e] of intervals) {
      const len = e - s;
      if (remaining <= len) return s + remaining;
      remaining -= len;
    }
    return intervals.length ? intervals[intervals.length - 1][1] : 0;
  }

  /**
   * segments: [{ text, start, end }] in seconds relative to the same origin as `activity`.
   * Returns lines: [{ text, start, end }] — sorted, non-overlapping, inside [0,duration].
   */
  function buildCaptionLines(segments, activity, duration, opts = {}) {
    const cfg = { ...CAPTION, ...opts };
    const usable = activity && activity.reliable;
    const clean = segments
      .map(seg => ({ text: String(seg.text || '').trim(), start: num(seg.start, 0), end: Number.isFinite(Number(seg.end)) ? Number(seg.end) : NaN, words: Array.isArray(seg.words) ? seg.words : null }))
      .filter(seg => seg.text && !/^[\[(♪].*[\])♪]$/.test(seg.text))
      .sort((a, b) => a.start - b.start);

    const words = []; // { text, start, end, segmentIndex }
    let previousEnd = 0;
    clean.forEach((seg, index) => {
      const tokens = seg.text.split(/\s+/).filter(Boolean);
      if (!tokens.length) return;
      let s = clamp(seg.start, 0, duration);
      let e = Number.isFinite(seg.end) ? clamp(seg.end, s, duration) : Math.min(duration, s + tokens.length * 0.35);
      if (e - s < 0.05) e = Math.min(duration, s + Math.max(0.2, tokens.length * 0.25));
      const next = clean[index + 1];
      let rs = s, re = e, voiced = null;
      if (usable) {
        const windowStart = Math.max(previousEnd, s - cfg.startSlackBefore);
        const nextStart = next ? clamp(next.start, e, duration) : duration;
        const windowEnd = Math.min(duration, Math.min(e + cfg.endSlackAfter, Math.max(e, (e + nextStart) / 2 + 0.15)));
        const inside = voicedWithin(activity, windowStart, Math.max(windowStart, windowEnd));
        if (inside.length) {
          // The segment must actually overlap speech, otherwise keep the model's own times.
          const overlaps = inside.some(([a, b]) => b > s - 0.2 && a < e + 0.2);
          if (overlaps) {
            const used = inside.filter(([a, b]) => b > s - cfg.startSlackBefore && a < e + cfg.endSlackAfter);
            if (used.length) {
              rs = used[0][0];
              re = used[used.length - 1][1];
              voiced = voicedWithin(activity, rs, re);
            }
          }
        }
      }
      if (re - rs < 0.05) { rs = s; re = e; voiced = null; }
      previousEnd = re;

      // Speech-weighted positions: words share the detected speech time in proportion to their length.
      const weights = tokens.map(wordWeight);
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      const axis = voiced && voiced.length ? voiced : [[rs, re]];
      const axisLength = axis.reduce((a, [x, y]) => a + (y - x), 0);
      // Model word times (when supplied and sane) keep their relative spacing, fitted to the same start/end.
      const modelWords = seg.words && seg.words.length === tokens.length && saneWordTimes(seg.words) ? seg.words : null;
      const trust = modelWords ? clamp(num(cfg.wordTrust, 0.5), 0, 1) : 0;
      const modelFrom = modelWords ? num(modelWords[0].start) : 0;
      const modelSpan = modelWords ? Math.max(1e-3, num(modelWords[modelWords.length - 1].end) - modelFrom) : 1;
      let acc = 0;
      tokens.forEach((token, i) => {
        const from = acc / totalWeight * axisLength;
        acc += weights[i];
        const to = acc / totalWeight * axisLength;
        let ws = voicedToTime(axis, from), we = voicedToTime(axis, to);
        if (modelWords) {
          const ms = rs + (num(modelWords[i].start) - modelFrom) / modelSpan * (re - rs);
          const me = rs + (num(modelWords[i].end) - modelFrom) / modelSpan * (re - rs);
          ws = trust * ms + (1 - trust) * ws; we = trust * me + (1 - trust) * we;
        }
        words.push({ text: token, start: ws, end: Math.max(we, ws + 0.04), segmentIndex: index });
      });
    });

    // Group words into display lines. Break on pauses, on the word/char limit, and at segment ends.
    const lines = [];
    let current = [];
    const flush = () => {
      if (!current.length) return;
      lines.push({ text: current.map(w => w.text).join(' '), start: current[0].start, end: current[current.length - 1].end });
      current = [];
    };
    words.forEach((word, i) => {
      const prev = current[current.length - 1];
      const chars = current.reduce((a, w) => a + w.text.length + 1, 0) + word.text.length;
      if (prev && (word.start - prev.end > cfg.pauseBreakSeconds || current.length >= cfg.maxWords || chars > cfg.maxChars)) flush();
      current.push(word);
      if (/[.!?…]$/.test(word.text) && words[i + 1]) flush();
    });
    flush();

    // Final timing pass: lead-in, hold, no overlaps, no flicker between near-adjacent lines.
    lines.forEach((line, i) => {
      line.start = Math.max(0, line.start - cfg.lead);
      line.end = line.end + cfg.hold;
    });
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], next = lines[i + 1];
      if (next) {
        if (next.start - line.end < cfg.bridgeGap) line.end = Math.max(line.start + MIN_FRAME, next.start);
        if (line.end > next.start) line.end = next.start;
      }
      if (line.end - line.start < cfg.minDuration) {
        line.end = Math.min(next ? next.start : duration, line.start + cfg.minDuration);
      }
      line.end = Math.min(line.end, duration);
      if (line.end - line.start < MIN_FRAME) line.end = Math.min(duration, line.start + MIN_FRAME);
    }
    return lines.filter(l => l.end - l.start >= MIN_FRAME * 0.99 && l.start < duration);
  }

  /* ------------------------------------------------------------------
     4. Source time -> timeline time
     ------------------------------------------------------------------ */
  /** clip: { in, out, speed }, clipStart: where the clip begins on the timeline. */
  function sourceToTimeline(sourceRelativeSeconds, clipStart, speed) {
    const sp = num(speed, 1) > 0 ? num(speed, 1) : 1;
    return clipStart + sourceRelativeSeconds / sp;
  }


  return {
    TIMELINE_FPS, MIN_FRAME, ACTIVITY, CAPTION,
    analyzeSpeechActivity, planCaptionChunks, buildCaptionLines, groupWordsIntoPhrases, hasSpeech, sourceToTimeline
  };
}));
