# Capture method, separate from editing

The included sources are already final; building or previewing does **not** require
recording YouTube again. Its UI/content may change, so recapture is a new source revision,
not a promise to reproduce the historical MP4 exactly.

For future MVP recordings use the repository's `$eldhall-mvp-demo` skill and discover the
actual implemented journey. Do not copy this film's selectors or pretend it is MVP footage.

The portable ingredients here are `assets/cursor/eldhall-arrow.svg`,
`eldhall-pointer.svg`, `hotspots.json`, and the following procedure:

1. Use a dedicated browser profile outside versioned source (or in an ignored profile
   directory). Authenticate and prepare non-sensitive demo data outside the captured interval.
2. Draw one controlled live 44×48 CSS px pointer, at coordinates minus its declared hotspot:
   arrow (3,3), hand (22,4). Use pointer-events:none and meaningful role-based targets.
3. Await the visible cursor's arrival and a short settled hover before real Playwright
   mouse input. Handle navigation and reparent into `document.fullscreenElement` as needed.
   Keep the pointer co-recorded; do not reconstruct it from action timestamps afterward.
4. Prove genuine 60 fps active motion in a short encoded pilot. Prefer a native recorder
   when measurements pass. The successful Windows fallback captured only the owned browser
   HWND with FFmpeg `gfxcapture`, disabled captured OS cursor, and encoded AMF VFR at 1×.
5. Convert real timestamps to 60 CFR offline after capture. Do not put a live fps-filter
   readiness wait on a static source; this previously deadlocked before cursor movement.
   Retain only a clearly documented static tail if VFR omitted an already completed idle hold.
6. Compare screenshot/reference pixels and decoded range/matrix. Correct incorrect tags
   only when demonstrated; do not apply the old AMF fix indiscriminately to new hardware.
7. Align voice to decoded action onsets, not encoder progress callbacks. Inspect the
   encoded result independently and bind the review to the final MP4 SHA-256.

Inspect installed FFmpeg filter/encoder help and current Playwright documentation before
writing a machine-specific runner. WGC/AMF availability, screen geometry, power limits and
profile preferences are conditional. Any battery-saver workaround belongs only to the run's
isolated profile. Do not change personal browser profiles, OS cursors or system power policy.

No capture runner with hidden machine paths is required by this editable bundle; no OS
fonts, browser profiles, raw experiments or old failed recordings are redistributed.
