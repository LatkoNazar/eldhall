# OpenAPI → MCP sidecar (support_mcp.server). Locked dependencies, non-root, read-only friendly.
# Same Python in both stages, so the virtualenv's interpreter link stays valid.
FROM python:3.12.12-slim-bookworm AS build
COPY --from=ghcr.io/astral-sh/uv:0.11.8 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN uv sync --locked --no-dev --no-editable

FROM python:3.12.12-slim-bookworm AS production
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin mcp
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8000 \
    MANIFEST_PATH=/manifest/manifest.json
USER 10001
EXPOSE 8000
# /health is the only unauthenticated route and reports the loaded manifest hash.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=6 \
  CMD ["python", "-c", "import os, sys, urllib.request; sys.exit(0 if urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT', '8000')}/health\", timeout=4).status == 200 else 1)"]
CMD ["support-mcp-server"]
