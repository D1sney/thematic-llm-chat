import asyncio
import base64
import hashlib
import logging
from time import monotonic
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from app.api.routes import require_session
from app.services.model import POLZA_BASE_URL

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/audio", dependencies=[Depends(require_session)])
MAX_AUDIO_BYTES = 3 * 1024 * 1024
FORMATS = {"audio/webm", "audio/mp4", "audio/ogg", "audio/wav", "audio/mpeg"}


def valid_audio(data: bytes, media_type: str) -> bool:
    if media_type == "audio/webm":
        return data.startswith(b"\x1aE\xdf\xa3")
    if media_type == "audio/ogg":
        return data.startswith(b"OggS")
    if media_type == "audio/mp4":
        return len(data) > 12 and data[4:8] == b"ftyp"
    if media_type == "audio/wav":
        return data.startswith(b"RIFF") and data[8:12] == b"WAVE"
    return data.startswith(b"ID3") or (
        len(data) > 2 and data[0] == 255 and data[1] & 224 == 224
    )


def error(status: int, code: str):
    return JSONResponse({"error": {"code": code}}, status_code=status)


async def recognize(client, settings, audio: bytes, media_type: str) -> str:
    response = await client.post(
        f"{POLZA_BASE_URL}/media",
        headers={
            "Authorization": f"Bearer {settings.polza_ai_api_key.get_secret_value()}"
        },
        json={
            "model": settings.polza_stt_model,
            "async": False,
            "input": {
                "file": f"data:{media_type};base64,"
                + base64.b64encode(audio).decode("ascii"),
                "language": "ru",
                "response_format": "json",
            },
        },
        timeout=90,
    )
    response.raise_for_status()
    body = response.json()
    data = body.get("data", body)
    if isinstance(data, list):
        data = next(
            (
                item
                for item in data
                if isinstance(item, dict) and item.get("type") == "transcription"
            ),
            {},
        )
    text = data.get("text")
    return text.strip() if isinstance(text, str) else ""


@router.post("/transcriptions")
async def transcriptions(request: Request, request_id: UUID):
    state = request.app.state
    if state.settings.demo_mode:
        return error(503, "TRANSCRIPTION_NOT_CONFIGURED")
    media_type = (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    )
    if media_type not in FORMATS:
        return error(415, "AUDIO_FORMAT")
    audio = bytearray()
    async for chunk in request.stream():
        if len(audio) + len(chunk) > MAX_AUDIO_BYTES:
            return error(413, "AUDIO_TOO_LARGE")
        audio.extend(chunk)
    if not valid_audio(audio, media_type):
        return error(400, "AUDIO_FORMAT")

    # A short-lived receipt lets the recorder retry the same request without
    # keeping audio or billing twice after a successful transcription.
    receipts = state.voice_requests
    now = monotonic()
    for key, receipt in list(receipts.items()):
        if receipt[2] < now:
            del receipts[key]
    digest = hashlib.sha256(audio).digest()
    if request_id in receipts:
        previous_digest, text, _expires = receipts[request_id]
        if previous_digest != digest or text is None:
            return error(409, "TRANSCRIPTION_RUNNING")
        return {"text": text, "request_id": request_id}
    if len(receipts) >= 128 or any(item[1] is None for item in receipts.values()):
        return error(429, "TRANSCRIPTION_RATE_LIMITED")
    receipts[request_id] = (digest, None, now + 120)
    try:
        async with asyncio.timeout(95):
            text = await recognize(state.http, state.settings, audio, media_type)
        if not text:
            return error(502, "TRANSCRIPTION_EMPTY")
        receipts[request_id] = (digest, text, monotonic() + 600)
        return {"text": text, "request_id": request_id}
    except (httpx.TimeoutException, TimeoutError):
        return error(504, "TRANSCRIPTION_TIMEOUT")
    except httpx.HTTPStatusError as exc:
        logger.warning("Polza transcription returned HTTP %s", exc.response.status_code)
        if exc.response.status_code == 429:
            return error(429, "TRANSCRIPTION_RATE_LIMITED")
        return error(502, "TRANSCRIPTION_UNAVAILABLE")
    except (httpx.RequestError, ValueError, TypeError, AttributeError):
        return error(502, "TRANSCRIPTION_UNAVAILABLE")
    finally:
        if receipts[request_id][1] is None:
            del receipts[request_id]
