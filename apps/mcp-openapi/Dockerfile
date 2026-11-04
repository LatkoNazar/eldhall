# OpenAPI → MCP sidecar (support_mcp.server). Locked dependencies, non-root, read-only friendly.
# Same Python in both stages, so the virtualenv's interpreter link stays valid.
FROM docker.io/library/python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c AS build
COPY --from=ghcr.io/astral-sh/uv:0.11.8@sha256:3b7b60a81d3c57ef471703e5c83fd4aaa33abcd403596fb22ab07db85ae91347 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY licenses ./licenses
COPY scripts/check-licenses.py ./scripts/check-licenses.py
RUN python scripts/check-licenses.py
RUN uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN uv sync --locked --no-dev --no-editable

FROM docker.io/library/python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c AS production
LABEL io.eldhall.project.license="Apache-2.0" \
      io.eldhall.project.license-scope="Project-authored software; see /app/licenses/LICENSING.md for third-party terms"
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin mcp
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY --from=build /app/licenses /app/licenses
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
