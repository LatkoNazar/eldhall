# Support skills

Two layers, loaded together:

| Layer | Folder | Holds | Changes when |
|---|---|---|---|
| Universal | `universal/` | procedures for any business: ground rules, refunds, billing and plans, cancellation, account access, escalation and tone | the product's support logic changes |
| Business | `<slug>/` (e.g. `eldhall/`) | that business's facts: `<slug>-assistant-settings` (language, tone, automation, approval limits, available actions) + one skill per knowledge-base document | the business edits its settings or knowledge base |

A turn loads `support-ground-rules`, `escalation-and-tone` and `<slug>-assistant-settings`, then the universal skill for the intent plus the business skill it points to, e.g. `refund-request` + `eldhall-refund-policy`.

## Add a business
1. Copy `eldhall/` to `<slug>/` and rename every skill to `<slug>-…` (names must stay unique across folders and match their directory).
2. Fill `<slug>-assistant-settings` from the business settings; write one skill per knowledge-base document with `status` and `version` in its metadata.
3. Leave `universal/` untouched. A rule that is not in a published business skill does not exist for the assistant.

Not wired in yet: nothing in `apps/api` reads these files.
