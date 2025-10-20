from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter
from slowapi.util import get_remote_address

from .api.health import router as health_router
from .api.livekit_auth import router as livekit_router
from .core.config import settings
from .core.logging import setup_logging


def create_app() -> FastAPI:
    setup_logging()
    app = FastAPI(title="Scoop Kiosk Backend")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.limiter = Limiter(key_func=get_remote_address)

    app.include_router(health_router, prefix="", tags=["health"])
    app.include_router(livekit_router, prefix="/api/livekit", tags=["livekit"])

    return app


app = create_app()
