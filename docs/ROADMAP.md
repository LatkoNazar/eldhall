# Roadmap

Everything below is **planned, not implemented**. Current behavior is in [STATUS](STATUS.md); open risks are in [SECURITY](SECURITY.md).

| Horizon | Item | Why |
|---|---|---|
| Next | Shared rate limiting | The chat limiter is in-memory and per process; multiple instances need a shared counter |
| Next | Per-operator identity and roles, with approval thresholds | Replaces the single shared operator token; larger refunds need a senior approver |
| Next | Docker image build and deploy verification | Image build and container startup are not yet verified |
| Then | Real payment provider in test mode | Replaces the simulated provider while keeping one refund per payment |
| Then | Embedding-based knowledge-base search | Knowledge retrieval is lexical today |
| Then | PostHog product analytics | Per [ANALYTICS_PLAN](ANALYTICS_PLAN.md) |
| Later | Bug / not-bug triage from logs and analytics | Route product defects to engineering instead of support |
| Later | Email and Telegram channels | Same harness and policy behind more inbound channels |
| Later | SSO | Operator sign-in through the company identity provider |
