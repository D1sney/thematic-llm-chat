"""ASGI entry point for Vercel."""

from app.main import create_app

app = create_app()
