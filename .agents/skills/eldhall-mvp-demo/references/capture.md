# Capture mechanics and evidence

## Pilot gate

Use a short pilot with a large enough cursor movement to distinguish consecutive positions,
a real click, and its visible UI result. Do not benchmark while another render/encode is
competing for the same machine. Probe physical window size, client viewport, DPR and encoded
dimensions; match the eventual composition to the actual source. 1920×1200 at60fps worked
on this machine; 1920×1080 is not a reason to crop a different native aspect ratio.

Prefer a native Playwright/browser recording API when its installed implementation actually
captures the required motion cadence. Inspect current official API docs and local types;
do not invent an fps option. A successful `fps=60` export of a30fps recording is insufficient.
Inspect a0.5-second active cursor window: at60fps it should contain30 genuinely different
positions for a suitably moving path. Track the cursor ROI, not whole-frame hashes of a
moving background. Preserve the tested source and measurement report.

If the pilot fails, diagnose a concrete cause, change only that cause, and remeasure. Stop
after a small number of targeted attempts if no meaningful improvement is possible; report
the measured cadence and the actual missing hardware/power/access requirement. Do not loop
indefinitely or silently downgrade the requested result.

## Live pointer controller

Copy the bundled `assets/cursor` files into the experiment. They are original Eldhall SVGs
with prefixed internal IDs. At44×48 CSS px the arrow hotspot is(3,3), hand hotspot(22,4).
If scaling the cursor, scale both the display size and hotspot; keep target coordinates in
the page's CSS-pixel coordinate system. Do not confuse CSS coordinates with physical pixels.

Draw one fixed, topmost DOM element with `pointer-events:none`; place the image at
`translate3d(pointerX-hotspotX, pointerY-hotspotY, 0)`. Use `requestAnimationFrame` for live
motion and a smooth bounded path, then resolve the movement promise only after arrival.
Await a short stable hover, update the actual Playwright mouse position, then click.
No reconstructed post-production cursor is needed.

Resolve targets via real roles/labels, scroll them into view and recompute their bounds.
Use the hand for buttons, links, menu items and elements with pointer affordances. Keep a
single controlled pointer independent of unrelated physical mouse movement. Avoid synthetic
pre-click rings; they previously delayed the real input and made state changes look mistimed.

Reinstall the controller after navigation. On `fullscreenchange`, attach its DOM host to
`document.fullscreenElement ?? document.body`; verify it is still visible in the captured
window. A source overlay outside the fullscreen subtree can disappear. Do not install a
system cursor or modify app source to get this behavior. Instrument only the demo browser.

## Conditional Windows WGC fallback

Use only when native capture is insufficient and installed FFmpeg supports it. Inspect:

```powershell
ffmpeg -hide_banner -h filter=gfxcapture
ffmpeg -hide_banner -h encoder=h264_amf
```

The successful setup used FFmpeg9 WGC and AMD AMF, an isolated visible Chromium profile,
normal vsync, and a uniquely identified browser HWND. Capture that owned window, not a
monitor or an arbitrary matching Chrome window. Launch background helpers hidden; show only
the intended browser window. Enter true browser fullscreen if removing browser chrome is
part of the shot; measure the resulting geometry rather than trusting a kiosk flag.

Known-working input shape, to adapt to installed capabilities and the measured display:

```text
gfxcapture=hwnd=OWN_HWND:capture_cursor=false:capture_border=false:display_border=false:max_framerate=120
```

`OWN_HWND` means the resolved handle of this run's browser. This is a filter template,
not a command to execute unchanged. Disable captured OS cursor when the live DOM pointer
is already present. A120fps capture ceiling can supply surplus frames for60fps output;
it cannot create motion a60/30Hz source never produced. Other hardware needs its own encoder.

The tested AMF path downloaded capture frames with `hwdownload,format=bgra`, encoded H.264
with no B-frames, and used `-fps_mode passthrough` to preserve VFR timestamps. Keep raw
files. Convert to60CFR offline, after browser capture ends, with the `fps=60` filter while
preserving1× elapsed time; `setpts=PTS-STARTPTS` may reset the epoch, not accelerate it.

Do not place a blocking live `fps` filter before a readiness handshake on an initially
static window: it can wait for another frame while automation waits for output, causing
a first-frame deadlock. Arm capture, establish real first-frame readiness with harmless
visible pointer motion if necessary, then start taught actions. Do not infer an epoch from
process launch, progress callbacks or wall-clock logs; examine encoded frames.

A VFR file may omit the elapsed static tail when nothing repaints. Record the genuine hold;
if necessary, restore only that unrepresented idle tail with a documented last-frame clone.
Never pad over a missed click or invent movement. Keep source/video/audio durations explicit.

## Power and cadence: diagnostic, not universal setup

The successful machine's Chrome Energy Saver had capped animation near30fps on battery.
Its fix was **only in the recorder's own profile**, not a Windows/global/personal setting.
For that installed Chrome, the relevant `Local State` value was
`performance_tuning.battery_saver_mode.state = 0`. Verify the current key and observed
effect before using it. Do not put it in `Default/Preferences` or change unrelated flags.
Prefer normal vsync and measured capture over unbounded-render flags. Ask about power only
when measurements show it is the missing condition; do not add a generic permission flow.

## Color gate and conditional AMF metadata correction

Compare a reference page screenshot with decoded video at matching white, black and red
patches, and inspect `ffprobe` range/matrix tags. Preserve originals. One AMF path wrote
limited-range BT.709 samples but tagged them as full range, decoding white around234
instead of255. This is not a universal AMF behavior or a reason to grade every recording.

Only after proving that specific metadata mismatch, correct H.264 metadata before decoding:

```text
h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1
```

Then emit standard limited-range BT.709 CFR sources and remeasure reference patches. The
successful corrected sources decoded white around253, consistent with compression. Do not
apply a guessed contrast/gamma/range stretch or relabel genuinely full-range footage.

## Versioned reference

`demos/reference/youtube/` contains the approved example, bundled source clips, editable
Hyperframes code, cursor SVGs and `capture/README.md`. It is a reference, not the MVP film.
Do not reuse its YouTube-specific scenario, dimensions or narration as a product requirement.
Keep new source projects and approved exports versioned under `demos/`, with binary media
in Git LFS. Temporary captures/caches/profiles stay ignored; diagnostic raw is opt-in.
No file under the historical untracked `eldhall-demo/` is required after cloning.
