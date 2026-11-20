from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.config import AccessKey


class LoginInput(BaseModel):
    key: AccessKey


class ChatInput(BaseModel):
    text: str = Field(min_length=1, max_length=500)

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


class History(BaseModel):
    messages: list[Message]
    demo: bool


class Turn(BaseModel):
    user: Message
    assistant: Message
