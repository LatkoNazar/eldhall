# Eldhall analytics

Private, source-only TypeScript package shared by the landing and React application. Vite compiles it; it has no runtime dependencies. Umami is loaded only when both its HTTP(S) script URL and website UUID are valid. Empty configuration makes tracking a no-op.

Use the **same Umami website UUID** on both surfaces. `PUBLIC_UMAMI_DOMAINS` is an optional comma-separated exact hostname allowlist (`eldhall.com,app.eldhall.com`), not an identity bridge. Set the four public variables in the repository `.env`; they are public build-time values, never secrets. Rebuild production images after changes.

| Event | Actual trigger |
| --- | --- |
| `landing_viewed` | Landing initialization, once per document |
| `landing_cta_clicked` | Real app-link click; `location` identifies header, hero or footer |
| `app_opened` | Application initialization, once per document |
| `signup_completed` | **Future integration only:** backend confirms a newly created account |

The current app has no registration flow, so it never emits `signup_completed`. When one exists, pass its successful **new-account** response to `trackSignupCompleted(analytics, { status: 'created', registrationId, method })`. Map the real API response after account creation succeeds; do not call on a CTA click, submit, validation failure, login or duplicate-account response. `registrationId` must be an opaque internal response identifier, is used only in memory to suppress repeated callbacks, and is **not sent** to Umami. The helper accepts only `email`, `oauth` or `passkey` as a method. This browser-side deduplication lasts for the document, not across tabs or reloads; authoritative conversion totals will need backend idempotency when registration is built.

The real CTA URL relays only `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`. These are also preserved as a first campaign per origin and browser-tab session, then included on custom events. Arbitrary query parameters and hashes are removed before Umami receives page URLs and referrers. The `beforeSend` hook reapplies the stored first campaign to sanitized **event URLs**, including later routes without UTMs, so native Umami campaign columns retain acquisition for future goal events. It never rewrites the browser address or attaches that campaign to external referrers. If no first campaign was captured, the current event URL's safe UTMs are preserved. Campaign values are bounded to 100 letters, digits, spaces and common slug punctuation; never put personal data, credentials or tokens in UTMs. No user ID or identification is sent.

Native Umami pageviews remain enabled; their URL is sanitized by the registered `beforeSend` hook. A native Umami click attribute is deliberately unnecessary: our actual anchors navigate immediately, even if the tracker is blocked, slow or offline. A bounded in-memory queue waits for the script without blocking UI. A closed page may lose queued events; analytics counts are best-effort.

The same UUID can associate anonymous traffic across origins using Umami's IP/user-agent based session derivation, but this does **not guarantee a person-level cross-domain journey**. UTMs relay acquisition context, not identity. In a funnel report use the explicit custom event names, because both sites can have `/` as their path. Native campaign reports and stored event properties use the first acquisition policy described above, without rewriting the user's URL.

Run the shared package tests with `npm --prefix apps/frontend test`, and its lint/typecheck through the frontend scripts.

Pinned tracker semantics: [Umami 3.4.1 source](https://github.com/umami-software/umami/blob/v3.4.1/src/tracker/index.ts), [tracker configuration](https://docs.umami.is/docs/tracker-configuration), [UTM](https://docs.umami.is/docs/utm), [distinct IDs](https://docs.umami.is/docs/distinct-ids).
