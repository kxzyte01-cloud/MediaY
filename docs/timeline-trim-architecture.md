# MediaY Timeline Trimming: Architecture and Release Gates

## Current model and user-facing behavior

MediaY currently models the main video lane as a serial list. A clip's timeline duration is derived from `(out - in) / speed`; changing that duration shifts every later main-lane clip because the lane has no explicit gap items. Audio clips and overlays are separate timed items with absolute `start` values. Those independent lanes do not move automatically when the main lane shrinks.

The playhead trim controls intentionally operate on the selected item:

- **From here** keeps the selected item's content from the playhead onward.
- **To here** keeps its content up to the playhead.
- Main video maps timeline time to source time using clip speed.
- Audio trims source `in/out` and adjusts `start` when its lead-in is removed.
- Image/text overlays adjust timeline `start/dur`.
- Video overlays also carry `sourceIn` and `srcDur`; preview seeking, FFmpeg input seeking, and overlay-audio mixing must use the same source-time mapping.
- Trims require at least one project frame (currently 1/30 second) on both sides, pause playback before mutation, and remain undoable/redoable.

This is not yet global ripple editing. Shortening a main clip moves later main clips earlier, while audio and overlays retain their absolute times. The UI and documentation must not imply otherwise.

## Non-negotiable invariants

1. **No invalid ranges.** Each trim must leave a valid, positive source range and at least one project frame on either side. Do not mutate state when validation fails.
2. **One time mapping per media type.** Keep timeline time and source-media time separate. Playback, thumbnails, preview, audio, and export must agree on the same mapping.
3. **One edit, one history entry.** A user action either commits completely as one Undo step or leaves the project unchanged.
4. **Stop playback before structural edits.** Do not let the playback loop and an edit concurrently change the playhead or selected source frame.
5. **Never confuse viewport state with edit state.** Programmatic timeline scrolling must not trigger a user scrub. The expected scroll change is ignored once; genuine user scrolling continues to seek.
6. **Preserve source offsets.** When an overlay's timeline start changes, do not silently reset the source frame to zero. Reset `sourceIn` only when the underlying media is replaced.
7. **Keep the existing project shape readable.** Missing `sourceIn` in older saved projects means zero; normalization must not invalidate older projects.

## Next architecture: transactional edit commands

Before adding ripple, slip, or roll edits, centralize timeline changes behind one edit-command boundary. UI handlers should describe the intent; a shared edit layer should do the work.

Each command should:

1. Capture a stable target ID, lane, playhead frame, and edit mode. Resolve the ID again immediately before applying the edit.
2. Preflight finite times, media bounds, lane membership, clip duration, and all affected linked items.
3. Apply changes to a candidate project state, not the live state.
4. Validate the candidate state across every affected lane.
5. Commit the full state once, create one Undo entry, then refresh the timeline and preview from the committed state.
6. If media is missing, a range is invalid, or applying the command throws, discard the candidate state and keep the original edit untouched.

The existing snapshot-based Undo/Redo can remain as the first implementation, but it must only receive a fully validated committed state. The UI must never duplicate edit math across buttons, pointer drags, and keyboard shortcuts.

## Timebase and precision

The current timeline stores seconds as floating-point values and exports at 30 fps. One-frame trim boundaries are the correct immediate minimum, but the durable model should use integer project-frame positions for timeline edits and convert to source seconds at media boundaries. Centralize the project frame rate instead of scattering the number `30` across the application.

For variable-frame-rate media or source media at a different frame rate, timeline frame positions and source-media timestamps must remain distinct. Rounding should happen at well-defined boundaries, not after each edit. Tests should cover speeds below and above 1x, short clips, fractional source times, and clips near source EOF.

## Ripple scope must be explicit

Adopt separate commands rather than one ambiguous “trim” operation:

- **Trim item:** change only the selected item's source in/out or visible duration.
- **Ripple trim on the selected lane:** remove the selected-lane time and shift later items on that lane.
- **Ripple all tracks:** remove a project time range and shift other lanes according to an explicit policy.
- **Slip:** change source in/out together while preserving timeline position and duration.
- **Roll:** move a cut point between neighboring clips while preserving the combined duration.

Global ripple is not safe to implement by simply subtracting a duration from every later `start`. If the removed interval crosses an audio clip, split it into source ranges before and after the cut. If it crosses a video overlay, split it and preserve `sourceIn` on the right-hand fragment. Image/text overlays can be clipped by visible duration; audio/video items need source-range-aware splitting. Overlay transform, opacity, blend mode, keying, volume, and fade settings must survive both fragments. Provide separate controls for selected-lane ripple and all-track ripple so users can predict whether music and titles move.

## Regression and release gates

Every edit operation needs tests for:

- start/middle/end positions, one-frame fragments, zero/negative/non-finite times, and source EOF;
- normal speed, slow motion, fast motion, and a previously trimmed clip;
- video, audio, image, text, and video-overlay items;
- preview frame, exported video frame, and mixed audio agreeing on the same source time;
- Undo, Redo, autosave, project restore, and a failed edit leaving no partial mutation;
- programmatic auto-scroll, zoom, touch scrubbing, and playback not fighting over the playhead;
- existing export-fade and Adjust/Blending smoke tests remaining green.

Do not merge a trim/ripple change until JavaScript syntax, browser smoke tests, real FFmpeg worker integration, and Android build checks pass. Then verify on a real Android device with a saved project, at least one speed-adjusted clip, one video overlay with audio, and a second export after Undo/Redo. A green browser test alone does not prove the device export path.

## Open-source behavior references

Use these as behavior references, not as code to paste into MediaY:

- Kdenlive documents distinct normal/overwrite/insert modes, plus ripple trim to playhead: https://docs.kdenlive.org/en/user_interface/menu/tool_menu.html and https://docs.kdenlive.org/en/user_interface/menu/timeline_menu.html
- Shotcut distinguishes normal trim from ripple trim and includes explicit “Ripple All Tracks” and “Ripple Markers” settings: https://www.shotcut.org/howtos/keyboard-shortcuts/ and https://www.shotcut.org/notes/configuration/

The product advantage should be predictability: frame-accurate, reversible edits with identical preview/export timing and an explicit answer to “which tracks will move?” before destructive timeline operations.
