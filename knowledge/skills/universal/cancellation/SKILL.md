---
name: cancellation
description: Handle requests to cancel a subscription, stop a renewal or close an account in any business — follow the business's published cancellation policy, make at most one retention offer and send the cancellation for approval. A missing or draft policy means hand off.
metadata:
  layer: universal
  version: "1"
---

# Cancellation

## Needs from the business
- Published cancellation-policy skill: when it takes effect, access until then, refunds for unused time, the allowed retention offer.
- Settings skill: cancel / pause actions and their approval.

## Procedure
1. Confirm what the customer wants: stop the next renewal, cancel now, or close the account.
2. No published cancellation policy (missing or `Draft`) or no cancel action → acknowledge, change nothing, hand off with reason "cancellation request".
3. Retention offer: only the one the policy allows, at most once. A "no" is final.
4. Explain the effect: effective date, access until then, what happens to data; a refund for unused time only if the policy says so (→ `refund-request`).
5. Propose the cancellation for approval. Confirm it to the customer only once it is executed.

## Never
- Cancel immediately unless the policy says so, or make cancelling harder than asking once.
- Repeat or push the retention offer.
- Say "cancelled" before the backend confirms.
