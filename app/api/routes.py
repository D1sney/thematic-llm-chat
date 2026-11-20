import hmac
from datetime import UTC, datetime
from secrets import token_urlsafe
from time import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app.schemas import ChatInput, History, LoginInput, Turn
from app.services.model import ModelError

router = APIRouter(prefix="/api/v1")
SESSION_COOKIE = "interview_session"
CONTEXT_MESSAGES = 12


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
    return History(messages=await state.store.history(), demo=state.settings.demo_mode)


@router.post("/messages", status_code=201, dependencies=[Depends(require_session)])
async def send_message(body: ChatInput, request: Request) -> Turn:
    state = request.app.state
    if state.turn_lock.locked():
        raise HTTPException(
            409, "Интервьюер ещё готовит ответ. Подождите немного и попробуйте снова."
        )
    async with state.turn_lock:
        user_time = datetime.now(UTC)
        context = await state.store.history(limit=CONTEXT_MESSAGES)
        try:
            reply = await state.model.reply(context, body.text)
        except ModelError as error:
            raise HTTPException(502, str(error)) from error
        return await state.store.save_turn(body.text, user_time, reply)
