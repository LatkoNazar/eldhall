---
name: eldhall-account-recovery
description: Eldhall's published account-recovery rules (v1) — verify the email owner, 30-minute reset links, no email changes in chat, agent review for sign-in changes. Use with the universal account-access skill.
metadata:
  layer: business
  business: eldhall
  title: Account recovery
  category: Account
  version: v1
  status: Published
  updated: "2026-04-15"
  source: https://help.eldhall.com/recovery
---

# Account recovery v1 — Eldhall

Procedure: universal `account-access`.

## Rules
- Verify the email owner first; send a reset link only to the email already on file.
- Never change the account email inside a chat.
- Reset links expire in 30 minutes. Expired → send a new one; never extend an old link.
- 2FA codes not delivered → a reset link with backup-code setup.

## Action rules
| Rule | Value | Meaning |
|---|---|---|
| Access changes | Agent review | Any change to sign-in methods requires an agent to review it. |

Cite as: *Account recovery v1*.
