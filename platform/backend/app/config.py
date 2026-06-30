from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/pentest_platform"
    JWT_SECRET: str = "change-me-in-production"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_SECONDS: int = 86400  # 24 hours
    RABBITMQ_URL: str = "amqp://guest:guest@localhost:5672/"
    LLM_MODEL: str = "gpt-4o"
    LLM_API_KEY: str = ""
    LLM_BASE_URL: str = ""

    class Config:
        env_file = ".env"


settings = Settings()
