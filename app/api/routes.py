import hmac
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from secrets import token_urlsafe
from time import time
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app.schemas import ChatInput, Feedback, History, LoginInput, Turn
from app.services.model import ModelError

router = APIRouter(prefix="/api/v1")
SESSION_COOKIE = "interview_session"


def token_hash(request: Request, token: str) -> str:
    key = request.app.state.settings.access_key.get_secret_value().encode()
    return hmac.digest(key, token.encode(), "sha256").hex()


async def require_session(request: Request):
    token = request.cookies.get(SESSION_COOKIE)
    if not token or not await request.app.state.store.has_session(
        token_hash(request, token)
    ):
        raise HTTPException(401, "Войдите по ключу доступа.")


@router.post("/session", status_code=204)
async def login(body: LoginInput, request: Request, response: Response):
    settings = request.app.state.settings
    if not hmac.compare_digest(
        body.key.encode(), settings.access_key.get_secret_value().encode()
    ):
        raise HTTPException(
            401, "Ключ доступа не подошёл. Проверьте его и попробуйте снова."
        )

    token = token_urlsafe(32)
    old = request.cookies.get(SESSION_COOKIE)
    await request.app.state.store.save_session(
        token_hash(request, token),
        time() + settings.session_ttl_seconds,
        token_hash(request, old) if old else None,
    )
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="strict",
        secure=settings.secure_cookie or request.url.scheme == "https",
        max_age=settings.session_ttl_seconds,
    )


@router.delete("/session", status_code=204)
async def logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        await request.app.state.store.delete_session(token_hash(request, token))
    response.delete_cookie(SESSION_COOKIE, httponly=True, samesite="strict")


@router.get("/messages", dependencies=[Depends(require_session)])
async def history(request: Request) -> History:
    state = request.app.state
    branch_id = await state.store.active_branch()
    versions, ratings = await state.store.metadata(branch_id)
    return History(
        messages=await state.store.history(branch_id),
        demo=state.settings.demo_mode,
        branch_id=branch_id,
        versions=versions,
        ratings=ratings,
    )


@router.post("/messages", status_code=201, dependencies=[Depends(require_session)])
async def send_message(body: ChatInput, request: Request) -> Turn:
    async with exclusive_turn(request, body.request_id) as request_id:
        return await generate_turn(body, request, request_id)


@router.put("/messages/{message_id}", dependencies=[Depends(require_session)])
async def edit_message(message_id: int, body: ChatInput, request: Request) -> History:
    async with exclusive_turn(request, body.request_id) as request_id:
        await generate_turn(body, request, request_id, edit_id=message_id)
        return await history(request)


async def generate_turn(
    body: ChatInput, request: Request, request_id: str, *, edit_id: int | None = None
) -> Turn:
    state = request.app.state
    branch_id = await state.store.active_branch()
    if body.branch_id is not None and body.branch_id != branch_id:
        raise HTTPException(409, "Версия диалога изменилась. Обновите страницу.")
    if edit_id is not None:
        messages = await state.store.history(branch_id)
        if not any(
            message.id == edit_id and message.role == "user" for message in messages
        ):
            raise HTTPException(404, "Сообщение не найдено в текущей версии.")
    user_time = datetime.now(UTC)
    context = await state.store.history(branch_id, before=edit_id)

    async def on_retry(count: int):
        await state.store.set_retry_count(request_id, count)

    try:
        reply = await state.model.reply(context, body.text, on_retry)
    except ModelError as error:
        raise HTTPException(502, str(error)) from error
    return await state.store.save_turn(
        branch_id, body.text, user_time, reply, edit_id=edit_id
    )


@asynccontextmanager
async def exclusive_turn(request: Request, request_id: UUID | None = None):
    reference = str(request_id or uuid4())
    async with request.app.state.store.reserve_turn(reference) as acquired:
        if not acquired:
            raise HTTPException(
                409, "Интервьюер ещё готовит ответ. Попробуйте чуть позже."
            )
        yield reference


@router.get("/reply-state/{request_id}", dependencies=[Depends(require_session)])
async def reply_state(request: Request, request_id: UUID):
    return {"retry_count": await request.app.state.store.retry_count(str(request_id))}


@router.post("/branches/{branch_id}", dependencies=[Depends(require_session)])
async def switch_branch(branch_id: int, request: Request) -> History:
    state = request.app.state
    async with exclusive_turn(request):
        if not await state.store.select_branch(branch_id):
            raise HTTPException(404, "Версия диалога не найдена.")
        return await history(request)


@router.put(
    "/messages/{message_id}/feedback",
    status_code=204,
    dependencies=[Depends(require_session)],
)
async def feedback(message_id: int, body: Feedback, request: Request):
    if not await request.app.state.store.save_rating(message_id, body.rating):
        raise HTTPException(404, "Сообщение не найдено.")
