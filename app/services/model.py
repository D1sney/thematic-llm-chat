import asyncio
import logging
from dataclasses import dataclass
from typing import Protocol

import httpx

from app.schemas import Message

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """Ты интервьюер в тренажёре «Репетиция». Проводи пробные собеседования
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
и следующий вопрос пустой строкой. Используй обычный текст и короткие абзацы.
"""


class ModelError(Exception):
    pass


class ChatModel(Protocol):
    async def reply(self, history: list[Message], text: str) -> str: ...


@dataclass
class Gemini:
    client: httpx.AsyncClient
    api_key: str
    model: str

    async def reply(self, history: list[Message], text: str) -> str:
        steps = [
            {
                "type": "user_input" if message.role == "user" else "model_output",
                "content": [{"type": "text", "text": message.text}],
            }
            for message in history
        ]
        steps.append(
            {"type": "user_input", "content": [{"type": "text", "text": text}]}
        )
        try:
            async with asyncio.timeout(35):
                response = await self.client.post(
                    "https://generativelanguage.googleapis.com/v1beta/interactions",
                    headers={
                        "x-goog-api-key": self.api_key,
                        "Api-Revision": "2026-05-20",
                    },
                    json={
                        "model": self.model,
                        "store": False,
                        "system_instruction": SYSTEM_PROMPT,
                        "input": steps,
                        "generation_config": {
                            "max_output_tokens": 2048,
                            "thinking_level": "low",
                        },
                    },
                )
                response.raise_for_status()
                reply = "".join(
                    content["text"]
                    for step in response.json()["steps"]
                    if step["type"] == "model_output"
                    for content in step["content"]
                    if content["type"] == "text"
                ).strip()
        except (httpx.TimeoutException, TimeoutError) as error:
            raise ModelError(
                "Модель отвечает слишком долго. Попробуйте отправить сообщение ещё раз."
            ) from error
        except httpx.HTTPStatusError as error:
            status = error.response.status_code
            logger.warning("Gemini returned HTTP %s", status)
            if status == 429:
                raise ModelError(
                    "Достигнут лимит запросов к модели. Попробуйте чуть позже."
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
            logger.warning("Gemini generation failed (%s)", type(error).__name__)
            raise ModelError(
                "Не удалось получить ответ модели. Попробуйте ещё раз."
            ) from error
        if not reply:
            raise ModelError(
                "Модель вернула пустой ответ. Попробуйте переформулировать сообщение."
            )
        return reply


class DemoModel:
    async def reply(self, history: list[Message], text: str) -> str:
        await asyncio.sleep(0.5)
        if history:
            return (
                "Чтобы ответ прозвучал убедительнее, назовите один конкретный пример: "
                "что вы сделали и что изменилось.\n\n"
                "Следующий вопрос. Вспомните задачу с неопределёнными требованиями. "
                "Как вы решили, с чего начать?"
            )
        return (
            "Начнём с вопроса, который часто задают на интервью. Расскажите о проекте "
            "или рабочей задаче, где ваш личный вклад повлиял на результат."
        )
