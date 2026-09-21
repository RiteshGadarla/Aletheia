"""Lyra chat endpoints with history persistence and export capabilities."""
from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .state import get_state
from ..chat.agent import chat, chat_stream_events
from ..chat.store import export_chat_session

router = APIRouter()


class Msg(BaseModel):
    role: str
    content: str = Field(max_length=4000)
    blocks: list[dict[str, Any]] | None = None


class ChatBody(BaseModel):
    messages: list[Msg] = Field(max_length=40)
    session_id: str | None = Field(default=None, description="Optional chat session ID to append turn")
    title: str | None = Field(default=None, description="Optional custom session title")


class RenameBody(BaseModel):
    title: str = Field(min_length=1, max_length=100)


@router.get("/chat/sessions")
def list_chat_sessions() -> dict[str, Any]:
    """List all stored chat session summaries."""
    st = get_state()
    sessions = st.chat_store.list_sessions()
    return {"sessions": sessions}


@router.get("/chat/sessions/{session_id}")
def get_chat_session(session_id: str) -> dict[str, Any]:
    """Get full details and messages of a specific chat session."""
    st = get_state()
    sess = st.chat_store.get_session(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Chat session not found")
    return sess


@router.patch("/chat/sessions/{session_id}")
def rename_chat_session(session_id: str, body: RenameBody) -> dict[str, Any]:
    """Rename a chat session."""
    st = get_state()
    sess = st.chat_store.rename_session(session_id, body.title)
    if not sess:
        raise HTTPException(status_code=404, detail="Chat session not found")
    return sess


@router.delete("/chat/sessions/{session_id}")
def delete_chat_session(session_id: str) -> dict[str, Any]:
    """Delete a chat session."""
    st = get_state()
    ok = st.chat_store.delete_session(session_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Chat session not found")
    return {"ok": True, "deleted": session_id}


@router.delete("/chat/sessions")
def clear_chat_sessions() -> dict[str, Any]:
    """Clear all stored chat sessions."""
    st = get_state()
    st.chat_store.clear_all()
    return {"ok": True}


@router.get("/chat/export")
def export_chat(
    session_id: str = Query("", description="Chat session ID to export, or empty for latest"),
    format: str = Query("pdf", description="Export format: pdf, markdown, json, text"),
) -> Response:
    """Export chat session transcript to PDF, Markdown, JSON or Text."""
    st = get_state()
    if session_id:
        sess = st.chat_store.get_session(session_id)
    else:
        sessions = st.chat_store.list_sessions()
        sess = st.chat_store.get_session(sessions[0]["id"]) if sessions else None

    if not sess:
        raise HTTPException(status_code=404, detail="No chat session available to export")

    content, media_type, ext = export_chat_session(sess, fmt=format)
    title_slug = "".join(c if c.isalnum() else "_" for c in sess.get("title", "lyra_chat").lower()).strip("_")
    filename = f"lyra-chat-{title_slug[:30]}-{int(time.time())}.{ext}"

    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/chat/stream")
def chat_stream_ep(body: ChatBody) -> StreamingResponse:
    """Stream real-time agent execution step events and final result."""
    st = get_state()
    messages_payload = [{"role": m.role, "content": m.content} for m in body.messages]

    def event_generator():
        saved_session_id = body.session_id
        saved_session_title = body.title

        for event in chat_stream_events(messages_payload):
            if event["type"] == "done" and event.get("available", True):
                # Save chat session on completion
                updated_messages: list[dict[str, Any]] = []
                for m in body.messages:
                    item: dict[str, Any] = {"role": m.role, "content": m.content}
                    if m.blocks:
                        item["blocks"] = m.blocks
                    updated_messages.append(item)

                assistant_msg: dict[str, Any] = {"role": "assistant", "content": event.get("answer", "")}
                if event.get("blocks"):
                    assistant_msg["blocks"] = event["blocks"]
                updated_messages.append(assistant_msg)

                saved_session = st.chat_store.save_session(
                    session_id=saved_session_id,
                    messages=updated_messages,
                    title=saved_session_title,
                )
                event["session_id"] = saved_session["id"]
                event["session_title"] = saved_session["title"]

            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.post("/chat")
def chat_ep(body: ChatBody) -> dict[str, Any]:
    """Execute a chat turn with Lyra and persist conversation thread."""
    st = get_state()
    messages_payload = [{"role": m.role, "content": m.content} for m in body.messages]
    result = chat(messages_payload)

    # Build updated full message turns history including blocks
    updated_messages: list[dict[str, Any]] = []
    for m in body.messages:
        item: dict[str, Any] = {"role": m.role, "content": m.content}
        if m.blocks:
            item["blocks"] = m.blocks
        updated_messages.append(item)

    # Append assistant's answer and blocks
    assistant_msg: dict[str, Any] = {"role": "assistant", "content": result.get("answer", "")}
    if result.get("blocks"):
        assistant_msg["blocks"] = result["blocks"]
    updated_messages.append(assistant_msg)

    saved_session = st.chat_store.save_session(
        session_id=body.session_id,
        messages=updated_messages,
        title=body.title,
    )

    result["session_id"] = saved_session["id"]
    result["session_title"] = saved_session["title"]
    return result
