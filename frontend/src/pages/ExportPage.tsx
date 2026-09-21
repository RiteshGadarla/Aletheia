import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, PageHead, Panel, Spinner } from '../components/Bits';
import { IconCheck, IconCopy, IconEvents, IconExport, IconServer, IconTerminal } from '../components/Icons';
import { api, errMessage } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { LogExportFormat, LogExportType, ReportFormat, SupplyStatus } from '../lib/types';

export function ExportPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as 'report' | 'logs' | 'supply') || 'report';
  const initialSource = searchParams.get('source') || '';

  const [tab, setTab] = useState<'report' | 'logs' | 'supply'>(initialTab);
  const [sourceId, setSourceId] = useState(initialSource);

  // Load available sources
  const sourcesQuery = useAsync(() => api.listSources(), []);
  const availableSources = sourcesQuery.data?.sources.map((s) => s.id) ?? [];


  // Report State
  const [reportFmt, setReportFmt] = useState<ReportFormat>('json');
  const [windowS, setWindowS] = useState(300);
  const [catKpis, setCatKpis] = useState(true);
  const [catSources, setCatSources] = useState(true);
  const [catSeverity, setCatSeverity] = useState(true);
  const [catNormalized, setCatNormalized] = useState(true);
  const [catUsage, setCatUsage] = useState(true);
  const [catHistory, setCatHistory] = useState(true);

  // Logs State
  const [logType, setLogType] = useState<LogExportType>('raw');
  const [logFmt, setLogFmt] = useState<LogExportFormat>('json');
  const [severity, setSeverity] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [limit, setLimit] = useState(500);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);

  // Supply Server State
  const [supply, setSupply] = useState<SupplyStatus | null>(null);
  const [supplyPort, setSupplyPort] = useState(9099);
  const [supplyFormat, setSupplyFormat] = useState('raw');
  const [supplySource, setSupplySource] = useState('');
  const [supplyEnabled, setSupplyEnabled] = useState(false);
  const [loadingSupply, setLoadingSupply] = useState(false);
  const [savingSupply, setSavingSupply] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadSupplyStatus();
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
    } catch (e) {
      // silent fallback
    } finally {
      setLoadingSupply(false);
    }
  };

  const handleTabChange = (newTab: 'report' | 'logs' | 'supply') => {
    setTab(newTab);
    setSearchParams({ tab: newTab, ...(sourceId ? { source: sourceId } : {}) });
  };

  const handleSaveSupply = async (overrideEnabled?: boolean) => {
    setSavingSupply(true);
    setMsg(null);
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
      setMsg({ type: 'ok', text: `Log Supply Stream server ${res.active ? 'ACTIVE on TCP port ' + res.port : 'STOPPED'}.` });
    } catch (e) {
      setMsg({ type: 'error', text: errMessage(e) });
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
    ].filter(Boolean).join(',');

    const url = api.exportReportUrl({
      format: reportFmt,
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
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setMsg({ type: 'error', text: 'Failed to copy to clipboard: ' + errMessage(e) });
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="stack">
      <PageHead
        title="Export & Centralized Log Supply"
        right={
          <div className="flex align-center" style={{ gap: 10 }}>
            <Badge kind={supply?.active ? 'ok' : 'plain'}>
              {supply?.active ? `Log Supply Stream ACTIVE (: ${supply.port})` : 'Log Supply Stream INACTIVE'}
            </Badge>
          </div>
        }
      >
        Export high-level operational system reports, filter & download centralized log datasets, or stream live centralized logs to third-party receivers via a dedicated TCP port.
      </PageHead>

      {/* Interactive Navigation Cards */}
      <div className="provider-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', margin: '0' }}>
        <button
          type="button"
          className={tab === 'report' ? 'provider-card selected' : 'provider-card'}
          onClick={() => handleTabChange('report')}
          style={{ padding: 'var(--s4)' }}
        >
          <div className="provider-card-header">
            <div className="provider-card-icon-title">
              <div className="provider-icon-wrapper local-icon">
                <IconExport size={20} />
              </div>
              <div>
                <div className="provider-card-title-text">System Reports</div>
                <div className="hint" style={{ fontSize: '12px' }}>JSON, CSV, MD, HTML</div>
              </div>
            </div>
            {tab === 'report' && <Badge kind="info">Active</Badge>}
          </div>
        </button>

        <button
          type="button"
          className={tab === 'logs' ? 'provider-card selected' : 'provider-card'}
          onClick={() => handleTabChange('logs')}
          style={{ padding: 'var(--s4)' }}
        >
          <div className="provider-card-header">
            <div className="provider-card-icon-title">
              <div className="provider-icon-wrapper gemini-icon">
                <IconEvents size={20} />
              </div>
              <div>
                <div className="provider-card-title-text">Log Dataset Exporter</div>
                <div className="hint" style={{ fontSize: '12px' }}>Raw, OCSF & Audit</div>
              </div>
            </div>
            {tab === 'logs' && <Badge kind="info">Active</Badge>}
          </div>
        </button>

        <button
          type="button"
          className={tab === 'supply' ? 'provider-card selected' : 'provider-card'}
          onClick={() => handleTabChange('supply')}
          style={{ padding: 'var(--s4)' }}
        >
          <div className="provider-card-header">
            <div className="provider-card-icon-title">
              <div className={`provider-icon-wrapper ${supply?.active ? 'local-icon' : 'none-icon'}`}>
                <IconServer size={20} />
              </div>
              <div>
                <div className="provider-card-title-text">Supply Stream Server</div>
                <div className="hint" style={{ fontSize: '12px' }}>{supply?.active ? `Active (: ${supply.port})` : 'Disabled'}</div>
              </div>
            </div>
            {tab === 'supply' && <Badge kind="info">Active</Badge>}
          </div>
        </button>
      </div>

      {msg && (
        <div className={`banner ${msg.type === 'error' ? 'bad' : 'info'}`}>
          <span>{msg.text}</span>
        </div>
      )}


      {/* Tab 1: System Report Exporter */}
      {tab === 'report' && (
        <Panel title="Generate Operational System Report" subtitle="Download a comprehensive metric report of pipeline stats, log sources, OCSF normalization, and system audit history.">
          <div className="stack-md" style={{ padding: 'var(--s2) 0' }}>
            <div className="form-grid">
              <div className="field">
                <label className="lbl">Report Format</label>
                <div className="radio-group">
                  {(['json', 'csv', 'markdown', 'html'] as ReportFormat[]).map((fmt) => (
                    <label key={fmt} className={reportFmt === fmt ? 'radio-pill checked' : 'radio-pill'}>
                      <input
                        type="radio"
                        name="reportFmt"
                        value={fmt}
                        checked={reportFmt === fmt}
                        onChange={() => setReportFmt(fmt)}
                      />
                      {fmt.toUpperCase()}
                    </label>
                  ))}
                </div>
              </div>

              <div className="field">
                <label className="lbl">Source Filter</label>
                <select className="input" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                  <option value="">All Connected Log Sources</option>
                  {availableSources.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label className="lbl">Time Range Window</label>
                <select className="input" value={windowS} onChange={(e) => setWindowS(Number(e.target.value))}>
                  <option value={300}>Last 5 Minutes</option>
                  <option value={3600}>Last 1 Hour</option>
                  <option value={86400}>Last 24 Hours</option>
                </select>
              </div>
            </div>

            <div className="panel" style={{ background: 'var(--surface-2)', padding: 'var(--s4)', borderRadius: 'var(--r-xl)' }}>
              <div className="lbl" style={{ marginBottom: 'var(--s3)', fontSize: '13px', fontWeight: 600 }}>Report Metric Sections to Include</div>
              <div className="checkbox-grid">
                <label className="checkbox-label">
                  <input type="checkbox" checked={catKpis} onChange={(e) => setCatKpis(e.target.checked)} />
                  System KPIs (EPS, Lines, Bytes, Bus)
                </label>
                <label className="checkbox-label">
                  <input type="checkbox" checked={catSources} onChange={(e) => setCatSources(e.target.checked)} />
                  Source Health & Connectors Status
                </label>
                <label className="checkbox-label">
                  <input type="checkbox" checked={catSeverity} onChange={(e) => setCatSeverity(e.target.checked)} />
                  Severity Distribution Breakdown
                </label>
                <label className="checkbox-label">
                  <input type="checkbox" checked={catNormalized} onChange={(e) => setCatNormalized(e.target.checked)} />
                  OCSF Normalization Metrics
                </label>
                <label className="checkbox-label">
                  <input type="checkbox" checked={catUsage} onChange={(e) => setCatUsage(e.target.checked)} />
                  System Usage & Airgap Status
                </label>
                <label className="checkbox-label">
                  <input type="checkbox" checked={catHistory} onChange={(e) => setCatHistory(e.target.checked)} />
                  Source Decision & Audit History
                </label>
              </div>
            </div>

            <div className="modal-actions-right">
              <button type="button" className="btn primary flex align-center" onClick={handleDownloadReport} style={{ gap: 6 }}>
                <IconExport size={16} /> Download System Report ({reportFmt.toUpperCase()})
              </button>
            </div>
          </div>
        </Panel>
      )}

      {/* Tab 2: Logs Exporter */}
      {tab === 'logs' && (
        <Panel title="Query & Export Centralized Logs" subtitle="Filter logs by dataset type, severity, source ID, and search terms, then export in your preferred format.">
          <div className="stack-md" style={{ padding: 'var(--s2) 0' }}>
            <div className="form-grid">
              <div className="field">
                <label className="lbl">Dataset Type</label>
                <div className="radio-group">
                  <label className={logType === 'raw' ? 'radio-pill checked' : 'radio-pill'}>
                    <input type="radio" name="logType" value="raw" checked={logType === 'raw'} onChange={() => setLogType('raw')} />
                    Raw Verbatim Logs
                  </label>
                  <label className={logType === 'ocsf' ? 'radio-pill checked' : 'radio-pill'}>
                    <input type="radio" name="logType" value="ocsf" checked={logType === 'ocsf'} onChange={() => setLogType('ocsf')} />
                    Transformed OCSF Events
                  </label>
                  <label className={logType === 'system' ? 'radio-pill checked' : 'radio-pill'}>
                    <input type="radio" name="logType" value="system" checked={logType === 'system'} onChange={() => setLogType('system')} />
                    System Audit Logs
                  </label>
                </div>
              </div>

              <div className="field">
                <label className="lbl">Output Format</label>
                <div className="radio-group">
                  {(['json', 'jsonl', 'csv', 'text'] as LogExportFormat[]).map((fmt) => (
                    <label key={fmt} className={logFmt === fmt ? 'radio-pill checked' : 'radio-pill'}>
                      <input type="radio" name="logFmt" value={fmt} checked={logFmt === fmt} onChange={() => setLogFmt(fmt)} />
                      {fmt === 'jsonl' ? 'NDJSON (JSONL)' : fmt === 'text' ? 'Syslog / Text' : fmt.toUpperCase()}
                    </label>
                  ))}
                </div>
              </div>

              <div className="field">
                <label className="lbl">Source Filter</label>
                <select className="input" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                  <option value="">All Sources</option>
                  {availableSources.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label className="lbl">Severity / Level</label>
                <select className="input" value={severity} onChange={(e) => setSeverity(e.target.value)}>
                  <option value="">All Severities</option>
                  <option value="info">INFO</option>
                  <option value="notice">NOTICE</option>
                  <option value="warn">WARN</option>
                  <option value="risk">RISK / ERROR</option>
                </select>
              </div>

              <div className="field">
                <label className="lbl">Search Term / Keyword</label>
                <input
                  type="text"
                  className="input"
                  placeholder="Filter lines containing keyword..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>

              <div className="field">
                <label className="lbl">Record Limit ({limit.toLocaleString()} logs)</label>
                <input
                  type="range"
                  min="50"
                  max="10000"
                  step="50"
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                  style={{ width: '100%', marginTop: '8px' }}
                />
              </div>
            </div>

            <div className="modal-actions-right" style={{ gap: 10 }}>
              <button type="button" className="btn secondary flex align-center" onClick={handleCopyLogs} disabled={copying} style={{ gap: 6 }}>
                {copying ? <Spinner /> : copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                {copied ? 'Copied to Clipboard!' : 'Copy Preview'}
              </button>
              <button type="button" className="btn primary flex align-center" onClick={handleDownloadLogs} style={{ gap: 6 }}>
                <IconExport size={16} /> Download Filtered Logs ({logFmt.toUpperCase()})
              </button>
            </div>
          </div>
        </Panel>
      )}

      {/* Tab 3: Supply Log Stream Server */}
      {tab === 'supply' && (
        <Panel title="Centralized Log Supply Streaming Server" subtitle="Supply live log streams to external receivers, SIEMs, or local socket consumers over a dedicated TCP port.">
          <div className="stack-md" style={{ padding: 'var(--s2) 0' }}>
            {loadingSupply ? (
              <div className="flex center p-md"><Spinner label="Loading supply server settings..." /></div>
            ) : (
              <>
                <div className="form-grid">
                  <div className="field">
                    <label className="lbl">Server Operational State</label>
                    <div className="flex align-center" style={{ gap: 12 }}>
                      <button
                        type="button"
                        className={supplyEnabled ? 'btn bad' : 'btn primary'}
                        onClick={() => {
                          const next = !supplyEnabled;
                          setSupplyEnabled(next);
                          handleSaveSupply(next);
                        }}
                        disabled={savingSupply}
                      >
                        {savingSupply ? <Spinner /> : supplyEnabled ? 'Turn OFF Supply Server' : 'Turn ON Supply Server'}
                      </button>
                      <Badge kind={supply?.active ? 'ok' : 'plain'}>
                        {supply?.active ? `ACTIVE on TCP :${supply.port}` : 'INACTIVE'}
                      </Badge>
                    </div>
                  </div>

                  <div className="field">
                    <label className="lbl">Streaming TCP Port</label>
                    <input
                      type="number"
                      className="input"
                      value={supplyPort}
                      onChange={(e) => setSupplyPort(Number(e.target.value))}
                      placeholder="9099"
                    />
                  </div>

                  <div className="field">
                    <label className="lbl">Stream Payload Format</label>
                    <select className="input" value={supplyFormat} onChange={(e) => setSupplyFormat(e.target.value)}>
                      <option value="raw">Raw Line Stream ([source] [SEV] text)</option>
                      <option value="ocsf">OCSF JSON Stream (NDJSON)</option>
                    </select>
                  </div>

                  <div className="field">
                    <label className="lbl">Filter Source</label>
                    <select className="input" value={supplySource} onChange={(e) => setSupplySource(e.target.value)}>
                      <option value="">All Ingested Log Sources</option>
                      {availableSources.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="modal-actions-right">
                  <button type="button" className="btn secondary" onClick={() => handleSaveSupply()} disabled={savingSupply}>
                    {savingSupply ? <Spinner /> : 'Save & Update Supply Settings'}
                  </button>
                </div>

                {/* Operational Metrics Grid */}
                <div className="panel" style={{ background: 'var(--surface-2)', padding: 'var(--s4)', borderRadius: 'var(--r-xl)', border: '1px solid var(--border-soft)' }}>
                  <div className="panel-title" style={{ fontSize: '0.9rem', marginBottom: 12 }}>
                    Live Supply Server Metrics
                  </div>
                  <div className="grid-3">
                    <div className="kpi-sm">
                      <div className="k-label">Active Receivers</div>
                      <div className="k-value" style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--accent)' }}>
                        {supply?.clients_count ?? 0} clients
                      </div>
                    </div>
                    <div className="kpi-sm">
                      <div className="k-label">Lines Broadcasted</div>
                      <div className="k-value" style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--ok)' }}>
                        {(supply?.lines_sent ?? 0).toLocaleString()} lines
                      </div>
                    </div>
                    <div className="kpi-sm">
                      <div className="k-label">Total Data Sent</div>
                      <div className="k-value" style={{ fontSize: '1.4rem', fontWeight: 700 }}>
                        {((supply?.bytes_sent ?? 0) / 1024).toFixed(1)} KB
                      </div>
                    </div>
                  </div>
                </div>

                {/* Terminal Connection Receiver Helper */}
                <div className="panel" style={{ background: 'var(--surface-2)', padding: 'var(--s4)', borderRadius: 'var(--r-xl)', border: '1px solid var(--border-soft)' }}>
                  <div className="lbl" style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <IconTerminal size={16} /> External Receiver Terminal Command
                  </div>
                  <p className="hint" style={{ fontSize: '0.85rem', marginBottom: 8 }}>
                    Receive live centralized logs directly from any terminal, local script, or external container:
                  </p>
                  <div className="code-box flex align-center justify-between" style={{ background: '#090d16', padding: '10px 14px', borderRadius: 6, color: '#38bdf8', fontFamily: 'monospace' }}>
                    <code>nc 127.0.0.1 {supplyPort}</code>
                    <button
                      type="button"
                      className="ghost icon flex align-center"
                      onClick={() => navigator.clipboard.writeText(`nc 127.0.0.1 ${supplyPort}`)}
                      title="Copy connection command"
                      style={{ color: '#ffffff' }}
                    >
                      <IconCopy size={14} />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}
