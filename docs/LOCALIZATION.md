# Interface localization

The operator console, access form, test-agent/customer-chat controls and landing
page support English (`en`), Spanish (`es`), Ukrainian (`uk`), German (`de`) and
Portuguese (`pt`). Portuguese display conventions initially use `pt-PT`.

UI preferences are separate from the business setting that controls agent reply
language. Changing the interface language does not update business settings,
reset a conversation, translate stored messages or change an approved action.
Customer and agent messages, knowledge articles, taxonomy labels and business
records retain their original content. The landing walkthrough has its own
translated demonstration copy. Existing screenshot pixels show the Ukrainian
demo; translated captions identify their original language.

## Language preference

The shared [locale core](../packages/i18n/src/core.ts) resolves a validated `lang`
query parameter, an explicit localized landing route, a saved preference, the
first supported browser language, then English. Regional browser tags fall back
to the supported language. `?lang=es` can therefore open the existing operator or
chat routes without changing their paths.

Only the allowlisted language code is stored under `eldhall.uiLocale.v1` in
localStorage. Blocked/full storage is harmless. A manual change updates the URL
with `replaceState`, preserves operator/chat routes and fragments, and does not
reload the application. The landing page changes only its locale route segment.
Auth deep-link credentials must be scrubbed before locale or
analytics initialization. App links from the landing page first use the existing
trusted destination/campaign helper, then append the validated locale. Language
selection is not added to analytics event properties or campaign allowlists.

## Catalogs and runtime

Both clients use i18next with local, typed resources. React uses an
`I18nProvider`; the landing page updates explicit text and allowed attribute
bindings. English is the fallback. Other language resources are local build
chunks, loaded before committing a language change. A failed load keeps the
previous interface and can be retried; it never changes the active business.

Frontend catalogs are organized into `apps/frontend/src/locales/core` and
`apps/frontend/src/locales/operations`, one file per language. Use semantic
message IDs, full phrases and named interpolation parameters. Avoid joining
translated sentence fragments or using rendered text as lookup keys.

Use `UiMessage` descriptors for stored success/confirmation notices, and keep
error causes or typed `UiError` values until render. This lets existing notices
change language too. `ErrorNotice` gives a localized primary explanation and,
when supplied, separately labels the original human-readable server detail.
Never render entire response payloads, stacks or causes as diagnostics. Control
flow must use typed status/reason codes rather than translated error text.

The shared formatters use Intl for numbers, percentages, money and date/time.
Amounts retain their business currency and cents; no exchange conversion is
performed. Date/time presentation retains the existing `Europe/Kyiv` timezone.
Number-input values, API enum values, operation IDs and policy hashes remain
canonical protocol data. For counted phrases, use i18next's `count` option and
the plural forms required by each supported language, including Ukrainian's
one/few/many/other forms. Keep interpolation names identical across translations.

The landing build emits localized static HTML for `/en/`, `/es/`, `/uk/`, `/de/`
and `/pt/`, with translated content, language metadata, accessibility labels and
initial walkthrough. Runtime switching reuses the same controller and preserves
the selected scenario, progress and analytics deduplication. It must not rebuild
the page or insert translated HTML with `innerHTML`.

## Add a language

1. Extend `localeCodes` and `localeOptions` with its native name and Intl locale.
2. Add complete core, operations and landing catalogs, following the existing
   English key set and matching interpolation/plural families. Do not copy the
   English dictionary as a substitute for translation.
3. Extend the typed local catalog loaders. The landing page must generate a
   static route for every supported language. Keep DOM IDs, action/tool IDs and
   analytics enums unchanged.
4. Check translated controls and error states, longer labels, narrow screens,
   keyboard access, `<html lang>` and metadata. Additional writing directions
   also require layout/direction review.
5. Run the affected locale/critical-flow tests, frontend and landing lint/types/
   builds, legal artifact validation and private source-archive checks. Dictionary
   tests require complete keys, nonempty values and matching placeholders.

For ordinary edits use the scoped checks from `AGENTS.md`. Shared locale helpers
also have a dependency-free check:

```sh
node --test packages/i18n/tests/core.test.mjs
```

Docker builds and development mounts include `packages/i18n`; private source
archives require the shared core and retain both browser build contexts. New
runtime dependencies must retain their upstream notices. Localization does not
authorize source/image publication or production deployment.
