# Historical pitch planning note — 2026-10-31

This is an archived planning note, retained for context rather than a current runbook.
The recorded [archival demo](../demos/mvp/pitch/exports/eldhall-pitch-uk-ARCHIVE-2026-10-31.mp4)
and [pitch source guide](../demos/mvp/pitch/README.md) supersede the output paths and
procedures below. For the qualified current talk, see [PITCH_TEXT](../deliverables/pitch/PITCH_TEXT.md).

Current built-in refunds use separate **Approve → Execute** steps: approval alone
does not perform a refund. Reviewed external catalogs can use `auto`, `ask` or `deny`
policy. Source/image publication remains on hold. Old counts, schedules, statuses
and the one-step approval storyboard below are historical, not current evidence.
Capture/reset commands are for a disposable capture environment; they must not be
run against the restored development database containing historical test data.
The undated `exports/eldhall-pitch-uk.mp4` path is only the output of a future render.

---

# Pitch video — storyboard and generation plan

**Format:** 40–45 s, 1920×1080, macOS-style (wallpaper, window chrome with traffic lights, soft shadows), Ukrainian captions, no voice-over (time-boxed; add TTS only if time remains).
**Rule:** every beat shows real, verified MVP behaviour captured from the running app. No mocked screens, no invented metrics. The refund is labelled as a simulated provider.
**When:** prepare now, record and render only after the E2E gate below passes (target 16:00–16:35, WS1). Main workstreams are not involved.

## Tool decision
Use the repo's existing pipeline (`.agents/skills/eldhall-mvp-demo`): **Playwright** drives the real UI and records footage → **Hyperframes + GSAP** composes the macOS frame, transitions, zooms and captions → render MP4. It is already proven here (`demos/reference/youtube`, exported and QA'd), so there is no new framework setup.
Remotion is a valid alternative (React compositions), but it is a new dependency and setup under deadline, and its license terms for teams must be checked first. Switch to it only if Hyperframes blocks for more than 15 minutes; the storyboard does not change.

## Storyboard (44 s)
| # | Time | Picture (real footage unless noted) | Caption | Evidence required before recording |
|---|---|---|---|---|
| 1 | 0–4 s | Composed title: Eldhall flame, "AI Support Copilot" | Підтримка, яка не лише відповідає, а вирішує | – |
| 2 | 4–10 s | Chat window (mobile width, ~430 px) — persona Olena types the duplicate-charge message | Клієнт: «Мене списали двічі» | `/chat` works responsively (WS2) |
| 3 | 10–16 s | AI reply appears; console window slides in beside it, case at the top with P1 | AI знайшов обидва платежі й підготував повернення | Golden path via the configured model (WS4 spike 3/3) — otherwise caption says "rules mode" |
| 4 | 16–23 s | Zoom on console: sentiment chips + signals, policy checklist ✓ | Правила перевіряє policy engine. Настрій не авторизує гроші | Analysis + policy rendered in `/operator` (WS2) |
| 5 | 23–29 s | Real click on **Approve** → status executed, payment refunded | Людина підтверджує саме цю операцію | Approve flow green in `support-smoke.mjs` (WS3) |
| 6 | 29–34 s | Back to chat: confirmation with `SIM-RF-…` | Повернення виконано · симульований провайдер | Same run |
| 7 | 34–40 s | Quick cut: Ivan's abusive over-limit message → case escalated, refund denied | Ліміт перевищено → ескалація людині | Ivan path in smoke |
| 8 | 40–44 s | Console metrics strip (live values from `/api/v1/metrics`), logo outro | Eldhall · open-source MVP | Metrics endpoint |

The second-approve 409 is not shown in the video (the button is hidden); it belongs on the safety slide, backed by the smoke output.

## E2E gate (all must be true before recording)
1. `integration/support-copilot` has WS2–WS4 merged; CI green.
2. `node apps/api/scripts/support-smoke.mjs` passes against the instance used for recording.
3. The model mode is decided: the LLM if WS4 reported 3/3 golden-path runs, else `LLM_PROVIDER=rules`, and caption 3 must not claim an LLM.
4. `POST /api/v1/demo/reset` immediately before capture.

## Generation steps (WS1, ~35 min)
1. **Project:** `demos/mvp/pitch/`, copy the structure of `demos/reference/youtube` (index.html, compositions/, scripts/, package.json pinned to hyperframes 0.8.221 / gsap 3.14.2). Media goes through Git LFS per `.gitattributes`.
2. **Capture (`capture.mjs`, Playwright, dedicated profile):** two pages — chat at 430×900, console at 1440×900 — recorded with `recordVideo`. Drive actions only through real locators (persona button, textarea, Approve), and wait on visible state changes, not timers. Run a 5 s pilot first and check cadence; use 60 fps if it holds, otherwise CFR 30 fps.
3. **Compose:** macOS wallpaper + window chrome per window, GSAP transitions between beats, 1.3–1.6× zooms on the analysis and approve areas, captions from `locales/uk.json` (also exported as SRT).
4. **Render:** `hyperframes render` at 1920×1080 → `demos/mvp/pitch/exports/eldhall-pitch-uk.mp4`.
5. **QA:** `ffprobe` shows 1920×1080 and 40–45 s. Watch it once end to end. Each caption matches the evidence column. Nothing shows secrets, tokens or real personal data.
6. **Fallback if the pipeline fails:** a plain Playwright recording of the same steps plus captions added in the slides. A working honest demo beats a polished fake one.
