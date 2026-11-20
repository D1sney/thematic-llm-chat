import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import router
from app.config import Settings, get_settings
from app.services.model import ChatModel, DemoModel, Gemini
from app.storage import Store

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"


def create_app(
    settings: Settings | None = None, *, model: ChatModel | None = None
) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.store = Store(settings.history_path)
        await app.state.store.initialize()
        app.state.turn_lock = asyncio.Lock()
        async with httpx.AsyncClient(timeout=30) as client:
            app.state.model = model
            if model is None:
                app.state.model = (
                    DemoModel()
                    if settings.demo_mode
                    else Gemini(
                        client,
                        settings.gemini_api_key.get_secret_value(),
                        settings.gemini_model,
                    )
                )
            yield

    app = FastAPI(title="LuChat", lifespan=lifespan)
    app.state.settings = settings

    @app.middleware("http")
    async def response_headers(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        if request.url.path in {"/", "/index.html"}:
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; object-src 'none'; base-uri 'none'; "
                "frame-ancestors 'none'; form-action 'self'"
            )
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, _error: RequestValidationError):
        if request.url.path.endswith("/session"):
            detail = "Используйте 8–255 символов: латинские буквы, цифры, дефис или подчёркивание."
        else:
            detail = "Введите сообщение длиной от 1 до 500 символов."
        return JSONResponse({"detail": detail}, status_code=422)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(router)
    app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
    return app
