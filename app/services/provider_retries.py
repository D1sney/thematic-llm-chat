"""Retry temporary provider failures inside a turn, never the whole turn."""

from asyncio import sleep
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from math import isfinite
from random import uniform
from typing import TypeVar

import httpx

T = TypeVar("T")
MAX_RETRIES = 2
DELAYS = (1.0, 3.0)
PERMANENT_QUOTA_CODES = {
    "insufficient_quota",
    "credit_balance_exhausted",
    "billing_hard_limit_reached",
    "organization_usage_limit_exceeded",
    "insufficient_balance",
}


def retryable(error: httpx.HTTPError) -> bool:
    if isinstance(
        error, (httpx.NetworkError, httpx.TimeoutException, httpx.RemoteProtocolError)
    ):
        return True
    if not isinstance(error, httpx.HTTPStatusError):
        return False
    status = error.response.status_code
    if status == 429:
        try:
            body = error.response.json()
            details = body.get("error", body)
            if isinstance(details, dict) and any(
                str(details.get(key, "")) in PERMANENT_QUOTA_CODES
                for key in ("code", "type")
            ):
                return False
        except (ValueError, AttributeError):
            pass
        return True
    return status == 408 or status >= 500


def retry_delay(error: httpx.HTTPError, retry_count: int) -> float:
    delay = DELAYS[retry_count - 1] + uniform(0, 0.2)
    if not isinstance(error, httpx.HTTPStatusError):
        return delay
    value = error.response.headers.get("retry-after")
    if not value:
        return delay
    try:
        requested = float(value)
    except ValueError:
        try:
            requested = (
                parsedate_to_datetime(value) - datetime.now(UTC)
            ).total_seconds()
        except (ValueError, TypeError, OverflowError):
            return delay
    return max(delay, requested) if isfinite(requested) and requested > 0 else delay


async def retry_provider(
    operation: Callable[[], Awaitable[T]],
    on_retry: Callable[[int], Awaitable[None]] | None,
) -> T:
    for attempt in range(MAX_RETRIES + 1):
        try:
            return await operation()
        except httpx.HTTPError as error:
            if attempt == MAX_RETRIES or not retryable(error):
                raise
            retry_count = attempt + 1
            if on_retry:
                await on_retry(retry_count)
            await sleep(retry_delay(error, retry_count))
    raise AssertionError("Retry loop ended without a result")
