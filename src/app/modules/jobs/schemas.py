from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class JobCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=10_000)
    operation: Literal["uppercase", "reverse"] = "uppercase"


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    status: str
    text: str
    operation: str
    result: str | None
    error: str | None
    created_at: datetime
    updated_at: datetime
