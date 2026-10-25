from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.modules.system.health import dependency_checks, readiness

router = APIRouter(tags=["system"])


@router.get("/health/live")
def live() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/ready")
def ready(checks: Annotated[dict, Depends(dependency_checks)]) -> JSONResponse:
    dependencies = readiness(checks)
    healthy = all(value == "ok" for value in dependencies.values())
    return JSONResponse(
        {"status": "ok" if healthy else "unavailable", "dependencies": dependencies},
        status_code=200 if healthy else 503,
    )
