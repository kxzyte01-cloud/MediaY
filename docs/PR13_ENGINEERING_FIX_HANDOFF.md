# MediaY PR #13 — Engineering Fix Handoff

## Correct source baseline

- Repository: `kxzyte01-cloud/MediaY`
- PR #13: `design/coastline-premium-pr11`
- Exact baseline inspected: `4b084013da0103f6d2f3b48b1b96b2fe156ec7ba`
- Fix branch: `fix/pr13-caption-memory-safety`
- Fix branch currently contains the work described below. It is separate from PR #13's branch and from `main`.

The uploaded Gemini ZIP, uploaded Claude handoff, and uploaded PR patch were not the same repository snapshot. This work was therefore based on the exact GitHub PR #13 head, not on applying the patch to the ZIP.

## Changes made on the fix branch

### 1. Bounded large-audio caption decoding

`app.js` now routes a caption source to file-backed windowed decoding when either:

- the source file is larger than 96 MiB, or
- the selected audio range is longer than 10 minutes.

The decoder:

- uses 10-minute windows at 16 kHz mono float32;
- mounts the original File/Blob through FFmpeg WORKERFS instead of copying the whole compressed source into MEMFS;
- extracts one PCM window, deletes its temporary FFmpeg output, transcribes that window, and releases its PCM buffer before continuing;
- adjusts each window's timeline start so caption timing remains continuous across windows;
- checks cancellation between windows;
- limits one captioning pass to 4 hours and reports an actionable message above that limit.

The unsafe fallback that sliced arbitrary byte ranges from MP4/WebM was not added. Such byte slices are not reliable standalone media files. If WORKERFS is unavailable, large-file captioning now fails with an explicit compatibility message rather than silently trying an unsafe or memory-heavy path.

### 2. Regression tests

Added `tests/caption-memory-safety.test.js` to check that the large-file path uses bounded WORKERFS windows, does not retain an array of all PCM windows, does not use compressed-byte slicing, releases each window, and preserves the window's timeline offset.

Expanded `tests/export_integration.py`:

- Test 4 checks both delayed voice-over tracks independently and checks for silence in the gap.
- Test 6 checks reversed external audio-track insertion order and an overlong music track.
- Test 7 checks sub-second voiced → silent → voiced clips with overlapping fades and xfade transitions.

### 3. Logo consistency

- Updated the top-bar mark to use `favicon.svg`.
- Replaced `favicon.svg` with the neon cyan–violet–magenta aperture logo supplied in the Gemini package.
- Updated the icon generator so APK builds regenerate the PNG launcher icons from the same design instead of preserving stale legacy red icons.

## Verification status — do not overstate

The code changes have been committed to the separate fix branch, but the full GitHub Actions suite has **not** yet been run against this branch. The following are still required:

1. JavaScript syntax check and all Node tests, including the new caption-memory tests.
2. Browser smoke tests.
3. Real FFmpeg.wasm export integration tests 1–7.
4. A real large MP4/WebM caption test above 96 MiB and above 10 minutes, including cancellation and a multi-window timing check.
5. APK build and physical Android testing, especially memory use on a lower-RAM phone.

The implementation is intended to bound PCM memory to one 10-minute window at a time; that is not yet a claim of verified multi-hour Android performance.

## Scope and safety

- No changes to `main`.
- No merge performed.
- The existing PR #13 branch was not overwritten by this fix branch.
- No production signing or release publishing was performed.
