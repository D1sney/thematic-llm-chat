from contextlib import asynccontextmanager
from pathlib import Path

import aiosqlite
import psycopg


class PostgresConnection:
    """Use the same parameterized SQL in SQLite and PostgreSQL."""

    def __init__(self, connection):
        self.connection = connection

    async def execute(self, sql, values=()):
        return await self.connection.execute(sql.replace("?", "%s"), values)

    async def execute_fetchall(self, sql, values=()):
        async with await self.execute(sql, values) as cursor:
            return await cursor.fetchall()

    async def executemany(self, sql, values):
        async with self.connection.cursor() as cursor:
            await cursor.executemany(sql.replace("?", "%s"), values)

    async def commit(self):
        await self.connection.commit()


@asynccontextmanager
async def connect(target: Path | str):
    if isinstance(target, Path):
        async with aiosqlite.connect(target) as connection:
            yield connection
    else:
        async with await psycopg.AsyncConnection.connect(
            target, prepare_threshold=None
        ) as connection:
            yield PostgresConnection(connection)
