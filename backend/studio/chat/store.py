"""Chat session persistence & export formatting utilities for Lyra."""
from __future__ import annotations

import io
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("studio.chat_store")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _auto_title(messages: list[dict[str, Any]]) -> str:
    for m in messages:
        if m.get("role") == "user":
            content = str(m.get("content") or "").strip()
            if content:
                # Take first 45 chars or first line
                first_line = content.splitlines()[0]
                if len(first_line) > 45:
                    return first_line[:45].rstrip() + "…"
                return first_line
    return "New Chat"


class ChatSessionStore:
    """Thread-safe persistent store for Lyra chat sessions."""

    def __init__(self, filepath: str | None = None) -> None:
        self._lock = threading.RLock()
        self.filepath = filepath or os.path.join(os.getcwd(), ".chat_sessions.json")
        self._sessions: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        with self._lock:
            if not os.path.exists(self.filepath):
                return
            try:
                with open(self.filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        self._sessions = data
            except Exception as exc:
                log.warning(f"Failed to load chat sessions from {self.filepath}: {exc}")
                self._sessions = {}

    def _persist(self) -> None:
        with self._lock:
            try:
                parent = os.path.dirname(self.filepath)
                if parent:
                    os.makedirs(parent, exist_ok=True)
                with open(self.filepath, "w", encoding="utf-8") as f:
                    json.dump(self._sessions, f, ensure_ascii=False, indent=2)
            except Exception as exc:
                log.error(f"Failed to persist chat sessions to {self.filepath}: {exc}")

    def list_sessions(self) -> list[dict[str, Any]]:
        with self._lock:
            res = []
            for s_id, sess in self._sessions.items():
                messages = sess.get("messages", [])
                res.append({
                    "id": s_id,
                    "title": sess.get("title") or "Untitled Chat",
                    "created_at": sess.get("created_at") or _now_iso(),
                    "updated_at": sess.get("updated_at") or _now_iso(),
                    "message_count": len(messages),
                    "last_message": messages[-1].get("content", "") if messages else "",
                })
            res.sort(key=lambda x: str(x.get("updated_at")), reverse=True)
            return res

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        with self._lock:
            sess = self._sessions.get(session_id)
            return dict(sess) if sess else None

    def save_session(
        self,
        session_id: str | None,
        messages: list[dict[str, Any]],
        title: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            now = _now_iso()
            if not session_id:
                session_id = f"cs_{int(time.time() * 1000)}"

            existing = self._sessions.get(session_id)
            created_at = existing.get("created_at") if existing else now
            sess_title = title or (existing.get("title") if existing else None) or _auto_title(messages)

            session_data = {
                "id": session_id,
                "title": sess_title,
                "created_at": created_at,
                "updated_at": now,
                "messages": messages,
            }
            self._sessions[session_id] = session_data
            self._persist()
            return session_data

    def rename_session(self, session_id: str, title: str) -> dict[str, Any] | None:
        with self._lock:
            sess = self._sessions.get(session_id)
            if not sess:
                return None
            sess["title"] = title.strip() or "Untitled Chat"
            sess["updated_at"] = _now_iso()
            self._persist()
            return dict(sess)

    def delete_session(self, session_id: str) -> bool:
        with self._lock:
            if session_id in self._sessions:
                del self._sessions[session_id]
                self._persist()
                return True
            return False

    def clear_all(self) -> None:
        with self._lock:
            self._sessions.clear()
            self._persist()


def generate_chat_pdf(session: dict[str, Any]) -> bytes:
    """Generate a branded PDF export of a Lyra chat session."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    brand, ink, muted, line, soft = (colors.HexColor(c) for c in ("#1c58c9", "#0f172a", "#64748b", "#d5dce8", "#f8fafc"))
    user_bg, assistant_bg = colors.HexColor("#f1f5f9"), colors.HexColor("#eff6ff")
    base = getSampleStyleSheet()["Normal"]

    title_style = ParagraphStyle("t", parent=base, fontName="Helvetica-Bold", fontSize=18, leading=22, textColor=ink)
    meta_style = ParagraphStyle("m", parent=base, fontSize=9, leading=13, textColor=muted, spaceAfter=12)
    role_user = ParagraphStyle("ru", parent=base, fontName="Helvetica-Bold", fontSize=10, leading=13, textColor=brand)
    role_asst = ParagraphStyle("ra", parent=base, fontName="Helvetica-Bold", fontSize=10, leading=13, textColor=colors.HexColor("#0284c7"))
    msg_body = ParagraphStyle("mb", parent=base, fontSize=9.5, leading=14, textColor=ink)
    sql_style = ParagraphStyle("sql", parent=base, fontName="Courier", fontSize=8, leading=11, textColor=colors.HexColor("#334155"))
    tbl_cell = ParagraphStyle("tc", parent=base, fontSize=8, leading=10, textColor=ink)
    tbl_head = ParagraphStyle("th", parent=tbl_cell, fontName="Helvetica-Bold")

    def esc(v: Any) -> str:
        return str(v if v is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br/>")

    def banner(canvas: Any, doc: Any) -> None:
        w, h = letter
        canvas.saveState()
        canvas.setFillColor(brand)
        canvas.rect(0, h - 54, w, 54, stroke=0, fill=1)
        canvas.setFillColor(colors.white)
        # Logo mark: hexagon + triangle
        ox, oy, sc = 36, h - 45, 1.4
        pt = lambda x, y: (ox + x * sc, oy + (24 - y) * sc)  # noqa: E731
        canvas.setStrokeColor(colors.white)
        canvas.setLineWidth(1.6)
        canvas.setLineJoin(1)
        for poly in ([(12, 3), (20, 7.5), (20, 16.5), (12, 21), (4, 16.5), (4, 7.5)], [(12, 8.2), (15.4, 15.8), (8.6, 15.8)]):
            path = canvas.beginPath()
            path.moveTo(*pt(*poly[0]))
            for q in poly[1:]:
                path.lineTo(*pt(*q))
            path.close()
            canvas.drawPath(path, stroke=1, fill=0)
        canvas.setFont("Helvetica-Bold", 18)
        canvas.drawString(36 + 24 * sc + 8, h - 35, "ALETHEIA")
        canvas.setFont("Helvetica", 9)
        canvas.drawRightString(w - 36, h - 33, "Lyra Chat Export")
        canvas.setFillColor(muted)
        canvas.setFont("Helvetica", 8)
        canvas.drawString(36, 22, "Aletheia Studio  |  Lyra Assistant Conversation Log")
        canvas.drawRightString(w - 36, 22, f"Page {doc.page}")
        canvas.restoreState()

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=36,
        rightMargin=36,
        topMargin=78,
        bottomMargin=44,
        title=session.get("title", "Lyra Chat"),
        author="Aletheia Lyra",
    )

    story: list[Any] = []
    sess_title = session.get("title") or "Lyra Chat Session"
    created_at = session.get("created_at") or ""
    updated_at = session.get("updated_at") or ""

    story.append(Paragraph(esc(sess_title), title_style))
    story.append(Paragraph(f"Exported: {esc(_now_iso()[:19].replace('T', ' '))} UTC &nbsp;|&nbsp; Created: {esc(created_at[:19].replace('T', ' '))} &nbsp;|&nbsp; Messages: {len(session.get('messages', []))}", meta_style))
    story.append(Spacer(1, 8))

    for idx, msg in enumerate(session.get("messages", [])):
        role = msg.get("role", "user")
        content = msg.get("content", "")
        blocks = msg.get("blocks", [])

        is_user = role == "user"
        role_label = "USER" if is_user else "LYRA ASSISTANT"
        r_style = role_user if is_user else role_asst
        bg_color = user_bg if is_user else assistant_bg

        card_content: list[Any] = [
            Paragraph(f"#{idx + 1} {role_label}", r_style),
            Spacer(1, 3),
            Paragraph(esc(content), msg_body),
        ]

        if blocks and isinstance(blocks, list):
            for block in blocks:
                if isinstance(block, dict) and block.get("type") == "table":
                    sql = block.get("sql", "")
                    rows = block.get("rows", [])
                    if sql:
                        card_content.append(Spacer(1, 4))
                        card_content.append(Paragraph(f"<b>Query executed:</b> <font face='Courier'>{esc(sql)}</font>", sql_style))
                    if rows and isinstance(rows, list):
                        cols = list(rows[0].keys()) if isinstance(rows[0], dict) else []
                        if cols:
                            table_data = [[Paragraph(esc(c), tbl_head) for c in cols[:6]]]
                            for r in rows[:10]:
                                if isinstance(r, dict):
                                    table_data.append([Paragraph(esc(str(r.get(c, ""))), tbl_cell) for c in cols[:6]])
                            col_width = max(60, int(500 / max(1, len(cols[:6]))))
                            t = Table(table_data, colWidths=[col_width] * len(cols[:6]))
                            t.setStyle(TableStyle([
                                ("BOX", (0, 0), (-1, -1), 0.5, line),
                                ("INNERGRID", (0, 0), (-1, -1), 0.5, line),
                                ("BACKGROUND", (0, 0), (-1, 0), soft),
                                ("TOPPADDING", (0, 0), (-1, -1), 3),
                                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                            ]))
                            card_content.append(Spacer(1, 4))
                            card_content.append(t)

        msg_table = Table([[card_content]], colWidths=[540])
        msg_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), bg_color),
            ("BOX", (0, 0), (-1, -1), 0.5, line),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ]))

        story.append(msg_table)
        story.append(Spacer(1, 10))

    doc.build(story, onFirstPage=banner, onLaterPages=banner)
    return buf.getvalue()


def export_chat_session(session: dict[str, Any], fmt: str = "pdf") -> tuple[bytes | str, str, str]:
    """Format chat session data into (content, mime_type, extension)."""
    fmt = (fmt or "pdf").lower().strip()
    title = session.get("title") or "Lyra Chat"
    clean_title = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in title.lower()).strip("_") or "chat"

    if fmt == "pdf":
        pdf_bytes = generate_chat_pdf(session)
        return pdf_bytes, "application/pdf", "pdf"

    if fmt in ("markdown", "md"):
        lines = [
            f"# {title}",
            f"_Exported at {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}_",
            "",
        ]
        for idx, msg in enumerate(session.get("messages", [])):
            role_name = "User" if msg.get("role") == "user" else "Lyra"
            lines.append(f"### #{idx + 1} {role_name}")
            lines.append(msg.get("content", ""))
            lines.append("")
            blocks = msg.get("blocks", [])
            if blocks and isinstance(blocks, list):
                for b in blocks:
                    if isinstance(b, dict) and b.get("type") == "table":
                        lines.append(f"```sql\n{b.get('sql', '')}\n```")
                        rows = b.get("rows", [])
                        if rows and isinstance(rows, list) and isinstance(rows[0], dict):
                            cols = list(rows[0].keys())
                            lines.append("| " + " | ".join(cols) + " |")
                            lines.append("| " + " | ".join(["---"] * len(cols)) + " |")
                            for r in rows[:20]:
                                lines.append("| " + " | ".join(str(r.get(c, "")) for c in cols) + " |")
                            lines.append("")
        return "\n".join(lines), "text/markdown", "md"

    if fmt == "json":
        return json.dumps(session, ensure_ascii=False, indent=2), "application/json", "json"

    # Default: text
    lines = [f"=== {title} ===", f"Exported: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}\n"]
    for idx, msg in enumerate(session.get("messages", [])):
        role_name = "USER" if msg.get("role") == "user" else "LYRA ASSISTANT"
        lines.append(f"[{role_name}] #{idx + 1}")
        lines.append(msg.get("content", ""))
        lines.append("-" * 40)
    return "\n".join(lines), "text/plain", "txt"
