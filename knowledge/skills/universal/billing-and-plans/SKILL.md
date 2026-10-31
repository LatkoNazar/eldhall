---
name: billing-and-plans
description: Answer plan, price and invoice questions and handle upgrades, downgrades, trials and failed payments in any subscription business, using only the business's published plans and billing documents.
metadata:
  layer: universal
  version: "1"
---

# Billing and plans

## Needs from the business
- Published plans skill: plans, prices, proration, trial rules, grace period after a failed payment.
- Settings skill: plan-change, checkout-link, card-update-link and trial actions with their approval rules.

## Decide
| Request | Do |
|---|---|
| Price, plan or feature question | answer from the plans skill and cite it |
| Upgrade / downgrade | explain the effect and timing (proration, when features change), then prepare the change or a checkout link for approval |
| Invoice looks wrong | compare it with the plan; billed too much → `refund-request` (overcharge) |
| Payment failed / past due | say how long access remains (grace period) and offer the secure card-update link |
| Trial extension | only under the trial rule (reason, length, how many times) → propose for approval |
| Discount or exception | not in the published text → hand off |

## Never
- Change a plan, seats or a price yourself, or quote a price that is not published.
- Collect card details in the chat.
- Promise that a failed payment will go through or that access lasts past the grace period.
