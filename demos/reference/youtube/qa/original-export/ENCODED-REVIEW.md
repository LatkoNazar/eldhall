# Independent encoded delivery review — PASS

Reviewed the completed `renders/youtube-tutorial-uk-60fps.mp4`, not only its HTML preview.

- SHA-256: `3bc7350e73358229daea3f3feef4691ed3b83cd762aad2ee5d382daf8c713c07`
- H.264, 1920×1200, 60/1 fps, 3,131 frames, 52.183333 seconds; AAC 48 kHz stereo.
- Complete video/audio decode exits 0 without errors or warnings. Limited-range BT.709 pixel format and color tags are correct; blank UI white decodes RGB [252, 252, 252].
- All five renderer input hashes match the independently verified corrected capture files; every source starts at 0 and plays at 1×.

## Motion and action order

The actual export at 6.100–6.600s contains 30 distinct cursor positions in 30 consecutive frames. Pixel tracking against the corresponding source at 1.200–1.700s gives a median position difference of 0.192px and maximum 0.410px. This establishes real 60 fps cursor motion in the tested active window, without inferring it from container metadata. Intentional stationary holds are not presented as unique movement.

Dense exported action crops show the live hand pointer on the target before pause, resume, seek, settings menu and speed changes. The fullscreen hand remains on the normal-player control through 42.817s; the first expanded frame is 42.833s. No post-expansion cursor travel, early simulated fullscreen or pre-click ring is present.

Approximate exported UI onsets: pause 23.7s; resume 25.3s; seek 26.5–26.6s; settings menu 32.6s; speed submenu 34.55–34.65s; 1.25× value 36.3s. Narration placements and text match these actions and stay inside their scene boundaries.

## Composition and pacing

The native desktop interface fills the 1920×1200 canvas. YouTube's own fullscreen letterboxing is preserved. No permanent decorative browser frame, picture-in-picture wrapper, external progress line or artificial camera zoom is present. Labels avoid the search field and player controls and disappear before the fullscreen interaction. Beat frames and six scene seams contain no inserted blank/black frames. The first frame is populated; ending copy remains readable.

The weakest shot is the real YouTube navigation load near 18.8s: the player is briefly black before the film appears. It matches the captured source and does not indicate renderer lag. The title-to-playing-film cut omits waiting between recorded chapters; the steps remain clear. Native desktop UI is intended to be viewed at a useful desktop size.

## Audio

Measured on the final encoded AAC: integrated loudness −14.8 LUFS, loudness range 7.5 LU, true peak −1.2 dBFS. Audio is present and decodes completely. Narration timing and subtitle text were checked; the reviewer did not listen to the audio, so no listening-quality claim is made.

## Evidence and disposition

`technical-report.json` binds this review to the completed export. `cursor-motion.json` records measured positions; `audio-loudness.txt` records final audio analysis. `beat-sheet.jpg`, `seam-sheet.jpg`, `fullscreen-dense.jpg`, `controls-final.jpg` and `settings-final.jpg` are derived from the actual export and were visually inspected.

No blocking P0/P1 findings remain. The authored MP4 should remain unchanged after this approval; a changed export requires proportionate re-verification.
