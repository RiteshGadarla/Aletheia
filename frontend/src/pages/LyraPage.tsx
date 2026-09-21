import { useEffect, useRef, useState } from 'react';
import { PageHead, Spinner } from '../components/Bits';
import { IconLyra } from '../components/Icons';
import { api, errMessage } from '../lib/api';
import type { ChatBlock, ChatMessage } from '../lib/types';

type Turn = ChatMessage & { blocks?: ChatBlock[] };

const SUGGESTIONS = [
  'How many events did we ingest in the last hour?',
  'Top 5 source IPs with denied traffic',
  'Which sources are connected and approved?',
  'Show event counts by severity',
];

function ResultTable({ block }: { block: ChatBlock }) {
  const cols = block.rows.length ? Object.keys(block.rows[0]) : [];
  return (
    <details className="lyra-table" open={block.rows.length <= 10}>
      <summary>{block.rows.length} rows · view query</summary>
      <pre className="lyra-sql">{block.sql}</pre>
      {cols.length > 0 && (
        <div className="lyra-scroll">
          <table>
            <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i}>{cols.map((c) => <td key={c}>{String(r[c] ?? '')}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

export function LyraPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [turns, busy]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const next: Turn[] = [...turns, { role: 'user', content: q }];
    setTurns(next);
    setInput('');
    setBusy(true);
    try {
      const r = await api.chat(next.map(({ role, content }) => ({ role, content })));
      setTurns([...next, { role: 'assistant', content: r.answer, blocks: r.blocks }]);
    } catch (e) {
      setTurns([...next, { role: 'assistant', content: `Lyra hit an error: ${errMessage(e)}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lyra">
      <PageHead
        title="Lyra"
        right={turns.length > 0 ? <button className="btn btn-sm" onClick={() => setTurns([])}>New chat</button> : undefined}
      >
        Ask questions about your events, sources and packs. Read-only: Lyra can query but never change anything.
      </PageHead>
      <div className="lyra-thread">
        {turns.length === 0 && (
          <div className="lyra-empty">
            <IconLyra size={28} />
            <p>What would you like to know?</p>
            <div className="lyra-chips">
              {SUGGESTIONS.map((s) => <button key={s} className="btn btn-sm" onClick={() => void send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`lyra-msg ${t.role}`}>
            <div className="lyra-bubble">{t.content}</div>
            {t.blocks?.map((b, j) => <ResultTable key={j} block={b} />)}
          </div>
        ))}
        {busy && <div className="lyra-msg assistant"><div className="lyra-bubble"><Spinner /> Lyra is thinking…</div></div>}
        <div ref={end} />
      </div>
      <form className="lyra-input" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask Lyra about your data…" maxLength={4000} />
        <button className="btn btn-primary" disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}
