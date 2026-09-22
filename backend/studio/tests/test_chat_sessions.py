"""Tests for Chat Session History persistence and PDF/Markdown exports."""
from __future__ import annotations

import tempfile
from typing import Any

from studio.api.state import get_state
from studio.chat.store import ChatSessionStore, export_chat_session


def test_chat_session_store_crud() -> None:
    with tempfile.NamedTemporaryFile(suffix=".json") as tmp:
        store = ChatSessionStore(filepath=tmp.name)

        # 1. Save new session
        messages = [
            {"role": "user", "content": "How many events did we ingest?"},
            {"role": "assistant", "content": "We ingested 10,000 events in the last hour.", "blocks": [{"type": "table", "sql": "SELECT count() FROM events", "rows": [{"count()": 10000}]}]},
        ]
        sess = store.save_session(session_id=None, messages=messages)
        assert sess["id"].startswith("cs_")
        assert "events did we ingest" in sess["title"]
        assert len(sess["messages"]) == 2

        # 2. Get session
        retrieved = store.get_session(sess["id"])
        assert retrieved is not None
        assert retrieved["title"] == sess["title"]

        # 3. List sessions
        summaries = store.list_sessions()
        assert len(summaries) == 1
        assert summaries[0]["id"] == sess["id"]
        assert summaries[0]["message_count"] == 2

        # 4. Rename session
        store.rename_session(sess["id"], "Event Count Analysis")
        updated = store.get_session(sess["id"])
        assert updated is not None
        assert updated["title"] == "Event Count Analysis"

        # 5. Delete session
        deleted = store.delete_session(sess["id"])
        assert deleted is True
        assert store.get_session(sess["id"]) is None


def test_chat_export_formats() -> None:
    session_data = {
        "id": "cs_test123",
        "title": "Top Source IPs Query",
        "created_at": "2026-09-22T03:00:00Z",
        "updated_at": "2026-09-22T03:05:00Z",
        "messages": [
            {"role": "user", "content": "Show top 5 source IPs with denied traffic"},
            {
                "role": "assistant",
                "content": "Here are the top source IPs with denied traffic:",
                "blocks": [
                    {
                        "type": "table",
                        "sql": "SELECT src_ip, count() AS cnt FROM events WHERE action_id=2 GROUP BY src_ip ORDER BY cnt DESC LIMIT 5",
                        "rows": [
                            {"src_ip": "192.168.1.50", "cnt": 1420},
                            {"src_ip": "10.0.0.12", "cnt": 890},
                        ],
                    }
                ],
            },
        ],
    }

    # 1. PDF Export
    pdf_content, mime_pdf, ext_pdf = export_chat_session(session_data, fmt="pdf")
    assert mime_pdf == "application/pdf"
    assert ext_pdf == "pdf"
    assert isinstance(pdf_content, bytes)
    assert pdf_content.startswith(b"%PDF")

    # 2. Markdown Export
    md_content, mime_md, ext_md = export_chat_session(session_data, fmt="markdown")
    assert mime_md == "text/markdown"
    assert ext_md == "md"
    assert "# Top Source IPs Query" in md_content
    assert "192.168.1.50" in md_content

    # 3. JSON Export
    json_content, mime_json, ext_json = export_chat_session(session_data, fmt="json")
    assert mime_json == "application/json"
    assert ext_json == "json"
    assert "cs_test123" in json_content

    # 4. Text Export
    txt_content, mime_txt, ext_txt = export_chat_session(session_data, fmt="text")
    assert mime_txt == "text/plain"
    assert ext_txt == "txt"
    assert "Top Source IPs Query" in txt_content


def test_chat_session_api_endpoints(client: Any) -> None:
    st = get_state()
    st.chat_store.clear_all()

    # 1. POST /chat to create a turn and auto-create session
    r1 = client.post("/api/v1/chat", json={"messages": [{"role": "user", "content": "Which sources are connected?"}]})
    assert r1.status_code == 200
    b1 = r1.json()
    assert "session_id" in b1
    assert "session_title" in b1
    sess_id = b1["session_id"]

    # 2. GET /chat/sessions to list summaries
    r2 = client.get("/api/v1/chat/sessions")
    assert r2.status_code == 200
    b2 = r2.json()
    assert len(b2["sessions"]) >= 1
    assert b2["sessions"][0]["id"] == sess_id

    # 3. GET /chat/sessions/{session_id} to fetch full session
    r3 = client.get(f"/api/v1/chat/sessions/{sess_id}")
    assert r3.status_code == 200
    b3 = r3.json()
    assert b3["id"] == sess_id
    assert len(b3["messages"]) == 2

    # 4. GET /chat/export with PDF format
    r4 = client.get(f"/api/v1/chat/export?session_id={sess_id}&format=pdf")
    assert r4.status_code == 200
    assert r4.headers["content-type"] == "application/pdf"
    assert "attachment; filename=" in r4.headers["content-disposition"]

    # 5. GET /chat/export with Markdown format
    r5 = client.get(f"/api/v1/chat/export?session_id={sess_id}&format=markdown")
    assert r5.status_code == 200
    assert r5.headers["content-type"].startswith("text/markdown")

    # 6. DELETE /chat/sessions/{session_id}
    r6 = client.delete(f"/api/v1/chat/sessions/{sess_id}")
    assert r6.status_code == 200
    assert r6.json()["ok"] is True


def test_system_reset_clears_chat_sessions(client: Any) -> None:
    # Create a chat session
    r1 = client.post("/api/v1/chat", json={"messages": [{"role": "user", "content": "Test prompt before reset"}]})
    assert r1.status_code == 200
    sess_id = r1.json()["session_id"]

    # Verify session exists
    r2 = client.get("/api/v1/chat/sessions")
    assert len(r2.json()["sessions"]) >= 1

    # Trigger system data reset
    r_reset = client.post("/api/v1/settings/reset")
    assert r_reset.status_code == 200

    # Verify chat history is cleared
    r3 = client.get("/api/v1/chat/sessions")
    assert len(r3.json()["sessions"]) == 0

