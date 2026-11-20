from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.config import AccessKey


class LoginInput(BaseModel):
    key: AccessKey


class ChatInput(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    branch_id: int | None = None
    request_id: UUID | None = None

    @field_validator("text")
    @classmethod
    def strip_text(cls, text: str) -> str:
        if not text.strip():
            raise ValueError("Введите сообщение.")
        return text.strip()


class Message(BaseModel):
    id: int
    role: Literal["user", "assistant"]
    text: str
    created_at: datetime
    answer_suggestions: list[str] = Field(default_factory=list)


class History(BaseModel):
    messages: list[Message]
    demo: bool
    branch_id: int
    versions: dict[int, list["Version"]]
    ratings: dict[int, Literal["good", "bad"]]


class Version(BaseModel):
    message_id: int
    branch_id: int


class Feedback(BaseModel):
    rating: Literal["good", "bad"] | None


class Turn(BaseModel):
    user: Message
    assistant: Message
