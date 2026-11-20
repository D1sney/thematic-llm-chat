from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

AccessKey = Annotated[
    str, Field(min_length=8, max_length=255, pattern=r"^[A-Za-z0-9_-]+$")
]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", extra="ignore", hide_input_in_errors=True
    )

    access_key: SecretStr
    gemini_api_key: SecretStr | None = None
    gemini_model: str = Field(default="gemini-4-hydrogen", pattern=r"^[A-Za-z0-9_.-]+$")
    database_path: Path | None = None
    demo_mode: bool = False
    secure_cookie: bool = False
    session_ttl_seconds: int = Field(default=86400, gt=0)

    @field_validator("access_key")
    @classmethod
    def validate_access_key(cls, key: SecretStr) -> SecretStr:
        value = key.get_secret_value()
        if not (
            8 <= len(value) <= 255
            and value.isascii()
            and all(char.isalnum() or char in "_-" for char in value)
        ):
            raise ValueError(
                "ACCESS_KEY должен содержать 8–255 символов A–Z, a–z, 0–9, _ или -"
            )
        return key

    @model_validator(mode="after")
    def require_provider_key(self):
        if not self.demo_mode and not (
            self.gemini_api_key and self.gemini_api_key.get_secret_value().strip()
        ):
            raise ValueError(
                "Укажите GEMINI_API_KEY или включите DEMO_MODE для локального просмотра."
            )
        return self

    @property
    def history_path(self) -> Path:
        if self.database_path is not None:
            return self.database_path
        return Path("data/demo.sqlite3" if self.demo_mode else "data/chat.sqlite3")


@lru_cache
def get_settings() -> Settings:
    return Settings()
