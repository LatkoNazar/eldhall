# Composition, export and independent QA

## Standalone project

Create a shareable project under `demos/mvp/<run-name>/` or another `demos/` slug. Inspect current official
Hyperframes documentation, installed skills and `npx hyperframes init --help`; pin the
package version actually used and retain its lockfile. Version0.8.221 was the successful
baseline, not a claim about whatever future release is current.

Read the official Hyperframes main/CLI/media/review guidance available in the environment
or installed package. If global skills are missing, use official CLI docs/bundled references;
the project must not depend on a previous global Eldhall skill or an ignored prototype.
Official entry points: https://hyperframes.heygen.com/llms.txt and
https://github.com/heygen-com/hyperframes. Verify commands against the installed CLI.

Keep an entry HTML, separate styles/renderer logic, locale strings and scene JSON. Copy
source video, narration, fonts and GSAP into local assets; no remote runtime font/media load.
Record original paths, SHA-256 hashes, dimensions, frame rates, clip offsets, duration,
narration placement and any justified processing in an asset ledger/timing manifest.

The versioned `demos/reference/youtube/` project illustrates this split. Its YouTube copy,
scene durations, clips and narration are not MVP defaults. It uses system-font fallbacks
instead of distributing Windows font binaries; any changed-font render needs its own review.

## Seekable renderer invariants

- Root metadata declares the actual source width/height, target fps and total duration.
  Match source geometry; do not force a1080p preset onto a1200p recording.
- Every timed visual has `class="clip"`, `data-start` and `data-duration`. Use official
  video media attributes, source trim support and playback rate1; let the media engine seek.
- Register a paused GSAP timeline per composition in `window.__timelines['literal-id']`.
  In the tested CLI, literal registration in entry markup was needed by static lint even
  when external JavaScript built the timeline. Child registration/structure follows the
  installed official subcomposition contract, not arbitrary paused nested timelines.
- Use deterministic timeline interpolation. No wall clocks, autonomous timers or manual
  video play/seek loops in rendered compositions. Capture-time browser rAF is a separate phase.
- Use subcompositions for chapter graphics. Declare local fonts in their scope when needed
  by lint; ensure first-frame contents are populated and fade-outs are seek-safe.
- All source footage and the baked pointer share one transform. Default to no camera move.
  No permanent decorative browser window, picture-in-picture wrapper, external progress
  stripe or zoom around native fullscreen. Keep short labels clear of controls and popups.

## Narration and source time

Measure encoded UI onsets, then place narration against those points. Encoder progress and
action wall-clock telemetry can lag actual pixels. Do not reconstruct a cursor from them.
Probe voice duration rather than guessing from text. Leave the narration enough leading and
trailing space. Keep source motion at1×; adjust the story/real holds, not playback speed.

Local Ukrainian Edge TTS with `uk-UA-PolinaNeural` and optional SRT worked. Select language
and voice from the current request. Measure source/final loudness and true peak before
choosing gain; the earlier +3dB setting is not a universal preset. Do not add music merely
to satisfy launch-film defaults or claim to have listened when only running analysis.

## Review and export

Start persistent Studio early and verify it is listening:

```powershell
npx hyperframes preview --background
npx hyperframes preview --status
npm run check -- --json
npx hyperframes snapshot --review --output review/preview --json
```

Define the project's check script using its pinned CLI. Read the actual check report;
`browserSkipped:true` is not a browser pass. Inspect beat/phone/seam frames and dense
before/during/after action windows, especially source edges, popup targets and fullscreen.
Keep the preview available through review; stop it when it is no longer needed. Honor
explicit user preview/hold requests, but do not invent approval for a requested local export.

Known-working render command shape, after verifying installed help:

```powershell
npx hyperframes render --fps 60 --quality delivery --workers 2 --video-frame-format png --frames-cache-dir .cache/frames --output renders/mvp-demo-uk-60fps.mp4
```

Use moderate concurrency appropriate to available RAM;2workers worked on a15GB machine.
PNG source-frame extraction preserves UI edges. Keep the cache on a drive with enough space.
Delivery rendering may be slower than real time; report measured progress, not speculative
speed claims. Do not restart a healthy export blindly. A generic long-GOP preview warning
is not grounds to apply its example `-r30` repair to required60fps footage.

## Independent gate on the completed MP4

Keep authoring and approval separate. Give a verifier the actual MP4, source bindings and
global/source scene mapping. It should check:

- `ffprobe` dimensions, CFR/frame count/duration, color tags and audio stream; complete A/V
  decode without errors. Preserve intended native fullscreen letterboxing.
- An active0.5-second cursor ROI with30 distinct positions at60fps, plus source/output
  correspondence. Container metadata or whole-frame hashes alone do not prove smooth motion.
- Cursor reaches the real target before each state transition. Check native fullscreen
  immediately before/after expansion; no post-expansion cursor arriving at the old button.
- Chapter seams, first/end frames and all taught targets: no inserted blanks, crop damage,
  duplicate cursor, intrusive labels, accidental personal data or fake successful actions.
- Narration fits the actual actions and its scenes, decoded audio has safe peak/loudness,
  and subtitles match the spoken script. Record whether sound was measured or heard.

Bind the review to the MP4 SHA-256. Distinguish genuine product/network loading from renderer
lag. If a real defect is found, fix the responsible phase and recheck the changed result;
do not alter an approved MP4 afterward without proportionate verification.

Deliver MP4 + optional SRT in `exports/`, source project, concise rerun/provenance instructions,
scene timing/asset ledger and independent report. Prepare final code/media for Git sharing;
use existing LFS patterns for binary assets and verify actual files after `git lfs pull`.
Keep dependencies, caches, frames, profiles and intermediate `renders/` ignored. Never include
auth state or secrets. Stage/commit/push only when requested. Keep the final response focused
on playable media and material limitations. Publishing/deploying is separate from local rendering.
