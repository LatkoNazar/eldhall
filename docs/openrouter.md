# Dedicated OpenRouter ticket classifier

`openai/gpt-6-luna-decisions` uses the [OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request). It returns typed choices and probabilities rather than chat replies or tool calls; see the [selected model documentation](https://openrouter.ai/openai/gpt-6-luna-decisions/providers). This integration calls the fixed `POST https://openrouter.ai/api/alpha/decisions` endpoint. The alpha endpoint is separate from OpenRouter chat completions.

Keep the conversational DSH model and category classifier configured separately in the backend's private `.env`:

```dotenv
AGENT_RUNTIME=dsh
LLM_PROVIDER=google
LLM_MODEL=gemini-3.5-flash-lite
GEMINI_API_KEY=<private Gemini key>
CLASSIFICATION_PROVIDER=openrouter
CLASSIFICATION_MODEL=openai/gpt-6-luna-decisions
CLASSIFICATION_TIMEOUT_MS=10000
OPENROUTER_API_KEY=<private OpenRouter key>
```

Configure each business's category definitions in `SUPPORT_CONFIG_FILE`; see [the configuration guide](integrations-runtime.md). With `CLASSIFICATION_PROVIDER=agent` (the default), the normal agent decision supplies the category instead. Restart both API and worker after changing environment/configuration files. Model keys remain on the server and are never `VITE_` or `PUBLIC_` variables.

For a configured business, the dedicated classifier sends a bounded conversation/message and the allowed category descriptions/examples. Customer identity, payment records and authorization state are omitted. It makes one read-only request, validates the complete category probability vector, and uses the selected category's probability as `confidence` (`scoreKind: selected_probability`). The provider's separate distribution-concentration confidence is not used as that probability. Neither score proves correctness. Missing, invalid, inconsistent, cancelled or unavailable decisions produce the configured fallback category for human review; they do not silently switch models.

The returned reason is a short server-owned explanation of the selection/score, not an invented model rationale. Classification remains independent of the fixed support intent, priority, tool permissions and deterministic financial guards.

## Operator access and customer integration

`OPERATOR_TOKEN` is this application's staff bearer credential, not a model key. Read its value from the same private `.env` used by the running API and enter it on `/operator`; the dashboard sends `Authorization: Bearer <OPERATOR_TOKEN>`. Do not give it to customers or include it in a widget bundle. The current bootstrap credential represents one staff principal; it is not a user-account/password system.

Your authenticated host backend provisions a business/customer through the [administration API](API_CONTRACTS.md#headless-administration), then delivers the returned opaque customer session only to that customer. The customer client sends `X-Customer-Session` to `/api/v1/chat/...`; the support backend derives identity and scope from that session. Keep operator and model credentials on the host backend. Headless API use does not require the dashboard container.
