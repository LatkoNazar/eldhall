---
name: eldhall-mvp-demo
description: Record and assemble a real browser demonstration of this repository's current MVP, with a live Eldhall cursor, verified smooth 60 fps footage, Ukrainian narration and Hyperframes export. Use for MVP walkthroughs and product demos, not for inventing unimplemented product features.
---

# Eldhall MVP demo

Make a reviewable film of the working product. Drive its real browser UI with Playwright;
record the cursor and resulting UI changes together; compose local footage with Hyperframes.
Default to Ukrainian and genuine 60 fps unless the user's current request specifies otherwise.
For a request to create or revise this skill, edit the skill only; do not start recording.

## Find the actual product

Read [references/project.md](references/project.md) before planning a scenario. It gives
the repository's verified starting point and commands, not an enduring product specification.
Reinspect the current README, frontend entry/routes, UI tests and relevant auth/data code.

- Select an existing user-visible journey with a clear result; use actual labels and locators.
- Today the UI is the Starter readiness page at `/`, with **Перевірити ще раз**. There is
  no implemented course catalog, account flow or job-submission UI to demonstrate.
- When business features arrive, prefer the requested real MVP journey over this fallback.
- Establish the real origin, service readiness, demo account and non-sensitive fixtures.
  Never turn a failed health response green or expose a backend API token to create a demo.
- Creating a local demo may include normal local startup and reversible demo data needed
  for the requested journey. It does not authorize deployment, publishing or unrelated data changes.

## Isolate the recording work

Keep the skill in `.agents/skills/eldhall-mvp-demo`. Put reusable demo projects in
`demos/mvp/<run-name>/` or another clear slug under `demos/`. Final source, selected local
media, approved MP4/SRT and QA reports are prepared for versioning together. Use the scoped
Git LFS rules for binary media; keep SVG, code, JSON and SRT in ordinary Git. Verify LFS
downloads and attributes rather than committing large payloads to normal Git history.
Do not stage/commit/push unless requested. Do not modify app code merely to instrument video.

Keep dependencies, intermediate renders, extracted frames, framework caches and browser
profiles ignored. Prefer private profiles/auth state outside the versioned tree. Raw capture
is opt-in; retain only useful non-sensitive raw evidence if requested. Use `exports/` for
reviewed final movies and `renders/` for ignored work in progress. The existing `eldhall-demo/`
is historical local experimentation, not a required input to a shareable demo.

Use a dedicated browser profile and window. Do not attach to a personal profile, change
system cursors/power settings or collect an entire desktop when one browser window suffices.
Resolve paths from the repository/skill location; do not require this machine's `D:` drive.

## Prove the capture before the full film

Read [references/capture.md](references/capture.md) for the pilot, cursor, Windows fallback,
timestamp and conditional color procedures. Discover installed tool capabilities first.

1. Try the appropriate native browser recorder when it can actually deliver the target
   cadence. A requested fps or a 60 fps container is not proof of 60 fps source motion.
2. Record a short pilot containing a meaningful cursor path, a real click and visible
   state change. Include fullscreen only if that exists in the requested product journey.
3. Measure consecutive cursor positions in an active window and inspect click-before-state
   ordering in decoded frames. Static holds may naturally repeat frames.
4. If native capture is genuinely capped, choose a measured alternative. The proven Windows
   fallback is WGC window capture with real timestamps, then offline CFR conversion.
5. Make bounded, evidence-led retries: diagnose a bottleneck and test its correction, rather
   than repeating the same recording. If hardware/power/access still prevents the requirement,
   report the measured constraint and request only the missing condition. Never silently
   relabel 30 fps as 60 fps or synthesize intermediate cursor frames.

Run heavy extraction/rendering after capture, not during the fps pilot.

## Co-record the Eldhall pointer

The self-contained assets are [assets/cursor/hotspots.json](assets/cursor/hotspots.json),
`eldhall-arrow.svg` and `eldhall-pointer.svg` beside it. Display them at **44×48 CSS px**:
arrow hotspot **(3,3)**; hand hotspot **(22,4)**. Preserve prefixed SVG IDs and white contours.

- Draw a controlled live DOM pointer inside the captured page, with `pointer-events:none`.
  Its position is target CSS coordinates minus the selected hotspot. Handle DPR explicitly.
- Use the hand over interactive targets. Scroll real containers, then recompute target bounds.
- Animate the live pointer smoothly, await its arrival and a brief stable hover, then send
  the actual Playwright input at that same position. Do not fire the action while it travels.
- Ignore unrelated physical mouse movement. Do not add a second OS cursor, a pre-click ring
  that delays the input, or a separately reconstructed pointer in the renderer.
- Reparent the live cursor into `document.fullscreenElement` when needed; retain it after
  navigation. Test this rather than assuming an overlay survives native fullscreen.

The pointer is custom and live co-recorded, not an OS-native cursor. Browser animation frames
are appropriate during capture; rendered Hyperframes compositions remain deterministically seekable.

## Record, then match narration

Record each necessary action at original speed, with enough genuine pauses to read the result.
Keep raw sources, geometry, recording settings, action telemetry and original end screenshots.
Event logs and encoder progress are navigation aids, not exact encoded click timestamps.
Measure visible action onsets in the resulting media before choosing voice offsets.

Use short Ukrainian narration and local audio/SRT files when narration is requested.
`uk-UA-PolinaNeural` is a proven Edge TTS choice, not a mandatory voice. Probe actual durations;
fit the words around actions and useful holds. Do not accelerate footage to fit a script,
loop interactions, hide failed actions or cut narration off. A documented static closing hold
may extend an already completed state; it cannot repair a missing action.

## Compose and review

Read [references/hyperframes-qa.md](references/hyperframes-qa.md) for the renderer contract,
commands, independent encoded checks and delivery evidence. Use current official Hyperframes
skills/docs and installed CLI help; pin the version actually used.

Present the native UI full-bleed at its measured dimensions. Keep branding white/red
(`#FFFFFF`, `#CF2639`, `#202020`), title cards short and chapter labels away from targets.
Avoid a permanent browser card, picture-in-picture treatment, bottom progress stripe or
decorative zooms. If a focus crop is genuinely needed, keep the taught target fully inside
its bounds and settle before the action. Never zoom artificially around native fullscreen.

Keep scene timings, Ukrainian strings, styles and renderer logic separate. All source clips
play at **1×**; video and baked pointer always undergo the same framing transform.
Keep runtime fonts, GSAP and media local; do not redistribute proprietary OS font files.
The versioned `demos/reference/youtube/` bundle is an optional editable example, explicitly
not an MVP movie. A fresh clone without local experiments must work from versioned assets.

Run the official full composition check, inspect actual snapshots, and keep a persistent
preview available for review. Honor a requested preview-before-export order. An already
requested local render does not require another approval checkpoint.

After export, obtain an independent verifier pass on the actual encoded MP4, not only HTML
or stills. Verify real cursor cadence, input/state order, framing, complete A/V decode,
audio timing/levels and source bindings. Iterate on demonstrated problems and recheck changed
outputs. Do not alter a passed movie without proportionate re-verification.

Deliver the playable local MP4, reusable source folder, exact rerun commands and QA report.
Distinguish measured audio from audio actually listened to, and source loading from renderer lag.
