from typing import List

from pydantic import field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    PORT: int = 8080
    ALLOWED_ORIGINS: List[str] = ["http://localhost:3000"]

    LIVEKIT_URL: str
    LIVEKIT_API_KEY: str
    LIVEKIT_API_SECRET: str

    @field_validator('ALLOWED_ORIGINS', mode='before')
    @classmethod
    def _split_origins(cls, value: List[str] | str) -> List[str]:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(',') if origin.strip()]
        return value

    class Config:
        env_file = ".env"


settings = Settings()
