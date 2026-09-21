import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, PageHead, Spinner } from '../components/Bits';
import { IconCheck, IconCopy, IconEvents, IconExport, IconServer, IconTerminal } from '../components/Icons';
import { api, errMessage } from '../lib/api';
import { useNotify } from '../lib/notify';
import { useAsync } from '../lib/useAsync';
import type { LogExportFormat, LogExportType, SupplyStatus } from '../lib/types';

export function ExportPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as 'logs' | 'report' | 'supply') || 'logs';
  const initialSource = searchParams.get('source') || '';

  const [tab, setTab] = useState<'logs' | 'report' | 'supply'>(initialTab);
  const [sourceId, setSourceId] = useState(initialSource);
  const { toast } = useNotify();

  // Load available sources
  const sourcesQuery = useAsync(() => api.listSources(), []);
  const availableSources = sourcesQuery.data?.sources.map((s) => s.id) ?? [];

  // Logs State (First Tab)
  const [logType, setLogType] = useState<LogExportType>('raw');
  const [logFmt, setLogFmt] = useState<LogExportFormat>('json');
  const [severity, setSeverity] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [limit, setLimit] = useState(500);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);

  // System Report State (Second Tab, PDF Only)
  const [windowS, setWindowS] = useState(300);
  const [catKpis, setCatKpis] = useState(true);
  const [catSources, setCatSources] = useState(true);
  const [catSeverity, setCatSeverity] = useState(true);
  const [catNormalized, setCatNormalized] = useState(true);
  const [catUsage, setCatUsage] = useState(true);
  const [catHistory, setCatHistory] = useState(true);
  const [catInsights, setCatInsights] = useState(true);
  const [catTraffic, setCatTraffic] = useState(true);
  const [catStorage, setCatStorage] = useState(true);

  // Supply Server State (Third Tab)
  const [supply, setSupply] = useState<SupplyStatus | null>(null);
  const [supplyPort, setSupplyPort] = useState(9099);
  const [supplyFormat, setSupplyFormat] = useState('raw');
  const [supplySource, setSupplySource] = useState('');
  const [supplyEnabled, setSupplyEnabled] = useState(false);
  const [loadingSupply, setLoadingSupply] = useState(false);
  const [savingSupply, setSavingSupply] = useState(false);

  useEffect(() => {
    void loadSupplyStatus();
  }, []);

  const loadSupplyStatus = async () => {
    setLoadingSupply(true);
    try {
      const st = await api.getSupplyStatus();
      setSupply(st);
      setSupplyEnabled(st.enabled);
      setSupplyPort(st.port);
      setSupplyFormat(st.log_type || 'raw');
      setSupplySource(st.source_id || '');
    } catch {
      // silent fallback
    } finally {
      setLoadingSupply(false);
    }
  };

  const handleTabChange = (newTab: 'logs' | 'report' | 'supply') => {
    setTab(newTab);
    setSearchParams({ tab: newTab, ...(sourceId ? { source: sourceId } : {}) });
  };

  const handleSaveSupply = async (overrideEnabled?: boolean) => {
    setSavingSupply(true);
    try {
      const en = overrideEnabled !== undefined ? overrideEnabled : supplyEnabled;
      const res = await api.configureSupply({
        enabled: en,
        port: supplyPort,
        log_type: supplyFormat,
        source_id: supplySource,
      });
      setSupply(res);
      setSupplyEnabled(res.enabled);
      window.dispatchEvent(new Event('supply-status-changed'));
      toast({
        kind: 'ok',
        title: res.active ? `Supply Stream Active on TCP :${res.port}` : 'Supply Stream Stopped',
        body: res.active
          ? `Broadcasting ${res.log_type} telemetry over TCP port ${res.port}.`
          : 'The dedicated TCP streaming server was stopped.',
      });
    } catch (e) {
      toast({ kind: 'bad', title: 'Supply configuration failed', body: errMessage(e) });
    } finally {
      setSavingSupply(false);
    }
  };

  const handleDownloadReport = () => {
    const categories = [
      catKpis && 'kpis',
      catSources && 'sources',
      catSeverity && 'severity',
      catNormalized && 'normalized',
      catUsage && 'usage',
      catHistory && 'history',
      catInsights && 'insights',
      catTraffic && 'traffic',
      catStorage && 'storage',
    ].filter(Boolean).join(',');

    const url = api.exportReportUrl({
      format: 'pdf',
      source_id: sourceId,
      window_s: windowS,
      categories,
    });

    window.open(url, '_blank');
  };

  const handleDownloadLogs = () => {
    const url = api.exportLogsUrl({
      log_type: logType,
      format: logFmt,
      source_id: sourceId,
      severity,
      q: searchQuery,
      limit,
    });

    window.open(url, '_blank');
  };

  const handleCopyLogs = async () => {
    setCopying(true);
    try {
      const url = api.exportLogsUrl({
        log_type: logType,
        format: logFmt,
        source_id: sourceId,
        severity,
        q: searchQuery,
        limit: Math.min(limit, 200),
      });
      const res = await fetch(url);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast({ kind: 'ok', title: 'Copied to Clipboard', body: `Preview dataset copied (${Math.min(limit, 200)} logs).` });
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      toast({ kind: 'bad', title: 'Failed to copy', body: errMessage(e) });
    } finally {
      setCopying(false);
    }
  };

  const sourceLabel = sourceId || 'All sources';
  const windowLabel = windowS === 300 ? 'Last 5 minutes' : windowS === 3600 ? 'Last 1 hour' : 'Last 24 hours';
  const reportSections: { on: boolean; set: (v: boolean) => void; title: string; desc: string }[] = [
    { on: catKpis, set: setCatKpis, title: 'Performance KPIs', desc: 'Lines, bytes, EPS, bus and worker status' },
    { on: catSources, set: setCatSources, title: 'Source health', desc: 'Connected sources and connector breakdown' },
    { on: catSeverity, set: setCatSeverity, title: 'Severity mix', desc: 'INFO, NOTICE, WARN and RISK distribution' },
    { on: catNormalized, set: setCatNormalized, title: 'OCSF normalization', desc: 'Metrics and pack coverage' },
    { on: catUsage, set: setCatUsage, title: 'Resource usage', desc: 'System usage and airgap telemetry' },
    { on: catInsights, set: setCatInsights, title: 'Insights & findings', desc: 'Posture score, findings, ingest, threat and integrity analytics' },
    { on: catTraffic, set: setCatTraffic, title: 'Traffic analysis', desc: 'Top IPs, ports, users, blocked sources, scan suspects, OCSF classes' },
    { on: catStorage, set: setCatStorage, title: 'Storage efficiency', desc: 'Compression versus raw and the baseline store' },
    { on: catHistory, set: setCatHistory, title: 'Approval audit trail', desc: 'Source approval decisions' },
  ];
  const sectionCount = reportSections.filter((r) => r.on).length;
  const datasets: { v: LogExportType; title: string; desc: string }[] = [
    { v: 'raw', title: 'Raw logs', desc: 'Verbatim lines as ingested' },
    { v: 'ocsf', title: 'OCSF events', desc: 'Normalized, transformed events' },
    { v: 'system', title: 'System audit', desc: 'Platform activity trail' },
  ];
  const modes: { k: 'logs' | 'report' | 'supply'; icon: JSX.Element; title: string; desc: string }[] = [
    { k: 'logs', icon: <IconEvents size={16} />, title: 'Log datasets', desc: '' },
    { k: 'report', icon: <IconExport size={16} />, title: 'System report', desc: '' },
    { k: 'supply', icon: <IconServer size={16} />, title: 'Supply stream', desc: '' },
  ];

  const sourceOptions = (allLabel: string) => (
    <>
      <option value="">{allLabel}</option>
      {availableSources.map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
    </>
  );

  return (
    <div className="stack">
      <PageHead
        title="Export & Log Supply"
        right={
          <Badge kind={supply?.active ? 'ok' : 'plain'}>
            {supply?.active ? `Stream active · :${supply.port}` : 'Stream inactive'}
          </Badge>
        }
      >
        Download log datasets, generate a PDF report, or stream live logs over TCP.
      </PageHead>

      <div className="xp-seg" role="tablist" style={{ ['--i' as string]: modes.findIndex((m) => m.k === tab) }}>
        <span className="xp-seg-thumb" aria-hidden="true" />
        {modes.map((m) => (
          <button
            key={m.k}
            role="tab"
            type="button"
            aria-selected={tab === m.k}
            className={tab === m.k ? 'on' : ''}
            onClick={() => handleTabChange(m.k)}
          >
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
                    <button
                      key={d.v}
                      type="button"
                      className={`xp-opt${logType === d.v ? ' on' : ''}`}
                      onClick={() => setLogType(d.v)}
                    >
                      <strong>{d.title}</strong>
                      <small>{d.desc}</small>
                    </button>
                  ))}
                </div>
                <label className="field">
                  <span className="lbl">File format</span>
                  <select value={logFmt} onChange={(e) => setLogFmt(e.target.value as LogExportFormat)}>
                    <option value="json">JSON array (.json)</option>
                    <option value="jsonl">NDJSON stream (.jsonl)</option>
                    <option value="csv">CSV table (.csv)</option>
                    <option value="tsv">TSV table (.tsv)</option>
                    <option value="text">Syslog text lines (.log)</option>
                    <option value="cef">CEF, Common Event Format (.cef)</option>
                    <option value="leef">LEEF, Log Event Extended Format (.leef)</option>
                    <option value="xml">XML document (.xml)</option>
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
                    <span className="lbl">Severity</span>
                    <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                      <option value="">All severities</option>
                      <option value="info">INFO</option>
                      <option value="notice">NOTICE</option>
                      <option value="warn">WARN</option>
                      <option value="risk">RISK / ERROR</option>
                    </select>
                  </label>
                  <label className="field xp-full">
                    <span className="lbl">Keyword</span>
                    <input type="text" placeholder="Only lines containing…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
                  </label>
                  <label className="field xp-full">
                    <span className="lbl">Record limit <b className="xp-val">{limit.toLocaleString()}</b></span>
                    <input type="range" min="50" max="10000" step="50" value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
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
                <dt>Severity</dt><dd>{severity ? severity.toUpperCase() : 'All'}</dd>
                <dt>Keyword</dt><dd>{searchQuery || 'None'}</dd>
                <dt>Limit</dt><dd>{limit.toLocaleString()} records</dd>
              </dl>
              <div className="xp-btns">
                <button type="button" className="primary" onClick={handleDownloadLogs}>
                  <IconExport size={16} /> Download {logFmt.toUpperCase()}
                </button>
                <button type="button" onClick={handleCopyLogs} disabled={copying}>
                  {copying ? <Spinner /> : copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  {copied ? 'Copied' : 'Copy preview'}
                </button>
              </div>
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
                    <span className="lbl">Time window</span>
                    <select value={windowS} onChange={(e) => setWindowS(Number(e.target.value))}>
                      <option value={300}>Last 5 minutes</option>
                      <option value={3600}>Last 1 hour</option>
                      <option value={86400}>Last 24 hours</option>
                    </select>
                  </label>
                </div>
              </section>

              <section className="xp-card">
                <h3 className="xp-h">Sections in the PDF <span className="xp-count">{sectionCount}/{reportSections.length} selected</span></h3>
                <div className="xp-fields">
                  {reportSections.map((r) => (
                    <label key={r.title} className={`xp-check${r.on ? ' on' : ''}`}>
                      <input type="checkbox" checked={r.on} onChange={(e) => r.set(e.target.checked)} />
                      <span><strong>{r.title}</strong><small>{r.desc}</small></span>
                    </label>
                  ))}
                </div>
              </section>
            </div>

            <aside className="xp-side">
              <h3 className="xp-h">Summary</h3>
              <dl className="xp-kv">
                <dt>Format</dt><dd>PDF</dd>
                <dt>Source</dt><dd>{sourceLabel}</dd>
                <dt>Window</dt><dd>{windowLabel}</dd>
                <dt>Sections</dt><dd>{sectionCount} of {reportSections.length}</dd>
              </dl>
              <div className="xp-btns">
                <button type="button" className="primary" onClick={handleDownloadReport} disabled={sectionCount === 0}>
                  <IconExport size={16} /> Download report
                </button>
              </div>
            </aside>
          </>
        )}

        {/* ============ SUPPLY ============ */}
        {tab === 'supply' && (
          <>
            <div className="xp-main">
              {loadingSupply ? (
                <section className="xp-card"><Spinner label="Loading supply settings…" /></section>
              ) : (
                <>
                  <section className="xp-card">
                    <h3 className="xp-h">Stream settings</h3>
                    <div className="xp-fields">
                      <label className="field">
                        <span className="lbl">TCP port</span>
                        <input type="number" value={supplyPort} onChange={(e) => setSupplyPort(Number(e.target.value))} disabled={supplyEnabled} placeholder="9099" />
                      </label>
                      <label className="field">
                        <span className="lbl">Source</span>
                        <select value={supplySource} disabled={supplyEnabled} onChange={(e) => setSupplySource(e.target.value)}>{sourceOptions('All sources')}</select>
                      </label>
                      <label className="field xp-full">
                        <span className="lbl">Payload format</span>
                        <select value={supplyFormat} disabled={supplyEnabled} onChange={(e) => setSupplyFormat(e.target.value)}>
                          <option value="raw">Raw lines: [source] [SEV] text</option>
                          <option value="ocsf">OCSF JSON (NDJSON)</option>
                        </select>
                      </label>
                    </div>
                    <p className="hint xp-p">{supplyEnabled ? 'Settings are locked while the stream is on. Turn it off to edit.' : 'Settings apply when you turn the stream on.'}</p>
                  </section>

                  <section className="xp-card">
                    <h3 className="xp-h"><IconTerminal size={16} /> Connect a receiver</h3>
                    <p className="hint xp-p">Run this in any terminal to read the live feed.</p>
                    <div className="xp-cmd">
                      <code className="mono grow">nc 127.0.0.1 {supplyPort}</code>
                      <button
                        type="button"
                        className="ghost icon"
                        onClick={() => {
                          void navigator.clipboard.writeText(`nc 127.0.0.1 ${supplyPort}`);
                          toast({ kind: 'ok', title: 'Command copied', body: `nc 127.0.0.1 ${supplyPort}` });
                        }}
                        title="Copy command"
                      >
                        <IconCopy size={16} />
                      </button>
                    </div>
                  </section>
                </>
              )}
            </div>

            <aside className="xp-side">
              <h3 className="xp-h">Server</h3>
              <div className="xp-status">
                <Badge kind={supply?.active ? 'ok' : 'plain'}>{supply?.active ? `Active :${supply.port}` : 'Inactive'}</Badge>
              </div>
              <div className="xp-btns">
                <button
                  type="button"
                  className={supplyEnabled ? '' : 'primary'}
                  onClick={() => {
                    const next = !supplyEnabled;
                    setSupplyEnabled(next);
                    void handleSaveSupply(next);
                  }}
                  disabled={savingSupply}
                >
                  {savingSupply ? 'Saving…' : supplyEnabled ? 'Turn off stream' : 'Turn on stream'}
                </button>
              </div>
              <dl className="xp-kv">
                <dt>Clients</dt><dd>{supply?.clients_count ?? 0}</dd>
                <dt>Lines sent</dt><dd>{(supply?.lines_sent ?? 0).toLocaleString()}</dd>
                <dt>Data sent</dt><dd>{((supply?.bytes_sent ?? 0) / 1024).toFixed(1)} KB</dd>
              </dl>
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
