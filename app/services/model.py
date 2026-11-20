import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol

import httpx

from app.schemas import Message
from app.services.answer_suggestions import extract_answer_suggestions
from app.services.provider_retries import retry_provider

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """Ты интервьюер в тренажёре «Interview AI». Проводи пробные собеседования
и помогай человеку формулировать ответы на основе его реального опыта.

Если человек хочет начать интервью, уточни роль и уровень, если они ещё не ясны.
Когда контекста достаточно, задай ровно один вопрос, подходящий роли и уровню.
После ответа отметь одну конкретную сильную сторону, предложи одно улучшение
и задай следующий вопрос. Используй детали ответа и не придумывай за кандидата
цифры, результаты или проекты. На поведенческих вопросах при необходимости
подскажи, как связать ситуацию, действия и результат.

Если человек просит разобрать один ответ или помочь с самопрезентацией,
сосредоточься на этом упражнении. Если просит завершить тренировку, кратко
подведи итог по ответам из диалога. Вежливо возвращай к подготовке к собеседованию,
если запрос вне темы.

Отвечай на языке собеседника, уважительно и конкретно. Разделяй обратную связь
и следующий вопрос пустой строкой. Используй короткие абзацы и Markdown, где он улучшает читаемость.

Ответ верни в JSON с полями reply и answer_suggestions. Сначала напиши полный
ответ в reply. Если в своём вопросе ты уже предлагаешь короткие альтернативы
(например, «Разбор ответа» или «Пробное интервью»), скопируй до пяти дословных
фраз из reply в answer_suggestions. Не добавляй альтернативы только ради кнопок.
Если вопрос открытый или альтернативы неуместны, верни пустой массив.
"""


class ModelError(Exception):
    pass


@dataclass
class Reply:
    text: str
    suggestions: list[str]


RetryReporter = Callable[[int], Awaitable[None]]


class ChatModel(Protocol):
    async def reply(
        self, history: list[Message], text: str, on_retry: RetryReporter | None = None
    ) -> Reply: ...


POLZA_BASE_URL = "https://polza.ai/api/v1"


@dataclass
class PolzaChat:
    client: httpx.AsyncClient
    api_key: str
    model: str

    async def reply(
        self, history: list[Message], text: str, on_retry: RetryReporter | None = None
    ) -> Reply:
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        messages.extend(
            {"role": message.role, "content": message.text} for message in history
        )
        messages.append({"role": "user", "content": text})

        async def complete():
            response = await self.client.post(
                f"{POLZA_BASE_URL}/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={
                    "model": self.model,
                    "messages": messages,
                    "response_format": {
                        "type": "json_schema",
                        "json_schema": {
                            "name": "interview_reply",
                            "strict": True,
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "reply": {"type": "string"},
                                    "answer_suggestions": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                    },
                                },
                                "required": ["reply", "answer_suggestions"],
                                "additionalProperties": False,
                            },
                        },
                    },
                },
                timeout=80,
            )
            response.raise_for_status()
            return response

        try:
            async with asyncio.timeout(255):
                response = await retry_provider(complete, on_retry)
            content = response.json()["choices"][0]["message"]["content"]
            structured = json.loads(content)
            reply = structured["reply"].strip()
            candidates = structured.get("answer_suggestions", [])
            suggestions = extract_answer_suggestions(
                reply,
                [item for item in candidates if isinstance(item, str)]
                if isinstance(candidates, list)
                else [],
            )
        except (httpx.TimeoutException, TimeoutError) as error:
            raise ModelError(
                "Модель отвечает слишком долго. Попробуйте ещё раз."
            ) from error
        except httpx.HTTPStatusError as error:
            status = error.response.status_code
            logger.warning("Polza chat returned HTTP %s", status)
            if status == 429:
                raise ModelError(
                    "Достигнут лимит запросов к модели. Попробуйте позже."
                ) from error
            raise ModelError("Модель сейчас недоступна. Попробуйте позже.") from error
        except (
            httpx.RequestError,
            ValueError,
            KeyError,
            IndexError,
            TypeError,
            AttributeError,
        ) as error:
            logger.warning("Polza chat failed (%s)", type(error).__name__)
            raise ModelError(
                "Не удалось получить ответ модели. Попробуйте ещё раз."
            ) from error
        if not reply:
            raise ModelError(
                "Модель вернула пустой ответ. Попробуйте переформулировать сообщение."
            )
        return Reply(reply, suggestions)


class DemoModel:
    async def reply(
        self, history: list[Message], text: str, on_retry: RetryReporter | None = None
    ) -> Reply:
        await asyncio.sleep(0.5)
        if history:
            return Reply(
                "Чтобы ответ прозвучал убедительнее, назовите один конкретный пример: "
                "что вы сделали и что изменилось.\n\n"
                "Следующий вопрос. Вспомните задачу с неопределёнными требованиями. "
                "Как вы решили, с чего начать?",
                [],
            )
        return Reply(
            "С чего начнём: **Пробное интервью** или **Разбор ответа**?",
            ["**Пробное интервью**", "**Разбор ответа**"],
        )
