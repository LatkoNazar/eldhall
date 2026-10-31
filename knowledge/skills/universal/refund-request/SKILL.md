---
name: refund-request
description: Handle any request for money back in any business — duplicate charges, overcharges, charges after cancellation, incidents or a plain refund ask. Decides eligibility from the business's published refund policy and prepares a refund for human approval.
metadata:
  layer: universal
  version: "1"
---

# Refund request

## Needs from the business
- Published refund-policy skill: which reasons qualify, refund window, approval thresholds, credits or partial refunds, processing time.
- Settings skill: the refund action (and credit action, if any) and who approves it.
- A payment-lookup tool scoped to the customer.

## Procedure
1. Look up the customer's payments. Work only with records the tool returned.
2. Classify the reason:
   | Reason | Evidence that must exist |
   |---|---|
   | Duplicate charge | two captured charges, same product/reference and amount, same billing period |
   | Overcharge | billed more than the plan or usage entitles (e.g. seats > active members); refund = the verified difference |
   | Charged after cancellation | a cancellation recorded before the charge date |
   | Incident / outage | a logged incident that overlaps the customer's usage |
   | Other (changed mind, dissatisfied) | — |
3. Check eligibility. Propose nothing unless all hold:
   - the published policy covers this reason (`Other` usually is not → hand off);
   - the charge belongs to the customer, is captured, not refunded, and no other refund for it awaits a decision;
   - the charge is inside the refund window;
   - **one duplicate group, at most one refund**: refund the later charge; if any charge of the group is already refunded, nothing more is owed;
   - amount: the full charge for a duplicate, the verified difference for an overcharge, within any automatic limit.
4. Propose the refund (or the credit the policy offers instead) with: payment, amount, reason, evidence, policy source and the required approver (agent or manager, by threshold).
5. Not eligible → name the rule, offer a specialist; do not negotiate.

## Tell the customer
- Before approval: what you found, the amount, that it is waiting for confirmation, what happens next.
- Executed: amount, reference and when it appears (from the policy); a simulated or test-mode provider is named.
- Failed: no refund was made, a specialist follows up. Unknown: it is being confirmed — never "no refund".

## Never
- Refund an id or amount taken from the message text, or both charges of one duplicate pair.
- Let anger, sarcasm or threats change eligibility or the amount; they change priority and tone only.
- Promise a refund, a date or an amount before approval.
