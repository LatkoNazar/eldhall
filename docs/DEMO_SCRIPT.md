# Демо-відео та презентація

## Відео
Пітч-відео 40–45 с, 1920×1080: storyboard і план генерації — [docs/DEMO_VIDEO.md](DEMO_VIDEO.md). Рендер лише після робочого E2E.

## Слайди (≤10)
1. **Проблема** — повторювані грошові звернення, злі клієнти чекають, ручна робота в білінгу.
2. **Чому чат-боти не рятують** — відповідають, але не діють; або діють без контролю.
3. **Продукт** — copilot: intent + sentiment → дані + policy → дія → approval → виконання → аудит. Для різних бізнесів.
4. **AI reasoning & context** — controlled context, tool call `lookup_payments`, типізоване рішення, fallback.
5. **Реальна дія** — refund змінює стан у БД (провайдер симульований — кажемо прямо).
6. **Безпека** — LLM не пише в БД; policy engine; human approval прив'язаний до argsHash; atomic claim + UNIQUE; honest failures; sentiment ≠ авторизація.
7. **Операційний ефект** — лише виміряне: eval-таблиця WS4 (intent/action accuracy, 0 unsafe actions, latency), кроки оператора (1 клік замість ручного пошуку). Оцінки позначити як «оцінка».
8. **Архітектура** — діаграма з `docs/ARCHITECTURE.md`; Fastify + React + Postgres, Oracle ARM64, Docker Compose.
9. **Live demo** — вбудоване відео (docs/DEMO_VIDEO.md).
10. **Підсумок і потенціал** — open source, нові бізнеси = нові tools + policy; roadmap: реальні провайдери, SSO/RBAC, канали, RAG.

## Здача
`git archive --format=zip -o support-copilot.zip HEAD` (без .env, node_modules) · презентація з вбудованим відео · все до 17:00.
