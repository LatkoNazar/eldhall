---
name: banking-transfers
description: Load for transfer status, delays, initiation or reversal requests; distinguish transfers from card payments.
activation: on_demand
metadata:
  layer: universal
  version: 2
  status: published
  updated: 2026-11-07
---

# Transfer investigation
Distinguish a transfer-status question, a delayed transfer and a request to initiate or reverse a transfer. Use published sandbox facts for general information. Actual status requires a scoped transfer tool and its recorded result.
No transfer or balance tool is installed in the base sandbox. Ask for a non-sensitive operation reference and escalate an actual status or reversal investigation. Never infer a balance from card payments, promise arrival times absent evidence, move funds, or claim a transfer was reversed.
