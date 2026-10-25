from functools import lru_cache
from typing import Literal
from urllib.parse import quote

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import URL


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: Literal["development", "production"] = "development"
    postgres_host: str = "postgres"
    postgres_port: int = 5432
    postgres_db: str = "app"
    postgres_user: str = "app"
    postgres_password: SecretStr = SecretStr("development-only")
    redis_host: str = "redis"
    redis_port: int = 6379
    redis_password: SecretStr = SecretStr("development-only")
    rabbitmq_host: str = "rabbitmq"
    rabbitmq_port: int = 5672
    rabbitmq_user: str = "app"
    rabbitmq_password: SecretStr = SecretStr("development-only")
    rabbitmq_vhost: str = "app"
    api_token: SecretStr = SecretStr("")
    allowed_hosts: list[str] = ["localhost", "127.0.0.1", "testserver"]
    cors_origins: list[str] = []

    @model_validator(mode="after")
    def validate_production(self) -> "Settings":
        if self.environment == "production":
            secrets = [self.postgres_password, self.redis_password, self.rabbitmq_password]
            if any(
                len(value.get_secret_value()) < 16 or value.get_secret_value() == "development-only"
                for value in secrets
            ):
                raise ValueError("Production service passwords must contain at least 16 characters")
            if len(self.api_token.get_secret_value()) < 32:
                raise ValueError("Production API_TOKEN must contain at least 32 characters")
            if not self.allowed_hosts or "*" in self.allowed_hosts:
                raise ValueError("Production ALLOWED_HOSTS must contain explicit hostnames")
        return self

    @property
    def database_url(self) -> URL:
        return URL.create(
            "postgresql+psycopg",
            username=self.postgres_user,
            password=self.postgres_password.get_secret_value(),
            host=self.postgres_host,
            port=self.postgres_port,
            database=self.postgres_db,
        )

    def redis_url(self, database: int = 0) -> str:
        password = quote(self.redis_password.get_secret_value(), safe="")
        return f"redis://:{password}@{self.redis_host}:{self.redis_port}/{database}"

    @property
    def broker_url(self) -> str:
        user = quote(self.rabbitmq_user, safe="")
        password = quote(self.rabbitmq_password.get_secret_value(), safe="")
        vhost = quote(self.rabbitmq_vhost, safe="")
        return f"amqp://{user}:{password}@{self.rabbitmq_host}:{self.rabbitmq_port}/{vhost}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
