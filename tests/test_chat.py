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
from app.services.model import ModelError, PolzaChat, Reply

KEY = "test_chat-key"


class FakeModel:
    def __init__(self):
        self.calls = []
        self.fail = False

    async def reply(self, history, text, on_retry=None):
        self.calls.append((history, text))
        if self.fail:
            raise ModelError("Провайдер временно недоступен.")
        return Reply(
            "Вы выбрали: пробное интервью или разбор ответа?",
            ["пробное интервью", "разбор ответа"],
        )


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
        token = client.cookies["interview_session"]
        assert token != KEY
        assert client.get("/api/v1/messages").headers["cache-control"] == "no-store"
        assert client.delete("/api/v1/session").status_code == 204
        client.cookies.set("interview_session", token)
        assert client.get("/api/v1/messages").status_code == 401


def test_secure_cookie_and_key_rotation(tmp_path):
    with TestClient(
        create_app(settings(tmp_path)), base_url="https://testserver"
    ) as client:
        response = login(client)
        assert "Secure" in response.headers["set-cookie"]
        token = client.cookies["interview_session"]

    with TestClient(create_app(settings(tmp_path, key=token_urlsafe(24)))) as client:
        client.cookies.set("interview_session", token)
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
        token = client.cookies["interview_session"]
        first = client.post("/api/v1/messages", json={"text": "👍" * 500})
        assert first.status_code == 201
        second = client.post("/api/v1/messages", json={"text": " С чего начать? "})
        assert second.status_code == 201
        assert model.calls[-1][1] == "С чего начать?"
        assert [item.role for item in model.calls[-1][0]] == ["user", "assistant"]
        expected = list(first.json().values()) + list(second.json().values())

    with TestClient(create_app(config)) as client:
        client.cookies.set("interview_session", token)
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


def test_polza_request_and_response():
    def respond(request):
        assert request.url.host == "polza.ai"
        assert request.url.path == "/api/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer test-provider-key"
        payload = json.loads(request.content)
        assert payload["model"] == "openai/gpt-6-luna"
        assert payload["response_format"]["type"] == "json_schema"
        system, *messages = payload["messages"]
        assert system["role"] == "system"
        assert "Ты интервьюер в тренажёре" in system["content"]
        assert messages == [
            {"role": "user", "content": "Хочу подготовиться к интервью"},
            {"role": "assistant", "content": "На какую роль?"},
            {"role": "user", "content": "Junior Python-разработчик"},
        ]
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "reply": "Поговорим про списки или кортежи?",
                                    "answer_suggestions": [
                                        "списки",
                                        "КОРТЕЖИ",
                                        "списки",
                                        "словарь",
                                    ],
                                }
                            ),
                        }
                    }
                ]
            },
        )

    async def generate():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            model = PolzaChat(client, "test-provider-key", "openai/gpt-6-luna")
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

    assert asyncio.run(generate()) == Reply(
        "Поговорим про списки или кортежи?", ["списки", "кортежи"]
    )


def test_edit_preserves_previous_dialogue_and_rating(tmp_path):
    model = FakeModel()
    with TestClient(create_app(settings(tmp_path), model=model)) as client:
        login(client)
        first = client.post("/api/v1/messages", json={"text": "Первая реплика"}).json()
        followup = client.post("/api/v1/messages", json={"text": "Продолжение"}).json()
        reply_id = followup["assistant"]["id"]
        assert (
            client.put(
                f"/api/v1/messages/{reply_id}/feedback", json={"rating": "good"}
            ).status_code
            == 204
        )

        url = f"/api/v1/messages/{first['user']['id']}"
        model.fail = True
        assert (
            client.put(url, json={"text": "Новая версия", "branch_id": 1}).status_code
            == 502
        )
        assert len(client.get("/api/v1/messages").json()["messages"]) == 4
        model.fail = False
        edited = client.put(url, json={"text": "Новая версия", "branch_id": 1}).json()
        assert edited["branch_id"] != 1
        assert edited["messages"][0]["text"] == "Новая версия"
        assert len(edited["messages"]) == 2
        assert model.calls[-1][0] == []
        assert len(edited["versions"][str(edited["messages"][0]["id"])]) == 2
        assert (
            client.post(
                "/api/v1/messages", json={"text": "Устаревший черновик", "branch_id": 1}
            ).status_code
            == 409
        )

        previous = client.post("/api/v1/branches/1").json()
        assert previous["messages"] == list(first.values()) + list(followup.values())
        assert previous["ratings"][str(reply_id)] == "good"


def test_transcription_is_authenticated_and_reuses_result(tmp_path):
    from uuid import uuid4

    key = "not-a-real-provider-key"
    config = Settings(
        _env_file=None,
        access_key=KEY,
        polza_ai_api_key=key,
        database_path=tmp_path / "voice.sqlite3",
    )
    app = create_app(config, model=FakeModel())
    calls = []

    def respond(request):
        calls.append(request.url.path)
        assert request.url.path == "/api/v1/media"
        assert request.headers["authorization"] == f"Bearer {key}"
        body = json.loads(request.content)
        assert body["model"] == "openai/gpt-4o-mini-transcribe"
        assert body["input"]["file"].startswith("data:audio/webm;base64,")
        return httpx.Response(
            200, json={"data": [{"type": "transcription", "text": "Пробная запись"}]}
        )

    url = f"/api/v1/audio/transcriptions?request_id={uuid4()}"
    headers = {"Content-Type": "audio/webm;codecs=opus"}
    with TestClient(app) as client:
        provider = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        app.state.http = provider
        try:
            audio = b"\x1aE\xdf\xa3test"
            assert client.post(url, content=audio, headers=headers).status_code == 401
            login(client)
            assert (
                client.post(url, content=b"not audio", headers=headers).status_code
                == 400
            )
            for _ in range(2):
                answer = client.post(url, content=audio, headers=headers)
                assert answer.status_code == 200
                assert answer.json()["text"] == "Пробная запись"
            assert calls == ["/api/v1/media"]
        finally:
            asyncio.run(provider.aclose())


def test_entire_active_history_and_suggestions(tmp_path):
    model = FakeModel()
    with TestClient(create_app(settings(tmp_path), model=model)) as client:
        login(client)
        for index in range(8):
            result = client.post("/api/v1/messages", json={"text": f"Ход {index}"})
            assert result.status_code == 201
        assert len(model.calls[-1][0]) == 14
        assert model.calls[-1][0][0].text == "Ход 0"
        history = client.get("/api/v1/messages").json()["messages"]
        assert history[-1]["answer_suggestions"] == [
            "пробное интервью",
            "разбор ответа",
        ]


@pytest.mark.parametrize(
    "codes, expected_retries",
    [
        ([503, 502, 500], [1, 2]),
        ([401], []),
        ([429], []),
    ],
)
def test_provider_retry_budget(monkeypatch, codes, expected_retries):
    from app.services import provider_retries

    async def no_delay(_seconds):
        pass

    monkeypatch.setattr(provider_retries, "sleep", no_delay)
    statuses = iter(codes)
    attempts = []
    retries = []

    def respond(_request):
        status = next(statuses)
        attempts.append(status)
        return httpx.Response(status, json={"error": {"code": "insufficient_quota"}})

    async def record(count):
        retries.append(count)

    async def generate():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            await PolzaChat(client, "test", "openai/gpt-6-luna").reply(
                [], "Вопрос", record
            )

    with pytest.raises(ModelError):
        asyncio.run(generate())
    assert attempts == codes
    assert retries == expected_retries


def test_clear_shared_chat_removes_versions_and_keeps_sessions(tmp_path):
    config = settings(tmp_path)
    with TestClient(create_app(config, model=FakeModel())) as client:
        assert client.delete("/api/v1/messages?branch_id=1").status_code == 401
        login(client)
        first = client.post("/api/v1/messages", json={"text": "Старая реплика"}).json()
        assistant = first["assistant"]["id"]
        user = first["user"]["id"]
        assert (
            client.put(
                f"/api/v1/messages/{assistant}/feedback", json={"rating": "good"}
            ).status_code
            == 204
        )
        edit = client.put(f"/api/v1/messages/{user}", json={"text": "Ветка"}).json()
        branch = edit["branch_id"]
        old_token = client.cookies["interview_session"]
        client.cookies.clear()
        login(client)
        assert client.cookies["interview_session"] != old_token
        assert client.get("/api/v1/messages").json() == edit
        assert client.delete("/api/v1/messages?branch_id=1").status_code == 409
        cleared = client.delete(f"/api/v1/messages?branch_id={branch}").json()
        assert cleared["branch_id"] > branch
        assert (
            cleared["messages"] == []
            and cleared["versions"] == {}
            and cleared["ratings"] == {}
        )
        assert client.post("/api/v1/branches/1").status_code == 404
        assert client.post(f"/api/v1/branches/{branch}").status_code == 404
        assert (
            client.post(
                "/api/v1/messages",
                json={"text": "Старый черновик", "branch_id": branch},
            ).status_code
            == 409
        )
        assert (
            client.put(
                f"/api/v1/messages/{assistant}/feedback?branch_id={branch}",
                json={"rating": "bad"},
            ).status_code
            == 409
        )
        client.cookies.clear()
        client.cookies.set("interview_session", old_token)
        assert client.get("/api/v1/messages").json() == cleared

    with TestClient(create_app(config, model=FakeModel())) as restarted:
        login(restarted)
        assert restarted.get("/api/v1/messages").json() == cleared
