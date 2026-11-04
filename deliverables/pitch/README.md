# Pitch materials: historical snapshots and updated talk

**All PPTX/PDF files and the embedded video are archival snapshots of 2026-10-31.** Their test counts, deployment status, roadmap, model and publication claims describe that date. They are not current product evidence. The binary slides have not been rewritten. Current limits are in [RELEASE_STATUS](../../docs/RELEASE_STATUS.md) and [integration contracts](../../docs/integrations-manifest.md). Public source/image publication remains on hold.

| File | Scope |
|---|---|
| [Eldhall-Pitch-ARCHIVE-2026-10-31.pptx](Eldhall-Pitch-ARCHIVE-2026-10-31.pptx) | Original nine-slide deck, notes and embedded historical rules-mode demo |
| [Eldhall-Pitch-v2-ARCHIVE-2026-10-31.pptx](Eldhall-Pitch-v2-ARCHIVE-2026-10-31.pptx) | Original eleven-slide team deck, including video on slide 11 |
| [Eldhall-Pitch-ARCHIVE-2026-10-31.pdf](Eldhall-Pitch-ARCHIVE-2026-10-31.pdf) | Original static PDF; poster only, no playable video |
| [SPEAKER_SCRIPT-ARCHIVE-2026-10-31.md](SPEAKER_SCRIPT-ARCHIVE-2026-10-31.md) | Original nine-slide speaker script; historical claims |
| [PITCH_TEXT-ARCHIVE-2026-10-31.md](PITCH_TEXT-ARCHIVE-2026-10-31.md) | Original team talk preserved byte for byte |
| [PITCH_TEXT.md](PITCH_TEXT.md) | Updated spoken text with current qualifications; slide numbering remains archival |
| [archive-files.json](archive-files.json) | Sizes and SHA-256 hashes of the five preserved originals |

Both PPTX files already embed the same original MP4: SHA-256 `20d27578198ddd3a02ad58015322e51607b6281831ebe735365063ab139c342b` (21,142,462 bytes). The standalone copy is [eldhall-pitch-uk-ARCHIVE-2026-10-31.mp4](../../demos/mvp/pitch/exports/eldhall-pitch-uk-ARCHIVE-2026-10-31.mp4). It shows rules mode without LLM and a simulated payment provider. Approve records consent; Execute is a separate action. No real money moves. Video is Git LFS; a clean checkout may contain its pointer until materialized.

## Validate without rendering

From the repository root (Node built-ins only; no package install, network, browser or LLM):

```sh
node demos/mvp/pitch/scripts/verify.mjs --source-only
node --test demos/mvp/pitch/scripts/verify.test.mjs
```

Source validation accepts only exact asset receipt LFS pointers, checks storyboard/captions/timing/ledger consistency and hashes the preserved deck/text originals. It does not certify rendered visuals or rights to publish media.

For materialization and full media checks, see the [video source guide](../../demos/mvp/pitch/README.md). Do not run capture against historical development data: capture intentionally resets a disposable demo backend.

## Optional historical rebuild (not a current deck)

The original archives stay immutable. `build/build.js` reproduces the older nine-slide storyboard, not the manually extended eleven-slide V2. It retains historical statistics and roadmap deliberately. It labels the rebuild as archival and writes a separate `Eldhall-Pitch-ARCHIVE-2026-10-31-REBUILT.pptx`; it refuses an existing output. No rebuild was performed for this cleanup.

```sh
cd deliverables/pitch/build
npm ci
# Requires the original external PowerPoint helper scripts/apply_theme.js:
PPTX_SKILL="<installed helper directory>" node build.js --archive-rebuild
powershell -File export-pdf.ps1
```

The generator needs its pinned lockfile dependencies, materialized archived MP4, `build/video-poster.jpg`, and the original external theme helper. The PDF helper additionally needs Windows PowerPoint and only exports the named archival rebuild, without overwriting an existing PDF. A fresh current presentation requires an editorial review and new evidence; renaming or rebuilding these files does not update their claims.
