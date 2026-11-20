from datetime import UTC, datetime
from pathlib import Path
from time import time

import aiosqlite

from app.schemas import Message, Turn


class Store:
    def __init__(self, path: Path):
        self.path = path

    async def initialize(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self.path) as db:
            await db.executescript("""
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY,
                    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                    text TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    expires_at REAL NOT NULL
                );
            """)

    async def history(self, *, limit: int = -1) -> list[Message]:
        async with aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            rows = await db.execute_fetchall(
                "SELECT * FROM messages ORDER BY id DESC LIMIT ?", (limit,)
            )
            return [Message.model_validate(dict(row)) for row in reversed(rows)]

    async def save_turn(self, user_text: str, user_time: datetime, reply: str) -> Turn:
        async with aiosqlite.connect(self.path) as db:
            user = await self._insert_message(db, "user", user_text, user_time)
            assistant = await self._insert_message(
                db, "assistant", reply, datetime.now(UTC)
            )
            await db.commit()
        return Turn(user=user, assistant=assistant)

    @staticmethod
    async def _insert_message(db, role, text, created_at) -> Message:
        async with db.execute(
            "INSERT INTO messages (role, text, created_at) VALUES (?, ?, ?)",
            (role, text, created_at.isoformat()),
        ) as cursor:
            return Message(
                id=cursor.lastrowid, role=role, text=text, created_at=created_at
            )

    async def save_session(
        self, token_hash: str, expires_at: float, previous_hash: str | None
    ):
        async with aiosqlite.connect(self.path) as db:
            await db.execute(
                "DELETE FROM sessions WHERE expires_at <= ? OR token_hash = ?",
                (time(), previous_hash),
            )
            await db.execute(
                "INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)",
                (token_hash, expires_at),
            )
            await db.commit()

    async def has_session(self, token_hash: str) -> bool:
        async with aiosqlite.connect(self.path) as db:
            rows = await db.execute_fetchall(
                "SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?",
                (token_hash, time()),
            )
        return bool(rows)

    async def delete_session(self, token_hash: str):
        async with aiosqlite.connect(self.path) as db:
            await db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
            await db.commit()
