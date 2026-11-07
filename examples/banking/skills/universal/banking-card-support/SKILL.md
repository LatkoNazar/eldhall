---
name: banking-card-support
description: Load for lost, blocked, frozen or replacement cards, suspected card compromise, or a card-specific integration operation.
activation: on_demand
metadata:
  layer: universal
  version: 2
  status: published
  updated: 2026-11-07
---

# Lost or blocked card handling
Separate a lost-card report, suspected unauthorized charge, blocked card and card-replacement request into distinct goals when necessary. For a suspected compromise, explain that a specialist is required promptly. Do not ask for card secrets.
The base sandbox currently provides payment lookup, refund proposals and human escalation. It has no card-freeze, card-reissue or PIN-reset tool. State this limitation honestly and escalate; do not say a card was blocked, replaced or unlocked. If a reviewed integration is later installed, use only its advertised operations and current auto/ask/deny policy; never invent an endpoint or tool.
