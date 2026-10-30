# Portable bundle validation

This validates the editable package, not a new encoded movie. The original approved MP4
and SRT were copied byte-for-byte; no new full render or MVP recording was performed.

- `npm ci` and `npm run build` passed with Hyperframes 0.8.221 / GSAP 3.14.2.
- `npm run verify` validates 24 media/cursor/export assets. All five source-video hashes
  match `../original-export/corrected-source-report.json`. The approved export SHA-256 remains
  `3bc7350e73358229daea3f3feef4691ed3b83cd762aad2ee5d382daf8c713c07`.
- The verifier helper was exercised with valid bytes, an LFS pointer and corrupted media.
  It accepted the first, rejected the pointer with a `git lfs pull` instruction, and rejected
  corruption. Source-SRT line endings were normalized to LF before manifest hashing for Git;
  the approved export SRT was already LF and remains unchanged.
- `check.json` is the official full check: real browser sampling, zero errors/warnings in
  lint, runtime, layout, contrast, craft and audio. The four representative frames at
  2.45, 9.109, 34.55 and 43.5 seconds were inspected; `preview.jpg` is their contact sheet.
- Runtime source paths are bundle-relative. No Windows font binaries are present. System
  font fallback is documented; these checks do not claim that another platform regenerates
  byte-identical typography or an approved new MP4.
- Scoped Git attributes select LFS for binary media and normal Git for SVG/SRT/code. Cache,
  framework state, thumbnail/waveform caches, dependencies, raw and profiles are ignored.

The retained npm baseline currently reports Undici 7.25.0 advisories (one high and one
inherited moderate package finding). `dependency-audit.json` records the actual audit.
This task retained the requested tool baseline and did not apply `npm audit fix --force`,
which suggests a different Hyperframes version. Tooling uses local media and loopback
preview; this is not an audit of the application under `apps/`. Deliberate dependency
updates should be tested separately.

Absolute paths in archived QA reports identify the machines/check runs that produced the
evidence. Build, preview and verification do not use those paths as inputs.
