from livekit import api as lk

from ..core.config import settings


def mint_join_token(identity: str, room: str | None = None, name: str | None = None) -> str:
    token = (
        lk.AccessToken(api_key=settings.LIVEKIT_API_KEY, api_secret=settings.LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_grants(
            lk.VideoGrants(
                room_join=True,
                room=room or "scoop-kiosk",
            )
        )
    )
    if name:
        token = token.with_name(name)
    return token.to_jwt()
