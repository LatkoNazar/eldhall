# YouTube — reference demo

This is the **reference film of YouTube**, not a recording of this repository's MVP.
It preserves the successful capture/export and provides a portable editable Hyperframes
project. Nothing here starts or modifies the application under `apps/`.

## Approved film

[`exports/youtube-tutorial-uk-60fps.mp4`](exports/youtube-tutorial-uk-60fps.mp4) is unchanged:
1920×1200, 60 fps, 3,131 frames, 52.183333 seconds, H.264/AAC, 40,786,560 bytes.
SHA-256: `3bc7350e73358229daea3f3feef4691ed3b83cd762aad2ee5d382daf8c713c07`.
The matching SRT and immutable hashes are included in `assets/manifest.json`.

[Original encoded QA](qa/original-export/ENCODED-REVIEW.md) approved this exact MP4:
complete A/V decode, 30 distinct cursor positions in 30 active frames, correct click/state
order and fullscreen transition, −14.8 LUFS / −1.2 dBFS true peak. Audio was measured, not heard.
The archived technical report retains its historical machine path as provenance; that path
is not read by the bundle. Source-video hashes match the archived corrected-source report.

## Prerequisites and commands

Fetch LFS files from the repository first (`git lfs install --local`, `git lfs pull`).
Use Node 24.x, npm, and `ffprobe` / `ffmpeg` in PATH. `FFPROBE_PATH` can select another
FFprobe executable. Hyperframes 0.8.221 and GSAP 3.14.2 are pinned in the lockfile.

From this directory:

```powershell
npm ci
npm run verify
npm run build
npm run dev -- --background
npx hyperframes preview --status
npm run check -- --json
npm run snapshot
npm run render
```

`verify` detects missing LFS downloads and changed immutable assets. `build` reads bundled
scene/video/audio files, probes durations and writes local composition HTML, timing/ledger
JSON and local GSAP runtime. It has no `eldhall-demo` dependency or fixed drive paths.

`render` writes a **new** `renders/youtube-reference-uk-60fps.mp4`; it never overwrites the
approved file in `exports/`. Rerenders need their own encoded QA. Temporary output, framework
state, dependencies, extracted frames and profiles are ignored by `demos/.gitignore`.
The baseline render took about 11½ minutes on the original laptop; this is not a benchmark
promise for another machine. No full rerender was performed to package this reference.

## Fonts and portability

No Windows font binaries are distributed. Editable title/label CSS uses the installed
`Segoe UI`, then `Arial`, then a generic sans-serif. The approved movie was made with the
original Segoe UI regular/bold fonts; a new render on another platform may change glyphs,
line wrapping and pixels. Compatible Segoe UI and the original rendering environment are
needed for pixel-identical cards; this bundle does not promise identical new MP4 bytes.
All runtime media and GSAP are local after `npm ci` + `npm run build`.

## Editing and capture provenance

- `locales/uk.json`: Ukrainian copy; `scenes/tutorial.json`: ordering, 1× source timings,
  voice offsets and safe brief labels.
- `styles.css`, `main.js`, `scripts/build.mjs`: layout, paused timeline and HTML generation.
- `assets/video/`: five final 60 fps scenes with the live flame/hand pointer already baked in.
- `assets/audio/`: original Ukrainian Edge TTS (`uk-UA-PolinaNeural`) MP3/SRT sources.
- `assets/cursor/`: original 44×48 Eldhall SVGs and hotspot definitions.
- [`capture/README.md`](capture/README.md): the recording method and adaptation boundaries.

Playwright drove real Chrome interactions. Windows Graphics Capture recorded a dedicated
window and controlled live SVG cursor together; AMF saved timestamped VFR, followed by
offline 60 CFR and a verified range-metadata correction. No separate cursor reconstruction,
source speed retiming, permanent frame, picture-in-picture wrapper or bottom progress line
was used. The final film remains the approved historical reference, even if editable copy
or platform fonts are changed later.

Example content: **Big Buck Bunny**, Blender Foundation, official upload
https://www.youtube.com/watch?v=aqz-KE-bpKQ and project https://peach.blender.org/.
YouTube UI, third-party thumbnails and marks remain their respective owners' material;
this bundle does not relicense them. Installed npm packages retain their upstream licenses.

The pinned tooling currently inherits Undici advisories reported by `npm audit`; see the
portable-build QA note. The reference uses local media and loopback preview. Dependency
updates should be deliberate and rechecked; `npm audit fix --force` changes the baseline.
