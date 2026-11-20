import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from secrets import token_urlsafe

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.schemas import Message
from app.services.model import Gemini, ModelError

KEY = "test_chat-key"


class FakeModel:
    def __init__(self):
        self.calls = []
        self.fail = False

    async def reply(self, history, text):
        self.calls.append((history, text))
        if self.fail:
            raise ModelError("Провайдер временно недоступен.")
        return "Расскажите о вашем вкладе в недавний проект."


def settings(tmp_path: Path, *, key: str = KEY) -> Settings:
    return Settings(
        _env_file=None,
        access_key=key,
        demo_mode=True,
        database_path=tmp_path / "test.sqlite3",
    )


def login(client):
    return client.post("/api/v1/session", json={"key": KEY})


@pytest.mark.parametrize("key", ["ab", "not.valid", "латиница", "x" * 256])
def test_invalid_key_has_no_sensitive_echo(tmp_path, key):
    with TestClient(create_app(settings(tmp_path))) as client:
        response = client.post("/api/v1/session", json={"key": key})
        assert response.status_code == 422
        assert key not in response.text
        assert not response.cookies


def test_login_cookie_and_revocation(tmp_path):
    with TestClient(create_app(settings(tmp_path))) as client:
        assert client.get("/api/v1/messages").status_code == 401
        assert client.post("/api/v1/messages", json={"text": "Цель"}).status_code == 401
        assert (
            client.post("/api/v1/session", json={"key": "incorrect-key"}).status_code
            == 401
        )
        response = login(client)
        assert response.status_code == 204
        attributes = response.headers["set-cookie"]
        assert "HttpOnly" in attributes
        assert "SameSite=strict" in attributes
        token = client.cookies["luchat_session"]
        assert token != KEY
        assert client.get("/api/v1/messages").headers["cache-control"] == "no-store"
        assert client.delete("/api/v1/session").status_code == 204
        client.cookies.set("luchat_session", token)
        assert client.get("/api/v1/messages").status_code == 401


def test_secure_cookie_and_key_rotation(tmp_path):
    with TestClient(
        create_app(settings(tmp_path)), base_url="https://testserver"
    ) as client:
        response = login(client)
        assert "Secure" in response.headers["set-cookie"]
        token = client.cookies["luchat_session"]

    with TestClient(create_app(settings(tmp_path, key=token_urlsafe(24)))) as client:
        client.cookies.set("luchat_session", token)
        assert client.get("/api/v1/messages").status_code == 401


@pytest.mark.parametrize("message", ["", " \n\t ", "a" * 501, "👍" * 501])
def test_message_validation(tmp_path, message):
    model = FakeModel()
    with TestClient(create_app(settings(tmp_path), model=model)) as client:
        login(client)
        assert (
            client.post("/api/v1/messages", json={"text": message}).status_code == 422
        )
        assert not model.calls


def test_dialogue_context_and_history_survive_restart(tmp_path):
    config = settings(tmp_path)
    model = FakeModel()
    with TestClient(create_app(config, model=model)) as client:
        login(client)
        token = client.cookies["luchat_session"]
        first = client.post("/api/v1/messages", json={"text": "👍" * 500})
        assert first.status_code == 201
        second = client.post("/api/v1/messages", json={"text": " С чего начать? "})
        assert second.status_code == 201
        assert model.calls[-1][1] == "С чего начать?"
        assert [item.role for item in model.calls[-1][0]] == ["user", "assistant"]
        expected = list(first.json().values()) + list(second.json().values())

    with TestClient(create_app(config)) as client:
        client.cookies.set("luchat_session", token)
        result = client.get("/api/v1/messages")
        assert result.status_code == 200
        assert result.json()["messages"] == expected
        assert all(message["created_at"].endswith("Z") for message in expected)


def test_model_failure_can_be_retried_without_duplicate_messages(tmp_path):
    model = FakeModel()
    config = settings(tmp_path)
    with TestClient(create_app(config, model=model)) as client:
        login(client)
        model.fail = True
        response = client.post("/api/v1/messages", json={"text": "Новая цель"})
        assert response.status_code == 502
        assert response.json()["detail"] == "Провайдер временно недоступен."
        assert client.get("/api/v1/messages").json()["messages"] == []
        model.fail = False
        assert (
            client.post("/api/v1/messages", json={"text": "Новая цель"}).status_code
            == 201
        )
        assert len(client.get("/api/v1/messages").json()["messages"]) == 2


def test_gemini_request_and_response():
    def respond(request):
        assert request.url.host == "generativelanguage.googleapis.com"
        assert request.url.path == "/v1beta/interactions"
        assert request.headers["x-goog-api-key"] == "test-provider-key"
        assert request.headers["api-revision"] == "2026-05-20"
        assert not request.url.query
        payload = json.loads(request.content)
        assert payload["model"] == "gemini-example"
        assert payload["store"] is False
        assert "тренер по собеседованиям" in payload["system_instruction"]
        assert payload["input"] == [
            {
                "type": "user_input",
                "content": [{"type": "text", "text": "Хочу подготовиться к интервью"}],
            },
            {
                "type": "model_output",
                "content": [{"type": "text", "text": "На какую роль?"}],
            },
            {
                "type": "user_input",
                "content": [{"type": "text", "text": "Junior Python-разработчик"}],
            },
        ]
        return httpx.Response(
            200,
            json={
                "steps": [
                    {
                        "type": "thought",
                        "content": [{"type": "text", "text": "Внутренние токены"}],
                    },
                    {
                        "type": "model_output",
                        "content": [
                            {
                                "type": "text",
                                "text": "Чем кортеж отличается от списка?",
                            },
                        ],
                    },
                ]
            },
        )

    async def generate():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            model = Gemini(client, "test-provider-key", "gemini-example")
            return await model.reply(
                [
                    Message(
                        id=1,
                        role="user",
                        text="Хочу подготовиться к интервью",
                        created_at=datetime.now(UTC),
                    ),
                    Message(
                        id=2,
                        role="assistant",
                        text="На какую роль?",
                        created_at=datetime.now(UTC),
                    ),
                ],
                "Junior Python-разработчик",
            )

    assert asyncio.run(generate()) == "Чем кортеж отличается от списка?"
