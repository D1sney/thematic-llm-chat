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
    polza_ai_api_key: SecretStr | None = None
    polza_ai_model: str = "openai/gpt-6-luna"
    polza_stt_model: str = "openai/gpt-4o-mini-transcribe"
    database_path: Path | None = None
    database_url: SecretStr | None = None
    vercel: bool = False
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
        if self.vercel and not self.database_url:
            raise ValueError("Для Vercel настройте постоянную базу через DATABASE_URL.")
        if not self.demo_mode and not (
            self.polza_ai_api_key and self.polza_ai_api_key.get_secret_value().strip()
        ):
            raise ValueError(
                "Укажите POLZA_AI_API_KEY или включите DEMO_MODE для локального просмотра."
            )
        return self

    @property
    def history_path(self) -> Path | str:
        if self.database_url and not self.demo_mode:
            return self.database_url.get_secret_value()
        if self.database_path is not None:
            return self.database_path
        return Path("data/demo.sqlite3" if self.demo_mode else "data/chat.sqlite3")


@lru_cache
def get_settings() -> Settings:
    return Settings()
