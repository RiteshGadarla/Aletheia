"""Lyra chat endpoint."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..chat.agent import chat

router = APIRouter()


class Msg(BaseModel):
    role: str
    content: str = Field(max_length=4000)


class ChatBody(BaseModel):
    messages: list[Msg] = Field(max_length=40)


@router.post("/chat")
def chat_ep(body: ChatBody) -> dict[str, Any]:
    return chat([m.model_dump() for m in body.messages])
