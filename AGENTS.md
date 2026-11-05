# Eldhall working conventions

## Progressive validation

Optimize for time to a verified change. Select checks by affected components,
shared dependencies and risk; a target duration is not a reason to skip a critical check.

1. During implementation, run scoped lint and the directly affected existing tests.
   Include consumers of changed shared modules, contracts and configuration.
2. For copy, styling or documentation changes, use focused existing checks and
   visual/link verification where relevant. Do not add tests that merely repeat a string.
3. Do not rerun full suites, Docker builds or deployment smoke after every small edit.
   After a failure, identify the cause and rerun the failing check first. Broaden
   validation when a new change or unresolved risk justifies it.
4. Before a PR, validate the final combined state once: affected component unit
   suites, lint/types and impacted integration checks. Share results between agents;
   do not repeat the same checks in every lane. Keep authoring and review separate.
5. Escalate for authentication, authorization, public APIs, shared contracts,
   migrations, persistence/recovery, queues, payments, deployment and release logic.
   Run relevant negative, integration and critical smoke checks before merge.
6. Keep the existing required CI gates. Release/deploy validation includes the
   relevant builds, migrations and smoke checks. Moving broad checks to a scheduled
   workflow requires evidence that no critical PR coverage is lost; none is assumed here.
7. Use deterministic fixtures and mocked/local model responses for ordinary tests.
   Prompt/model/retrieval changes also need representative quality evaluation when
   available. Do not call paid LLMs, real business integrations or production stores
   merely to run tests. Do not invent an eval command or claim mock tests measure model quality.
8. Never delete, weaken or bypass a failing check to get green CI. Report the exact
   checks run, failures, skips and unexecuted checks; do not claim unrun CI passed.

## Use the actual project tools

Install locked dependencies only when needed. Reuse an unchanged installation.
Commands below run from the named component directory; replace example test files
with the ones affected by the change.

| Component | During implementation | Broader checks when warranted |
| --- | --- | --- |
| `apps/frontend` | `npm exec -- eslint src/changed.tsx --max-warnings 0`; `npm test -- src/App.test.tsx` | `npm run lint`, `npm run typecheck`, `npm test`; build for packaging/config changes |
| `apps/api` | `npm exec -- eslint src/changed.ts --max-warnings 0`; `node --import tsx --test tests/relevant.test.ts` | `npm run lint`, `npm run typecheck`, `npm test`; `npm run test:postgres`, `npm run test:mcp-openapi` and build when affected |
| `apps/mcp-openapi` | `uv run --locked ruff check src tests`; `uv run --locked python -m unittest discover -s tests -p 'test_relevant.py' -v` | `uv run --locked python -m unittest discover -s tests -v`; cross-language/Compose checks for affected boundaries |
| `apps/landing`, `packages/analytics` | Scoped lint/types and the existing frontend tests importing the changed module | Consumer builds and analytics smoke when affected |
| `scripts`, deployment/release files | Relevant `scripts/tests` test module(s), shell syntax and configuration validation | Existing deployment/release guards and critical smoke checks |

The API uses Node's test runner, the frontend uses Vitest, and the Python sidecar
uses `unittest` plus Ruff. Do not introduce pytest/xdist, a replacement workflow,
or a new test framework solely to match a generic CI example.

## Local verification boundaries

- Inspect cwd, branch/status and relevant `.omc` handoffs before editing. Preserve
  unrelated changes; coordinate ownership and shared ports between agents.
- Never load the checkout's real `.env` or use production database URLs for tests.
  API tests that invoke the environment loader need an isolated source copy with
  synthetic settings and a repository-root boundary: its `compose.yaml` marker
  must stop environment-file discovery from ascending into the active checkout.
  A source symlink back to that checkout does not provide this isolation.
- Explicit CLI launcher tests bind fixed local ports; coordinate them with running
  previews and stop only processes owned by that test. Run them when launch behavior
  changes, not for every UI edit.
- Record actual durations from existing logs/CI before changing parallelism, caching
  or test selection. Recheck after rollout; do not promise a fixed speedup without measurements.
- Keep code, images and evidence private. Testing-policy changes do not authorize
  publication, production writes, merging or deployment.
