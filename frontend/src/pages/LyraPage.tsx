import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Spinner } from '../components/Bits';
import {
  IconChevronLeft,
  IconChevronRight,
  IconExport,
  IconHistory,
  IconOff,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTrash,
  IconUser,
} from '../components/Icons';
import { api, errMessage } from '../lib/api';
import { useSettings } from '../lib/settings';
import type { ChatBlock, ChatExportFormat, ChatMessage, ChatSessionSummary } from '../lib/types';
import lyraIcon from '../assets/lyra-icon.png';

type Turn = ChatMessage & { blocks?: ChatBlock[] };

const SUGGESTIONS = [
  'How many events did we ingest in the last hour?',
  'Top 5 source IPs with denied traffic',
  'Which sources are connected and approved?',
  'Show event counts by severity',
];

function ResultTable({ block }: { block: ChatBlock }) {
  const cols = block.rows.length ? Object.keys(block.rows[0]) : [];
  const sources = Array.from(
    new Set(
      block.rows
        .map((r) => String(r.source_id || r.source || ''))
        .filter(Boolean),
    ),
  );

  return (
    <div className="lyra-table-wrap">
      <details className="lyra-citation">
        <summary className="lyra-citation-summary">
          <IconSearch size={13} />
          <span>Citation: Source Data Provenance ({block.rows.length} rows returned)</span>
        </summary>
        <div className="lyra-citation-body">
          <div className="lyra-citation-grid">
            <div className="lyra-citation-item">
              <span className="lyra-citation-label">Data Store Source</span>
              <span className="lyra-citation-val">ClickHouse `events` telemetry table</span>
            </div>
            <div className="lyra-citation-item">
              <span className="lyra-citation-label">Telemetry Origin</span>
              <span className="lyra-citation-val">{sources.length ? sources.join(', ') : 'Connected telemetry sources'}</span>
            </div>
            <div className="lyra-citation-item">
              <span className="lyra-citation-label">Record Count</span>
              <span className="lyra-citation-val">{block.rows.length} verified records</span>
            </div>
            <div className="lyra-citation-item">
              <span className="lyra-citation-label">Access Policy</span>
              <span className="lyra-citation-val">Read-only Engine Guardrail (`readonly=1`)</span>
            </div>
          </div>
        </div>
      </details>
      {cols.length > 0 && (
        <div className="lyra-scroll">
          <table>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c}>{String(r[c] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ExportModal({
  open,
  onClose,
  onExport,
  selectedFormat,
  setSelectedFormat,
}: {
  open: boolean;
  onClose: () => void;
  onExport: (fmt: ChatExportFormat) => void;
  selectedFormat: ChatExportFormat;
  setSelectedFormat: (fmt: ChatExportFormat) => void;
}) {
  if (!open) return null;

  const FORMATS: { id: ChatExportFormat; label: string; desc: string; ext: string }[] = [
    { id: 'pdf', label: 'PDF Report', desc: 'Formatted PDF with tables, metadata & query citations', ext: '.pdf' },
    { id: 'markdown', label: 'Markdown Document', desc: 'Clean Markdown transcript for documentation', ext: '.md' },
    { id: 'json', label: 'JSON Data Payload', desc: 'Complete structured JSON array with raw blocks & rows', ext: '.json' },
    { id: 'text', label: 'Plain Text Log', desc: 'Simple text transcript suitable for notes or copy-pasting', ext: '.txt' },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 15 }}>
            <IconExport size={18} style={{ color: 'var(--accent)' }} /> Export Chat Transcript
          </span>
          <button className="btn btn-xs btn-outline" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body stack-md">
          <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            Select your export format for this Lyra conversation session:
          </p>

          <div className="lyra-export-options">
            {FORMATS.map((f) => (
              <label
                key={f.id}
                className={`lyra-export-option ${selectedFormat === f.id ? 'active' : ''}`}
                onClick={() => setSelectedFormat(f.id)}
              >
                <input
                  type="radio"
                  name="exportFormat"
                  checked={selectedFormat === f.id}
                  onChange={() => setSelectedFormat(f.id)}
                />
                <div className="lyra-export-opt-text">
                  <div className="lyra-export-opt-title">
                    {f.label} <span className="lyra-export-opt-ext">{f.ext}</span>
                  </div>
                  <div className="lyra-export-opt-desc">{f.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-sm btn-outline" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              onExport(selectedFormat);
              onClose();
            }}
          >
            <IconExport size={14} /> Download Export
          </button>
        </div>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function LyraPage() {
  const { settings } = useSettings();
  const isNoneProvider = settings !== null && settings.provider === 'none';

  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(undefined);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [thinkingStep, setThinkingStep] = useState('Inspecting schema & conversation context…');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<ChatExportFormat>('pdf');
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadSessions();
  }, []);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, busy]);

  const loadSessions = async () => {
    setLoadingHistory(true);
    try {
      const res = await api.listChatSessions();
      setSessions(res.sessions);
      if (res.sessions.length > 0 && !activeSessionId) {
        void selectSession(res.sessions[0].id, false);
      }
    } catch {
      // silent fallback
    } finally {
      setLoadingHistory(false);
    }
  };

  const selectSession = async (sId: string, closeSidebar = true) => {
    setActiveSessionId(sId);
    if (closeSidebar) {
      setSidebarOpen(false);
    }
    try {
      const sess = await api.getChatSession(sId);
      setTurns(sess.messages || []);
    } catch {
      setTurns([]);
    }
  };

  const handleNewChat = () => {
    setActiveSessionId(undefined);
    setTurns([]);
    setSidebarOpen(false);
  };

  const handleDeleteSession = async (e: React.MouseEvent, sId: string) => {
    e.stopPropagation();
    try {
      await api.deleteChatSession(sId);
      const next = sessions.filter((s) => s.id !== sId);
      setSessions(next);
      if (activeSessionId === sId) {
        if (next.length > 0) {
          void selectSession(next[0].id, false);
        } else {
          handleNewChat();
        }
      }
    } catch {
      // ignore
    }
  };

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const next: Turn[] = [...turns, { role: 'user', content: q }];
    setTurns(next);
    setInput('');
    setBusy(true);
    setThinkingStep('Inspecting schema & conversation context…');

    await api.chatStream(
      next.map(({ role, content, blocks }) => ({ role, content, blocks })),
      activeSessionId,
      (stepText) => {
        setThinkingStep(stepText);
      },
      (r) => {
        setTurns([...next, { role: 'assistant', content: r.answer, blocks: r.blocks }]);
        if (r.session_id) {
          setActiveSessionId(r.session_id);
        }
        void loadSessions();
        setBusy(false);
      },
      (err) => {
        setTurns([...next, { role: 'assistant', content: `Lyra hit an error: ${errMessage(err)}` }]);
        setBusy(false);
      },
    );
  };

  const handleExport = (fmt: ChatExportFormat) => {
    setExportingFormat(fmt);
    const url = api.exportChatUrl(activeSessionId, fmt);
    window.open(url, '_blank');
  };

  const filteredSessions = sessions.filter((s) =>
    (s.title || '').toLowerCase().includes(searchQuery.toLowerCase().trim()),
  );

  return (
    <div className={`lyra ${isNoneProvider ? 'provider-none' : ''}`}>
      {isNoneProvider && (
        <div className="lyra-blur-screen">
          <div className="lyra-blur-card">
            <div className="lyra-blur-icon">
              <IconOff size={32} />
            </div>
            <h2 className="lyra-blur-title">LLM Provider Required</h2>
            <p className="lyra-blur-desc">
              Lyra Intelligence Engine cannot run without an LLM provider configured. Please set up a provider in Settings to start asking questions about your data.
            </p>
            <Link to="/dashboard/settings" className="btn btn-primary lyra-blur-btn">
              <IconSettings size={16} /> Configure LLM Provider
            </Link>
          </div>
        </div>
      )}

      <ExportModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        onExport={handleExport}
        selectedFormat={exportingFormat}
        setSelectedFormat={setExportingFormat}
      />

      <header className="lyra-header">
        <div className="lyra-brand">
          <div className="lyra-brand-mark" title="Lyra Engine">
            <img src={lyraIcon} alt="Lyra" style={{ width: 44, height: 44, objectFit: 'contain' }} />
          </div>
          <div className="lyra-brand-text">
            <span className="lyra-brand-name">Lyra</span>
            <span className="lyra-brand-tag hide-mobile">Telemetry & Security Intelligence Engine</span>
          </div>
        </div>

        <div className="lyra-header-right">
          <Badge kind="info" title="Strict read-only guard active for database queries">
            Read-only Guard Active
          </Badge>
          <div className="lyra-export-group">
            <button className="btn btn-sm btn-outline" onClick={handleNewChat} title="Start fresh session">
              <IconPlus size={14} /> New chat
            </button>
            {turns.length > 0 && (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => setExportModalOpen(true)}
                title="Export conversation"
              >
                <IconExport size={14} /> Export Chat
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="lyra-layout">
        {/* Blurred Backdrop Overlay when History Drawer is Expanded */}
        <div
          className={`lyra-backdrop ${sidebarOpen ? 'active' : ''}`}
          onClick={() => setSidebarOpen(false)}
          title="Click to close history drawer"
        />

        {/* Pinned Vertical Book/Folder Spine Bookmark Tab */}
        <button
          className={`lyra-bookmark-tab ${sidebarOpen ? 'open' : ''}`}
          onClick={() => setSidebarOpen(!sidebarOpen)}
          title={sidebarOpen ? 'Minimize History' : 'Expand History'}
        >
          <IconHistory size={16} />
          <span className="lyra-bookmark-label">HISTORY</span>
          {sessions.length > 0 && <span className="lyra-bookmark-badge">{sessions.length}</span>}
          {sidebarOpen ? <IconChevronLeft size={13} /> : <IconChevronRight size={13} />}
        </button>

        {/* Overlapping Sliding History Sidebar Drawer */}
        <aside className={`lyra-sidebar ${sidebarOpen ? 'expanded' : 'collapsed'}`}>
          <div className="lyra-sidebar-header">
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <IconHistory size={16} /> Chat History
            </span>
            <button className="btn btn-xs btn-outline" onClick={handleNewChat} title="New Chat">
              <IconPlus size={13} /> New
            </button>
          </div>
          {sessions.length > 4 && (
            <div className="lyra-sidebar-search">
              <IconSearch size={14} style={{ opacity: 0.6 }} />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search history…"
              />
            </div>
          )}
          <div className="lyra-history-list">
            {loadingHistory && sessions.length === 0 && (
              <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-muted)' }}>
                <Spinner /> Loading history…
              </div>
            )}
            {!loadingHistory && filteredSessions.length === 0 && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>
                {searchQuery ? 'No matching chats' : 'No saved chats yet.'}
              </div>
            )}
            {filteredSessions.map((s) => (
              <div
                key={s.id}
                className={`lyra-history-item ${activeSessionId === s.id ? 'active' : ''}`}
                onClick={() => void selectSession(s.id)}
              >
                <div className="lyra-history-info">
                  <span className="lyra-history-title">{s.title || 'Untitled Chat'}</span>
                  <span className="lyra-history-meta">
                    {s.message_count} msgs · {timeAgo(s.updated_at)}
                  </span>
                </div>
                <button
                  className="lyra-del-btn"
                  onClick={(e) => void handleDeleteSession(e, s.id)}
                  title="Delete chat session"
                >
                  <IconTrash size={13} />
                </button>
              </div>
            ))}
          </div>
        </aside>

        {/* Main Conversation Thread (Constant Width) */}
        <main className="lyra-main">
          <div className="lyra-thread">
            {turns.length === 0 && (
              <div className="lyra-empty">
                <div className="lyra-empty-hero">
                  <img src={lyraIcon} alt="Lyra" style={{ width: 96, height: 96, objectFit: 'contain' }} />
                </div>
                <h3 style={{ margin: 0, fontWeight: 600, color: 'var(--text-heading)' }}>What would you like to know?</h3>
                <p style={{ margin: 0, fontSize: 'var(--fs-sm)', maxWidth: 480 }}>
                  Ask Lyra anything about your ingested telemetry, top talking hosts, denied traffic patterns, or parser proposals.
                </p>
                <div className="lyra-chips">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="lyra-chip-btn" onClick={() => void send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {turns.map((t, i) => (
              <div key={i} className={`lyra-msg-row ${t.role}`}>
                {t.role === 'assistant' && (
                  <div className="lyra-avatar" title="Lyra Assistant">
                    <img src={lyraIcon} alt="Lyra" style={{ width: 36, height: 36, objectFit: 'contain' }} />
                  </div>
                )}
                <div className="lyra-bubble-wrap">
                  <div className="lyra-bubble">{t.content}</div>
                  {t.blocks?.map((b, j) => (
                    <ResultTable key={j} block={b} />
                  ))}
                </div>
                {t.role === 'user' && (
                  <div className="lyra-user-avatar" title="You">
                    <IconUser size={16} />
                  </div>
                )}
              </div>
            ))}

            {busy && (
              <div className="lyra-msg-row assistant">
                <div className="lyra-avatar">
                  <img src={lyraIcon} alt="Lyra" style={{ width: 42, height: 42, objectFit: 'contain' }} />
                </div>
                <div className="lyra-bubble-wrap">
                  <div className="lyra-thinking-box">
                    <div className="lyra-thinking-spinner">
                      <Spinner />
                    </div>
                    <span>{thinkingStep}</span>
                  </div>
                </div>
              </div>
            )}
            <div ref={end} />
          </div>

          <div className="lyra-input-area">
            <form
              className="lyra-input-wrap"
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask Lyra about your data (e.g. top source IPs, event rates, error counts)…"
                maxLength={4000}
              />
              <button className="btn btn-sm btn-primary" disabled={busy || !input.trim()} style={{ borderRadius: 20 }}>
                {busy ? <Spinner /> : 'Send'}
              </button>
            </form>
          </div>
        </main>
      </div>
    </div>
  );
}
