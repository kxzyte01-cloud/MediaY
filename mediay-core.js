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
    maxVoicedRatio: 0.98     // above this it is music/noise everywhere: do not trust it
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
    const low = percentile(sorted, 0.05), high = percentile(sorted, 0.95);
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

  /** Collapse pathological Whisper token-repetition loops (see FilmCraft crates/speech/src/whisper.rs `repeating`). */
  function stripRepeatingLoops(text) {
    const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 5) return tokens.join(' ');
    const norm = w => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const out = [];
    let i = 0;
    while (i < tokens.length) {
      let collapsed = false;
      for (let n = 1; n <= 6 && i + n * 4 <= tokens.length; n++) {
        const minReps = n === 1 ? 5 : 4;
        if (i + n * minReps > tokens.length) continue;
        const pat = tokens.slice(i, i + n).map(norm);
        if (pat.some(p => !p)) continue;
        let reps = 1;
        while (i + (reps + 1) * n <= tokens.length) {
          let match = true;
          for (let k = 0; k < n; k++) {
            if (norm(tokens[i + reps * n + k]) !== pat[k]) { match = false; break; }
          }
          if (!match) break;
          reps++;
        }
        if (reps >= minReps) {
          out.push(...tokens.slice(i, i + n));
          i += reps * n;
          collapsed = true;
          break;
        }
      }
      if (!collapsed) out.push(tokens[i++]);
    }
    return out.join(' ');
  }

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

  /** Merge mixed Whisper output without moving phrase segments across neighbouring word runs. */
  function mergeCaptionSegments(entries) {
    const ordered = (entries || []).filter(entry => entry && String(entry.text || '').trim())
      .map(entry => ({ ...entry, text: String(entry.text).trim() }));
    const output = [];
    let wordRun = [];
    const flushWords = () => {
      if (wordRun.length) output.push(...groupWordsIntoPhrases(wordRun));
      wordRun = [];
    };
    for (const entry of ordered) {
      if (entry.word) wordRun.push(entry);
      else { flushWords(); output.push({ text: entry.text, start: num(entry.start), end: Number.isFinite(Number(entry.end)) ? Number(entry.end) : NaN }); }
    }
    flushWords();
    return output;
  }

  /**
   * segments: [{ text, start, end }] in seconds relative to the same origin as `activity`.
   * Returns lines: [{ text, start, end }] — sorted, non-overlapping, inside [0,duration].
   */
  function buildCaptionLines(segments, activity, duration, opts = {}) {
    const cfg = { ...CAPTION, ...opts };
    const usable = activity && activity.reliable;
    const clean = (segments || [])
      .map(seg => ({
        text: stripRepeatingLoops(String(seg && seg.text || '').trim()),
        start: num(seg && seg.start, 0),
        end: seg && Number.isFinite(Number(seg.end)) ? Number(seg.end) : NaN,
        words: Array.isArray(seg && seg.words) ? seg.words : null
      }))
      .filter(seg => seg.text && !/^[\[(♪♫].*[\])♪♫]$/.test(seg.text) && !/^[♪♫\s]+$/.test(seg.text))
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
            // Tighten against pauses (FilmCraft vad.rs `split_at_pauses` / `trim_edges`):
            // 1) A tiny click/scrap before a >= 200ms pause prior to `s` is not the start of this segment.
            while (used.length > 1 && used[0][1] <= s + 0.05 && used[1][0] - used[0][1] >= 0.2 && used[0][1] - used[0][0] < 0.12) {
              used.shift();
            }
            // 2) When Whisper's contiguous segment end spills across a >= 200ms pause into the next segment's
            //    speech onset, end this segment at the pause so `previousEnd` does not push `next` late.
            if (next && used.length > 1) {
              const minExpectedSpeech = Math.min(0.25, tokens.length * 0.08);
              while (used.length > 1) {
                const lastInt = used[used.length - 1];
                const prevInt = used[used.length - 2];
                const pauseGap = lastInt[0] - prevInt[1];
                const speechBefore = used.slice(0, -1).reduce((acc, [a, b]) => acc + (b - a), 0);
                const rawContinuesIntoNext = activity.intervals.some(([ia, ib]) => ia <= lastInt[0] + 1e-4 && ib >= lastInt[1] - 1e-4 && ib > next.start + 0.05);
                if (pauseGap >= 0.2 && speechBefore >= minExpectedSpeech && (rawContinuesIntoNext || lastInt[0] >= Math.min(e, nextStart) - cfg.startSlackBefore)) {
                  used.pop();
                } else {
                  break;
                }
              }
            }
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
        let speechInterval = 0;
        if (voiced && voiced.length) {
          let remaining = (from + to) / 2;
          for (let intervalIndex = 0; intervalIndex < axis.length; intervalIndex++) {
            const intervalLength = axis[intervalIndex][1] - axis[intervalIndex][0];
            if (remaining <= intervalLength || intervalIndex === axis.length - 1) {
              speechInterval = intervalIndex;
              const [intervalStart, intervalEnd] = axis[intervalIndex];
              ws = clamp(ws, intervalStart, intervalEnd);
              we = clamp(we, intervalStart, intervalEnd);
              if (we - ws < 0.04) {
                const center = clamp((ws + we) / 2, intervalStart, intervalEnd);
                ws = Math.max(intervalStart, center - 0.02);
                we = Math.min(intervalEnd, Math.max(ws + 0.04, center + 0.02));
              }
              break;
            }
            remaining -= intervalLength;
          }
        }
        if (modelWords) {
          const ms = rs + (num(modelWords[i].start) - modelFrom) / modelSpan * (re - rs);
          const me = rs + (num(modelWords[i].end) - modelFrom) / modelSpan * (re - rs);
          ws = trust * ms + (1 - trust) * ws; we = trust * me + (1 - trust) * we;
        }
        words.push({ text: token, start: ws, end: Math.max(we, ws + 0.04), segmentIndex: index, speechInterval });
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
      if (prev && (word.segmentIndex !== prev.segmentIndex || word.speechInterval !== prev.speechInterval || word.start - prev.end > cfg.pauseBreakSeconds || current.length >= cfg.maxWords || chars > cfg.maxChars)) flush();
      current.push(word);
      if (/[.!?…]$/.test(word.text) && words[i + 1]) flush();
    });
    flush();

    // Final timing pass: lead-in, hold, no overlaps, no flicker between near-adjacent lines.
    lines.forEach(line => {
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

  const resampleTableCache = new Map();
  /** Windowed-sinc resampling with a cached polyphase table to suppress aliasing without per-sample trig overhead. */
  function resamplePcm(pcm, inputRate, outputRate) {
    if (!pcm || !pcm.length || !(inputRate > 0) || !(outputRate > 0)) return new Float32Array(0);
    if (inputRate === outputRate) return Float32Array.from(pcm);
    const ratio = inputRate / outputRate;
    const outputLength = Math.max(1, Math.round(pcm.length / ratio));
    const output = new Float32Array(outputLength);
    const radius = 12;
    const taps = radius * 2;
    const isIntRatio = Math.abs(ratio - Math.round(ratio)) < 1e-9;
    const PHASES = isIntRatio ? 1 : 512;
    const cacheKey = `${inputRate}:${outputRate}`;
    let table = resampleTableCache.get(cacheKey);
    if (!table) {
      const cutoff = Math.min(0.5, 0.5 / ratio) * 0.92;
      const sinc = x => Math.abs(x) < 1e-8 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      table = new Float32Array(PHASES * taps);
      for (let p = 0; p < PHASES; p++) {
        const frac = p / PHASES;
        const base = p * taps;
        let weightSum = 0;
        for (let k = 0; k < taps; k++) {
          const offset = k - radius + 1;
          const distance = offset - frac;
          const normalized = distance / radius;
          if (Math.abs(normalized) >= 1) continue;
          const win = 0.5 + 0.5 * Math.cos(Math.PI * normalized);
          const w = 2 * cutoff * sinc(2 * cutoff * distance) * win;
          table[base + k] = w;
          weightSum += w;
        }
        if (weightSum > 0) {
          const inv = 1 / weightSum;
          for (let k = 0; k < taps; k++) table[base + k] *= inv;
        }
      }
      resampleTableCache.set(cacheKey, table);
    }

    const pcmLen = pcm.length;
    const safeStart = Math.ceil(radius / ratio);
    const safeEnd = Math.min(outputLength, Math.floor((pcmLen - radius - 1) / ratio));
    for (let i = 0; i < outputLength; i++) {
      const position = i * ratio;
      const center = position | 0;
      const firstSample = center - radius + 1;
      if (i >= safeStart && i < safeEnd) {
        const base = isIntRatio ? 0 : Math.min(PHASES - 1, ((position - center) * PHASES + 0.5) | 0) * taps;
        output[i] =
          pcm[firstSample] * table[base] + pcm[firstSample + 1] * table[base + 1] +
          pcm[firstSample + 2] * table[base + 2] + pcm[firstSample + 3] * table[base + 3] +
          pcm[firstSample + 4] * table[base + 4] + pcm[firstSample + 5] * table[base + 5] +
          pcm[firstSample + 6] * table[base + 6] + pcm[firstSample + 7] * table[base + 7] +
          pcm[firstSample + 8] * table[base + 8] + pcm[firstSample + 9] * table[base + 9] +
          pcm[firstSample + 10] * table[base + 10] + pcm[firstSample + 11] * table[base + 11] +
          pcm[firstSample + 12] * table[base + 12] + pcm[firstSample + 13] * table[base + 13] +
          pcm[firstSample + 14] * table[base + 14] + pcm[firstSample + 15] * table[base + 15] +
          pcm[firstSample + 16] * table[base + 16] + pcm[firstSample + 17] * table[base + 17] +
          pcm[firstSample + 18] * table[base + 18] + pcm[firstSample + 19] * table[base + 19] +
          pcm[firstSample + 20] * table[base + 20] + pcm[firstSample + 21] * table[base + 21] +
          pcm[firstSample + 22] * table[base + 22] + pcm[firstSample + 23] * table[base + 23];
      } else {
        const phase = Math.min(PHASES - 1, Math.round((position - center) * PHASES));
        const base = phase * taps;
        let sum = 0, weightSum = 0;
        for (let k = 0; k < taps; k++) {
          const sample = firstSample + k;
          if (sample < 0 || sample >= pcmLen) continue;
          const w = table[base + k];
          sum += pcm[sample] * w;
          weightSum += w;
        }
        output[i] = weightSum > 0 ? sum / weightSum : 0;
      }
    }
    return output;
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
    analyzeSpeechActivity, planCaptionChunks, buildCaptionLines, groupWordsIntoPhrases, mergeCaptionSegments, hasSpeech, resamplePcm, sourceToTimeline, stripRepeatingLoops
  };
}));