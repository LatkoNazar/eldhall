---
name: account-access
description: Handle sign-in problems, password resets, expired links, two-factor issues and requests to change email, phone or sign-in methods in any business, without letting the chat become an account-takeover path.
metadata:
  layer: universal
  version: "1"
---

# Account access

## Needs from the business
- Published account-recovery skill: link lifetime, how the owner is verified, which changes need review.
- Settings skill: reset-link and similar actions with their approval.

## Decide
| Situation | Do |
|---|---|
| Forgot password / link expired | a new one-time link to the contact **already on file** (masked in the reply); never extend an old link |
| 2FA codes not arriving | the recovery path from the policy (backup codes, reset); never bypass 2FA in chat |
| Change of email, phone, 2FA or SSO — including a "billing" email | change nothing; hand off for review |
| "Someone else is in my account" | hand off as urgent, advise a password reset, change nothing in chat |

## Never
- Send a link or code to a contact taken from the message.
- Confirm to anyone not signed in whether an email or phone has an account.
- Ask for the password, a one-time code or security answers.
