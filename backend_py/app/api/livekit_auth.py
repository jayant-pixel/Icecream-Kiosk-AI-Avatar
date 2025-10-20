from fastapi import APIRouter
from pydantic import BaseModel

from ..core.config import settings
from ..services.livekit_tokens import mint_join_token

router = APIRouter()


class TokenRequest(BaseModel):
    identity: str
    room: str | None = None
    name: str | None = None


class TokenResponse(BaseModel):
    url: str
    token: str


@router.post("/token", response_model=TokenResponse)
async def create_token(body: TokenRequest) -> TokenResponse:
    jwt = mint_join_token(identity=body.identity, room=body.room, name=body.name)
    return TokenResponse(url=settings.LIVEKIT_URL, token=jwt)
