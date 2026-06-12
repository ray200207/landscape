from pydantic_settings import BaseSettings
from typing import Optional, List


class Settings(BaseSettings):
    database_url: str = "sqlite+aiosqlite:///./landscape.db"
    gemini_api_key: Optional[str] = None
    use_mock_ai: bool = True
    max_file_size_bytes: int = 4 * 1024 * 1024  # 4 MB
    allowed_mime_types: List[str] = ["image/jpeg", "image/png", "image/webp"]

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
