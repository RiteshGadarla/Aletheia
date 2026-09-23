import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, PageHead, Spinner } from '../components/Bits';
import { IconAlert, IconCheck, IconCopy, IconEvents, IconExport, IconSend, IconServer, IconShield, IconTerminal } from '../components/Icons';
import { api, errMessage } from '../lib/api';
import { useNotify } from '../lib/notify';
import { useAsync, usePoll } from '../lib/useAsync';
import type { DownloadResult, LogExportFormat, LogExportType, ReportFormat, SupplyFormat, SupplyMode } from '../lib/types';

type Tab = 'logs' | 'report' | 'supply';

const optClass = (on: boolean) => (on ? 'xp-opt on' : 'xp-opt');

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);

const LOG_FORMATS: { group: string; items: { v: LogExportFormat; label: string }[] }[] = [
  { group: 'Data', items: [
    { v: 'json', label: 'JSON array (.json)' },
    { v: 'jsonl', label: 'NDJSON, one record per line (.jsonl)' },
    { v: 'csv', label: 'CSV table (.csv)' },
    { v: 'tsv', label: 'TSV table (.tsv)' },
    { v: 'xml', label: 'XML document (.xml)' },
  ] },
  { group: 'SIEM', items: [
    { v: 'syslog', label: 'Syslog RFC 5424 with hash (.syslog)' },
    { v: 'cef', label: 'CEF, ArcSight and most SIEMs (.cef)' },
    { v: 'leef', label: 'LEEF 2.0, QRadar (.leef)' },
  ] },
  { group: 'Original', items: [{ v: 'text', label: 'Original log lines, byte for byte (.log)' }] },
];

const RANGES: { v: number; label: string }[] = [
  { v: 900, label: 'Last 15 minutes' },
  { v: 3600, label: 'Last hour' },
  { v: 86400, label: 'Last 24 hours' },
  { v: 604800, label: 'Last 7 days' },
  { v: 0, label: 'All retained' },
];

const LIMITS = [100, 500, 1000, 5000, 10000, 50000];

const STREAM_FORMATS: { v: SupplyFormat; label: string; desc: string }[] = [
  { v: 'raw', label: 'Original lines', desc: 'Each line exactly as the device sent it, newline-terminated. Downstream parsers see the vendor format unchanged.' },
  { v: 'syslog', label: 'Syslog RFC 5424', desc: 'The original line as MSG, with source and SHA-256 in structured data. Octet-counted framing (RFC 6587), for rsyslog, syslog-ng, QRadar and Splunk.' },
  { v: 'cef', label: 'CEF', desc: 'One CEF line per log with the original in msg and its SHA-256 in cs1. For ArcSight and SIEMs that parse CEF.' },
  { v: 'json', label: 'JSON lines', desc: 'One JSON object per line: time, source, severity, SHA-256 and the original line. For data lakes, Logstash and Vector.' },
  { v: 'ocsf', label: 'OCSF events', desc: 'Normalized OCSF events from the worker, one JSON object per line, with provenance and verification. Needs the event bus.' },
  { v: 'tagged', label: 'Tagged text', desc: '[source] [SEVERITY] line. Easy to read in a terminal; not meant for machine parsing.' },
];

export function ExportPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>((searchParams.get('tab') as Tab) || 'logs');
  const [sourceId, setSourceId] = useState(searchParams.get('source') || '');
  const { toast } = useNotify();

  const sourcesQuery = useAsync(() => api.listSources(), []);
  const availableSources = sourcesQuery.data?.sources.map((s) => s.id) ?? [];

  // Logs
  const [logType, setLogType] = useState<LogExportType>('raw');
  const [logFmt, setLogFmt] = useState<LogExportFormat>('json');
  const [severity, setSeverity] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sinceS, setSinceS] = useState(3600);
  const [limit, setLimit] = useState(1000);
  const [busy, setBusy] = useState<'' | 'logs' | 'copy' | 'report'>('');
  const [copied, setCopied] = useState(false);
  const [receipt, setReceipt] = useState<DownloadResult | null>(null);

  // Report
  const [reportFmt, setReportFmt] = useState<ReportFormat>('pdf');
  const [cats, setCats] = useState<Record<string, boolean>>({
    kpis: true, sources: true, severity: true, normalized: true, usage: true, insights: true, traffic: true, storage: true, history: true,
  });

  // Supply: the form is the operator's draft; `supply` is what the server is actually doing.
  const status = usePoll(() => api.getSupplyStatus(), 3000, []);
  const supply = status.data;
  const [mode, setMode] = useState<SupplyMode>('listen');
  const [target, setTarget] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(9099);
  const [streamFmt, setStreamFmt] = useState<SupplyFormat>('raw');
  const [streamSource, setStreamSource] = useState('');
  const [allow, setAllow] = useState('');
  const [saving, setSaving] = useState(false);
  const loadedForm = useRef(false);

  useEffect(() => {
    if (!supply || loadedForm.current) return;
    loadedForm.current = true;
    setMode(supply.mode ?? 'listen');
    setTarget(supply.target ?? '');
    setHost(supply.host ?? '127.0.0.1');
    setPort(supply.port);
    setStreamFmt(supply.log_type ?? 'raw');
    setStreamSource(supply.source_id ?? '');
    setAllow((supply.allow ?? []).join(', '));
  }, [supply]);

  const handleTabChange = (t: Tab) => {
    setTab(t);
    setSearchParams({ tab: t, ...(sourceId ? { source: sourceId } : {}) });
  };

  const logParams = (lim: number) => ({
    log_type: logType, format: logFmt, source_id: sourceId, severity: logType === 'system' ? '' : severity, q: searchQuery, limit: lim, since_s: sinceS,
  });

  const handleDownloadLogs = async () => {
    setBusy('logs');
    try {
      const r = await api.download(api.exportLogsUrl(logParams(limit)));
      setReceipt(r);
      toast({ kind: r.count === 0 ? 'info' : 'ok', title: r.count === 0 ? 'Nothing matched' : `Exported ${r.count?.toLocaleString()} records`,
        body: r.count === 0 ? 'The file is empty. Widen the time range or clear a filter.' : `${r.filename} · ${kb(r.bytes)}` });
    } catch (e) {
      toast({ kind: 'bad', title: 'Export failed', body: errMessage(e) });
    } finally {
      setBusy('');
    }
  };

  const handleCopyLogs = async () => {
    setBusy('copy');
    try {
      const res = await fetch(api.exportLogsUrl(logParams(Math.min(limit, 200))));
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? res.statusText);
      await navigator.clipboard.writeText(await res.text());
      setCopied(true);
      toast({ kind: 'ok', title: 'Copied to clipboard', body: `First ${res.headers.get('x-aletheia-record-count') ?? Math.min(limit, 200)} records.` });
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      toast({ kind: 'bad', title: 'Copy failed', body: errMessage(e) });
    } finally {
      setBusy('');
    }
  };

  const handleDownloadReport = async () => {
    setBusy('report');
    try {
      const r = await api.download(api.exportReportUrl({
        format: reportFmt, source_id: sourceId, categories: Object.keys(cats).filter((k) => cats[k]).join(','),
      }));
      toast({ kind: 'ok', title: 'Report ready', body: `${r.filename} · ${kb(r.bytes)}` });
    } catch (e) {
      toast({ kind: 'bad', title: 'Report failed', body: errMessage(e) });
    } finally {
      setBusy('');
    }
  };

  const saveStream = async (enabled: boolean) => {
    setSaving(true);
    try {
      const res = await api.configureSupply({
        enabled, mode, target: target.trim(), host, port, log_type: streamFmt, source_id: streamSource,
        allow: allow.split(',').map((a) => a.trim()).filter(Boolean),
      });
      status.setData(res);
      window.dispatchEvent(new Event('supply-status-changed'));
      toast(res.active
        ? { kind: 'ok', title: res.mode === 'push' ? `Forwarding to ${res.target}` : `Serving on ${res.host}:${res.port}`, body: `${STREAM_FORMATS.find((f) => f.v === res.log_type)?.label} from ${res.source_id || 'all sources'}.` }
        : { kind: 'ok', title: 'Stream stopped', body: 'Nothing is being sent.' });
    } catch (e) {
      toast({ kind: 'bad', title: 'Stream not started', body: errMessage(e), sticky: true });
      status.reload();
    } finally {
      setSaving(false);
    }
  };

  const sourceLabel = sourceId || 'All sources';
  const reportSections: { k: string; title: string; desc: string }[] = [
    { k: 'kpis', title: 'Performance KPIs', desc: 'Lines, bytes, EPS, bus and worker status' },
    { k: 'sources', title: 'Source health', desc: 'Connected sources and connector breakdown' },
    { k: 'severity', title: 'Severity mix', desc: 'INFO, NOTICE, WARN and RISK distribution' },
    { k: 'normalized', title: 'OCSF normalization', desc: 'Metrics and pack coverage' },
    { k: 'usage', title: 'Resource usage', desc: 'System usage and airgap telemetry' },
    { k: 'insights', title: 'Insights & findings', desc: 'Posture score, findings, ingest, threat and integrity analytics' },
    { k: 'traffic', title: 'Traffic analysis', desc: 'Top IPs, ports, users, blocked sources, scan suspects, OCSF classes' },
    { k: 'storage', title: 'Storage efficiency', desc: 'Compression versus raw and the baseline store' },
    { k: 'history', title: 'Approval audit trail', desc: 'Source approval decisions' },
  ];
  const sectionCount = Object.values(cats).filter(Boolean).length;
  const datasets: { v: LogExportType; title: string; desc: string }[] = [
    { v: 'raw', title: 'Raw logs', desc: 'Verbatim lines with a SHA-256 each' },
    { v: 'ocsf', title: 'OCSF events', desc: 'Normalized, with the verified original' },
    { v: 'system', title: 'Audit trail', desc: 'Approvals, exports, stream changes' },
  ];
  const modes: { k: Tab; icon: JSX.Element; title: string }[] = [
    { k: 'logs', icon: <IconEvents size={16} />, title: 'Log datasets' },
    { k: 'report', icon: <IconExport size={16} />, title: 'System report' },
    { k: 'supply', icon: <IconServer size={16} />, title: 'Supply stream' },
  ];

  const sourceOptions = (allLabel: string) => (
    <>
      <option value="">{allLabel}</option>
      {availableSources.map((s) => <option key={s} value={s}>{s}</option>)}
    </>
  );

  const locked = !!supply?.active;
  const isPush = mode === 'push';
  const fmtInfo = STREAM_FORMATS.find((f) => f.v === streamFmt);
  const openToNetwork = mode === 'listen' && host !== '127.0.0.1' && host !== '::1';
  const connectHost = host === '0.0.0.0' || host === '::' ? '<this-host>' : host;
  const recipe = streamRecipe(mode, streamFmt, connectHost, port, target);

  return (
    <div className="stack">
      <PageHead
        title="Export & Log Supply"
        right={
          <Badge kind={supply?.active ? (supply.last_error ? 'warn' : 'ok') : 'plain'}>
            {!supply?.active ? 'Stream off' : supply.mode === 'push' ? `Forwarding · ${supply.target}` : `Serving · :${supply.port}`}
          </Badge>
        }
      >
        Download evidence-grade log datasets, generate a report, or feed your SIEM live.
      </PageHead>

      <div className="xp-seg" role="tablist" style={{ ['--i' as string]: modes.findIndex((m) => m.k === tab) }}>
        <span className="xp-seg-thumb" aria-hidden="true" />
        {modes.map((m) => (
          <button key={m.k} role="tab" type="button" aria-selected={tab === m.k} className={tab === m.k ? 'on' : ''} onClick={() => handleTabChange(m.k)}>
            {m.icon} {m.title}
          </button>
        ))}
      </div>

      <div className="xp-layout">
        {/* ============ LOGS ============ */}
        {tab === 'logs' && (
          <>
            <div className="xp-main">
              <section className="xp-card">
                <h3 className="xp-h">Dataset</h3>
                <div className="xp-choice">
                  {datasets.map((d) => (
                    <button key={d.v} type="button" className={`xp-opt${logType === d.v ? ' on' : ''}`} onClick={() => setLogType(d.v)}>
                      <strong>{d.title}</strong>
                      <small>{d.desc}</small>
                    </button>
                  ))}
                </div>
                <label className="field">
                  <span className="lbl">File format</span>
                  <select value={logFmt} onChange={(e) => setLogFmt(e.target.value as LogExportFormat)}>
                    {LOG_FORMATS.map((g) => (
                      <optgroup key={g.group} label={g.group}>
                        {g.items.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </label>
              </section>

              <section className="xp-card">
                <h3 className="xp-h">Filters</h3>
                <div className="xp-fields">
                  <label className="field">
                    <span className="lbl">Source</span>
                    <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>{sourceOptions('All sources')}</select>
                  </label>
                  <label className="field">
                    <span className="lbl">Time range</span>
                    <select value={sinceS} onChange={(e) => setSinceS(Number(e.target.value))}>
                      {RANGES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span className="lbl">Severity</span>
                    <select value={severity} disabled={logType === 'system'} onChange={(e) => setSeverity(e.target.value)}>
                      <option value="">All severities</option>
                      <option value="info">INFO</option>
                      <option value="notice">NOTICE</option>
                      <option value="warn">WARN</option>
                      <option value="risk">RISK / ERROR</option>
                    </select>
                  </label>
                  <label className="field">
                    <span className="lbl">Record limit</span>
                    <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                      {LIMITS.map((n) => <option key={n} value={n}>{n.toLocaleString()} newest</option>)}
                    </select>
                  </label>
                  <label className="field xp-full">
                    <span className="lbl">Keyword</span>
                    <input type="text" placeholder={logType === 'ocsf' ? 'Text, IP, user, source or template…' : 'Only lines containing…'} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
                  </label>
                </div>
              </section>
            </div>

            <aside className="xp-side">
              <h3 className="xp-h">Summary</h3>
              <dl className="xp-kv">
                <dt>Dataset</dt><dd>{datasets.find((d) => d.v === logType)?.title}</dd>
                <dt>Format</dt><dd>{logFmt.toUpperCase()}</dd>
                <dt>Source</dt><dd>{sourceLabel}</dd>
                <dt>Range</dt><dd>{RANGES.find((r) => r.v === sinceS)?.label}</dd>
                <dt>Severity</dt><dd>{severity && logType !== 'system' ? severity.toUpperCase() : 'All'}</dd>
                <dt>Keyword</dt><dd>{searchQuery || 'None'}</dd>
                <dt>Limit</dt><dd>{limit.toLocaleString()} records</dd>
              </dl>
              <div className="xp-btns">
                <button type="button" className="primary" onClick={handleDownloadLogs} disabled={!!busy}>
                  {busy === 'logs' ? <Spinner /> : <IconExport size={16} />} Download {logFmt.toUpperCase()}
                </button>
                <button type="button" onClick={handleCopyLogs} disabled={!!busy}>
                  {busy === 'copy' ? <Spinner /> : copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  {copied ? 'Copied' : 'Copy first 200'}
                </button>
              </div>
              {receipt && (
                <>
                  <h3 className="xp-h"><IconShield size={16} /> Last download</h3>
                  <dl className="xp-kv">
                    <dt>File</dt><dd className="mono">{receipt.filename}</dd>
                    <dt>Records</dt><dd>{receipt.count?.toLocaleString() ?? 'n/a'}</dd>
                    <dt>Size</dt><dd>{kb(receipt.bytes)}</dd>
                  </dl>
                  {receipt.sha256 && (
                    <div className="xp-cmd" title="sha256sum of the downloaded file must print this">
                      <code className="mono grow" style={{ overflowWrap: 'anywhere' }}>{receipt.sha256}</code>
                      <button type="button" className="ghost icon" title="Copy SHA-256"
                        onClick={() => { void navigator.clipboard.writeText(receipt.sha256 ?? ''); toast({ kind: 'ok', title: 'SHA-256 copied', body: 'Check it with sha256sum on the receiving side.' }); }}>
                        <IconCopy size={16} />
                      </button>
                    </div>
                  )}
                  <p className="hint xp-p">File SHA-256 for chain of custody. Each record also carries the SHA-256 of its original line, and the export is recorded in the audit trail.</p>
                </>
              )}
            </aside>
          </>
        )}

        {/* ============ REPORT ============ */}
        {tab === 'report' && (
          <>
            <div className="xp-main">
              <section className="xp-card">
                <h3 className="xp-h">Scope</h3>
                <div className="xp-fields">
                  <label className="field">
                    <span className="lbl">Source</span>
                    <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>{sourceOptions('All sources')}</select>
                  </label>
                  <label className="field">
                    <span className="lbl">Format</span>
                    <select value={reportFmt} onChange={(e) => setReportFmt(e.target.value as ReportFormat)}>
                      <option value="pdf">PDF, for sharing</option>
                      <option value="html">HTML page</option>
                      <option value="markdown">Markdown</option>
                      <option value="csv">CSV, for spreadsheets</option>
                      <option value="json">JSON, for automation</option>
                    </select>
                  </label>
                </div>
                <p className="hint xp-p">A snapshot taken when you download: rates cover the last 5 minutes, totals cover everything since Studio started.</p>
              </section>

              <section className="xp-card">
                <h3 className="xp-h">Sections <span className="xp-count">{sectionCount}/{reportSections.length} selected</span></h3>
                <div className="xp-fields">
                  {reportSections.map((r) => (
                    <label key={r.k} className={`xp-check${cats[r.k] ? ' on' : ''}`}>
                      <input type="checkbox" checked={cats[r.k]} onChange={(e) => setCats({ ...cats, [r.k]: e.target.checked })} />
                      <span><strong>{r.title}</strong><small>{r.desc}</small></span>
                    </label>
                  ))}
                </div>
              </section>
            </div>

            <aside className="xp-side">
              <h3 className="xp-h">Summary</h3>
              <dl className="xp-kv">
                <dt>Format</dt><dd>{reportFmt.toUpperCase()}</dd>
                <dt>Scope</dt><dd>{sourceLabel}</dd>
                <dt>Sections</dt><dd>{sectionCount} of {reportSections.length}</dd>
              </dl>
              <div className="xp-btns">
                <button type="button" className="primary" onClick={handleDownloadReport} disabled={sectionCount === 0 || !!busy}>
                  {busy === 'report' ? <Spinner /> : <IconExport size={16} />} Download report
                </button>
              </div>
            </aside>
          </>
        )}

        {/* ============ SUPPLY ============ */}
        {tab === 'supply' && (
          <>
            <div className="xp-main">
              {!supply && status.loading ? (
                <section className="xp-card"><Spinner label="Loading stream settings…" /></section>
              ) : (
                <>
                  <section className="xp-card">
                    <h3 className="xp-h">Delivery</h3>
                    <div className="xp-choice" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                      <button type="button" disabled={locked} className={optClass(isPush)} onClick={() => setMode('push')}>
                        <strong><IconSend size={14} /> Forward to a collector</strong>
                        <small>Sends to your SIEM or syslog server</small>
                      </button>
                      <button type="button" disabled={locked} className={optClass(!isPush)} onClick={() => setMode('listen')}>
                        <strong><IconServer size={14} /> Serve on a port</strong>
                        <small>Receivers connect here and read</small>
                      </button>
                    </div>
                    <div className="xp-fields">
                      {mode === 'push' ? (
                        <label className="field xp-full">
                          <span className="lbl">Collector address</span>
                          <input type="text" value={target} disabled={locked} placeholder="siem.example.com:514" onChange={(e) => setTarget(e.target.value)} />
                        </label>
                      ) : (
                        <>
                          <label className="field">
                            <span className="lbl">Listen on</span>
                            <select value={host} disabled={locked} onChange={(e) => setHost(e.target.value)}>
                              <option value="127.0.0.1">This machine only</option>
                              <option value="0.0.0.0">All network interfaces</option>
                            </select>
                          </label>
                          <label className="field">
                            <span className="lbl">TCP port</span>
                            <input type="number" min={1024} max={65535} value={port} disabled={locked} onChange={(e) => setPort(Number(e.target.value))} />
                          </label>
                          {openToNetwork && (
                            <label className="field xp-full">
                              <span className="lbl">Allowed clients</span>
                              <input type="text" value={allow} disabled={locked} placeholder="10.0.5.20, 10.1.0.0/16" onChange={(e) => setAllow(e.target.value)} />
                            </label>
                          )}
                        </>
                      )}
                      <label className="field">
                        <span className="lbl">Source</span>
                        <select value={streamSource} disabled={locked} onChange={(e) => setStreamSource(e.target.value)}>{sourceOptions('All sources')}</select>
                      </label>
                      <label className="field">
                        <span className="lbl">Payload format</span>
                        <select value={streamFmt} disabled={locked} onChange={(e) => setStreamFmt(e.target.value as SupplyFormat)}>
                          {STREAM_FORMATS.map((f) => (
                            <option key={f.v} value={f.v} disabled={f.v === 'ocsf' && supply?.bus === false}>
                              {f.label}{f.v === 'ocsf' && supply?.bus === false ? ' (needs event bus)' : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {fmtInfo && <p className="hint xp-p">{fmtInfo.desc}</p>}
                    {openToNetwork && !allow.trim() && (
                      <div className="callout warn"><IconAlert size={16} />
                        <span>Any host that can reach port {port} will receive these logs. List the collectors allowed to connect.</span>
                      </div>
                    )}
                    <p className="hint xp-p">{locked ? 'Settings are locked while the stream runs. Stop it to edit.' : 'Settings are saved and restored after a restart.'}</p>
                  </section>

                  <section className="xp-card">
                    <h3 className="xp-h"><IconTerminal size={16} /> {mode === 'push' ? 'Set up the collector' : 'Connect a receiver'}</h3>
                    <p className="hint xp-p">{recipe.note}</p>
                    <div className="xp-cmd">
                      <code className="mono grow" style={{ whiteSpace: 'pre-wrap' }}>{recipe.code}</code>
                      <button type="button" className="ghost icon" title="Copy"
                        onClick={() => { void navigator.clipboard.writeText(recipe.code); toast({ kind: 'ok', title: 'Copied', body: recipe.code.split('\n')[0] }); }}>
                        <IconCopy size={16} />
                      </button>
                    </div>
                  </section>
                </>
              )}
            </div>

            <aside className="xp-side">
              <h3 className="xp-h">Stream</h3>
              <div className="xp-status">
                <Badge kind={supply?.active ? (supply.last_error ? 'warn' : 'ok') : 'plain'}>
                  {!supply?.active ? 'Off' : supply.last_error ? 'Retrying' : supply.mode === 'push' ? (supply.clients_count ? 'Connected' : 'Connecting') : 'Serving'}
                </Badge>
              </div>
              {supply?.last_error && (
                <div className="callout bad"><IconAlert size={16} /><span>{supply.last_error}</span></div>
              )}
              {status.error && <div className="callout warn"><IconAlert size={16} /><span>{status.error}</span></div>}
              <div className="xp-btns">
                <button type="button" className={locked ? '' : 'primary'} onClick={() => void saveStream(!locked)} disabled={saving || (!locked && mode === 'push' && !target.trim())}>
                  {saving ? 'Saving…' : locked ? 'Stop stream' : 'Start stream'}
                </button>
              </div>
              <dl className="xp-kv">
                <dt>{supply?.mode === 'push' ? 'Collector' : 'Receivers'}</dt>
                <dd>{supply?.mode === 'push' ? (supply.clients_count ? 'connected' : 'not connected') : supply?.clients_count ?? 0}</dd>
                <dt>Lines sent</dt><dd>{(supply?.lines_sent ?? 0).toLocaleString()}</dd>
                <dt>Data sent</dt><dd>{kb(supply?.bytes_sent ?? 0)}</dd>
                <dt>Dropped</dt><dd>{(supply?.dropped_lines ?? 0).toLocaleString()}</dd>
                {supply?.mode === 'listen' && <><dt>Refused</dt><dd>{supply.refused}</dd></>}
              </dl>
              {!!supply?.clients?.length && (
                <div className="table-scroll">
                  <table className="data">
                    <thead><tr><th>{supply.mode === 'push' ? 'Collector' : 'Receiver'}</th><th className="num">Lines</th><th className="num">Queued</th></tr></thead>
                    <tbody>
                      {supply.clients.map((c) => (
                        <tr key={c.addr}>
                          <td className="mono">{c.addr}</td>
                          <td className="num">{c.lines.toLocaleString()}</td>
                          <td className="num">{c.queued}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {(supply?.dropped_lines ?? 0) > 0 && (
                <p className="hint xp-p">Dropped lines never reached a receiver that fell too far behind. They are still stored and can be exported from Log datasets.</p>
              )}
            </aside>
          </>
        )}
      </div>
    </div>
  );
}

/** What the operator runs on the other side, for the chosen delivery and format. */
function streamRecipe(mode: SupplyMode, fmt: SupplyFormat, host: string, port: number, target: string): { note: string; code: string } {
  const [tHost, tPort] = (() => {
    const i = target.lastIndexOf(':');
    return i > 0 ? [target.slice(0, i), target.slice(i + 1)] : ['<collector>', '514'];
  })();
  if (mode === 'listen') {
    if (fmt === 'json' || fmt === 'ocsf') {
      return { note: 'Logstash reads the feed as a TCP client. For a quick look, nc works too.',
        code: `input {\n  tcp { mode => "client" host => "${host}" port => ${port} codec => json_lines }\n}` };
    }
    return { note: 'Run this in any terminal to read the live feed, or point a TCP-client input at it.', code: `nc ${host} ${port}` };
  }
  if (fmt === 'syslog' || fmt === 'raw') {
    return { note: `rsyslog on ${tHost}: accept TCP syslog on port ${tPort}. syslog-ng, QRadar and Splunk TCP inputs work the same way.`,
      code: `module(load="imtcp")\ninput(type="imtcp" port="${tPort}")` };
  }
  if (fmt === 'cef') {
    return { note: `On ${tHost}, add a TCP syslog receiver on port ${tPort} (ArcSight SmartConnector: Syslog Daemon, TCP) and parse CEF.`,
      code: `module(load="imtcp")\ninput(type="imtcp" port="${tPort}")` };
  }
  return { note: `Logstash on ${tHost}: listen on port ${tPort} and decode one JSON event per line.`,
    code: `input {\n  tcp { port => ${tPort} codec => json_lines }\n}` };
}
