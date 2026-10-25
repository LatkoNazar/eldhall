from hmac import compare_digest
from typing import Annotated

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import get_settings

bearer = HTTPBearer(auto_error=False)


def require_api_token(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> None:
    expected = get_settings().api_token.get_secret_value()
    if expected and (
        credentials is None
        or not compare_digest(credentials.credentials.encode(), expected.encode())
    ):
        raise HTTPException(401, "Invalid API token", headers={"WWW-Authenticate": "Bearer"})
