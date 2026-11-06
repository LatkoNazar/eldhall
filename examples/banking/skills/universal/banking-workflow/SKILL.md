---
name: banking-workflow
description: Banking request workflow
metadata:
  layer: universal
  version: 1
  status: published
  updated: 2026-11-06
---

# Banking request workflow
This pack belongs to Eldhall Bank Sandbox. Data and operations are synthetic.
Track each distinct customer goal in the request catalog before business tools or the final decision. Keep stable request IDs for clarifications. One shared conversation can contain several goals; never interpret multiple goals as permission for multiple writes in a turn.
Read the current customer-scoped data and published knowledge. State what is known, what needs clarification, and the next allowed step. Use the configured response language and honor a customer language preference. Give managers a concise factual decision justification, identifying evidence and any missing capability; do not provide hidden chain-of-thought.
A proposed or approved action is not execution. A successful tool response is evidence for that operation, not proof every customer goal is complete. Never claim a bank operation occurred without its recorded result. Escalate unsupported operations honestly.
