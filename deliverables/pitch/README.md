# Pitch deliverables

| File | What |
|---|---|
| `Eldhall-Pitch.pptx` | 9-slide deck in the Eldhall style, with speaker notes on every slide |
| `Eldhall-Pitch.pdf` | PDF exported by PowerPoint (fonts embedded) for a backup screen |
| `SPEAKER_SCRIPT.md` | 5-minute talk in Ukrainian: timing, spoken text, slide cues, fallback if the video fails |
| `build/build.js` | Deck generator (pptxgenjs). Edit content here, not in PowerPoint, if you want to regenerate |
| `build/export-pdf.ps1` | PPTX → PDF through the installed PowerPoint |

## Regenerate
```bash
cd deliverables/pitch/build && npm install
PPTX_SKILL="<path to the pptx skill>" NODE_PATH="$(cygpath -w "$PWD/node_modules")" node build.js
powershell -File export-pdf.ps1
```
Small final edits (team name, numbers) can also be made directly in PowerPoint. Just don't regenerate afterwards, or they will be overwritten.

## Placeholders to fill (marked `[…]` on the slides)
- Slide 1: team name and members.
- Slide 4: primary LLM (from the WS4 spike).
- Slide 8: Postgres status and Oracle deploy status (from WS3).
- Slide 9: final API test count; intent accuracy and the unsafe-action count from the WS4 eval. If there is no eval, delete those two tiles — do not invent numbers.

## Adding the final demo video (slide 7)
1. Render `demos/mvp/pitch/exports/eldhall-pitch-uk.mp4` per `docs/DEMO_VIDEO.md`.
2. In PowerPoint on slide 7: **Insert › Video › This Device** → select the MP4.
3. Drag it over the macOS frame: align it to the frame's top-left below the title bar, keep the 16:9 ratio, then delete the play button and the `[ВСТАВИТИ ВІДЕО]` text (or send them backwards).
4. **Playback** tab: Start = *When Clicked*; turn on *Play Full Screen* if the projector is small.
5. Export the PDF again (the video is not included in the PDF; it is the backup without video). For the submission, put the PPTX with the embedded video in the archive; the presentation must stay under 10 slides.
