# SPDX-License-Identifier: AGPL-3.0-or-later

from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import AsyncOpenAI, OpenAIError
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


class Settings(BaseSettings):
    openai_api_key: str | None = None
    openai_model: str = "gpt-4o-mini"
    openai_base_url: str | None = None
    cors_origins: str = "http://localhost:3100,http://127.0.0.1:3100"

    model_config = SettingsConfigDict(env_file=str(ENV_FILE), extra="ignore")

    @property
    def allowed_origins(self) -> list[str]:
        return [
            origin.strip()
            for origin in self.cors_origins.split(",")
            if origin.strip()
        ]


settings = Settings()

app = FastAPI(
    title="AI Assistant API",
    description="FastAPI backend for the standalone Next.js AI chatbot.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str = Field(..., min_length=1)


class ChatRequest(BaseModel):
    conversation_id: str | None = None
    messages: list[ChatMessage] = Field(..., min_length=1)


class AssistantMessage(BaseModel):
    id: str
    role: Literal["assistant"]
    content: str


class ChatResponse(BaseModel):
    conversation_id: str
    message: AssistantMessage
    model: str


@app.get("/health")
async def health() -> dict[str, str | bool]:
    return {
        "status": "ok",
        "openai_configured": bool(settings.openai_api_key),
        "model": settings.openai_model,
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    if not settings.openai_api_key:
        raise HTTPException(
            status_code=500,
            detail="OPENAI_API_KEY is not configured. Copy .env.example to .env and set a key.",
        )

    client = AsyncOpenAI(
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url or None,
    )

    try:
        completion = await client.chat.completions.create(
            model=settings.openai_model,
            messages=[
                {"role": message.role, "content": message.content}
                for message in request.messages
            ],
        )
    except OpenAIError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"OpenAI request failed: {exc}",
        ) from exc

    content = completion.choices[0].message.content
    if not content:
        raise HTTPException(
            status_code=502,
            detail="OpenAI returned an empty assistant response.",
        )

    return ChatResponse(
        conversation_id=request.conversation_id or f"conv_{uuid4().hex}",
        message=AssistantMessage(
            id=f"msg_{uuid4().hex}",
            role="assistant",
            content=content,
        ),
        model=settings.openai_model,
    )
