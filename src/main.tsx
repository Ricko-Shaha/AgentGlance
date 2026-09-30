import React, { useCallback, useEffect, useRef, useState } from 'react';

import { createRoot } from 'react-dom/client';

import { ChevronDown, Grip, Info, Minus, Pin, RefreshCw, RotateCw, X } from 'lucide-react';

import codexLogo from '../assets/logos/codex.svg';

import claudeLogo from '../assets/logos/claude.svg';

import kimiLogo from '../assets/logos/kimi.png';

import geminiLogo from '../assets/logos/gemini.png';

import opencodeLogo from '../assets/logos/opencode.png';
import qwenLogo from '../assets/logos/qwen.png';
import glmLogo from '../assets/logos/glm.svg';
import deepseekLogo from '../assets/logos/deepseek.svg';

import './styles.css';



type ProviderId = 'codex' | 'claude' | 'kimi' | 'gemini' | 'opencode' | 'qwen' | 'glm' | 'deepseek';

type Layout = 'vertical' | 'horizontal';

type UsageLimit = { id: string; label: string; usedPercent: number; resetsAt: string | null };

type ContextUsage = { usedTokens: number | null; maxTokens: number | null; usedPercent: number | null; sessionLabel: string; updatedAt: string };

type Usage = { state: 'available' | 'partial' | 'unavailable'; limits: UsageLimit[]; context: ContextUsage | null; source: string; updatedAt: string | null; message: string | null; stale: boolean };

type Activity = { state: 'free' | 'occupied' | 'waiting' | 'unknown'; detail: string; updatedAt: string | null; source: string };

type TaskContext = { id: string; label: string; state: 'free' | 'occupied' | 'waiting' | 'unknown'; updatedAt: string; context: { usedTokens: number | null; maxTokens: number | null; usedPercent: number | null } | null };

type Provider = { id: ProviderId; name: string; description: string; status: 'running' | 'idle' | 'unknown'; authSource: string; processCount: number; lastActivityAt: string | null; detail: string; usage?: Usage; activity?: Activity; tasks?: TaskContext[] };

type Snapshot = { providers: Provider[]; checkedAt: string; scanDurationMs: number; platform: string };

type Preferences = { compact: boolean; alwaysOnTop: boolean; layout?: Layout };
type Capabilities = { manualDrag: boolean; layouts: boolean; pin: boolean; message: string | null };
type ClaudeIntegration = { signedIn: boolean; installed: boolean; usageConnected: boolean; activityConnected: boolean; legacy: boolean; canConnect: boolean; canDisconnect: boolean; reason: string | null };

declare global { interface Window { statusline?: { getCapabilities?(): Promise<Capabilities>; getClaudeIntegration?(): Promise<ClaudeIntegration>; connectClaude?(): Promise<ClaudeIntegration>; disconnectClaude?(): Promise<ClaudeIntegration>; getSnapshot(): Promise<Snapshot>; subscribe(callback: (snapshot: Snapshot) => void): () => void; refresh(): Promise<Snapshot>; setCompact(value: boolean): Promise<void> | void; setLayout?(value: Layout): Promise<void>; setDetailsOpen?(value: boolean): Promise<void>; setTaskContextOpen?(value: boolean): Promise<void>; setAlwaysOnTop(value: boolean): Promise<void> | void; startWindowDrag(point: { x: number; y: number }): Promise<void>; moveWindowDrag(point: { x: number; y: number }): Promise<void>; endWindowDrag(): Promise<void>; minimize(): void; close(): void; getPreferences(): Promise<Preferences>; openProvider(id: string): Promise<void> } } }

const bridge = window.statusline;

const logos: Record<ProviderId, string> = { codex: codexLogo, claude: claudeLogo, kimi: kimiLogo, gemini: geminiLogo, opencode: opencodeLogo, qwen: qwenLogo, glm: glmLogo, deepseek: deepseekLogo };

const validPercent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function ClaudeConnection() {
  const [status, setStatus] = useState<ClaudeIntegration | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    bridge?.getClaudeIntegration?.().then(value => { if (alive) setStatus(value); }).catch(() => { if (alive) setError('Could not read Claude integration settings.'); });
    return () => { alive = false; };
  }, []);
  if (!bridge?.getClaudeIntegration) return null;
  const change = async (connect: boolean) => {
    setPending(true); setError('');
    try {
      const result = await (connect ? bridge.connectClaude?.() : bridge.disconnectClaude?.());
      if (result) setStatus(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Could not update Claude settings.'); }
    finally { setPending(false); }
  };
  return <div className="claude-connection" data-testid="claude-connection">
    <strong>Claude telemetry</strong>
    {status ? <>
      <p>{status.usageConnected && status.activityConnected ? 'Connected. New Claude sessions report usage, context, and activity automatically.' : 'Connect Claude to report usage, context, and activity. This adds local status-line and activity hooks to your Claude settings and preserves your existing commands.'}</p>
      {status.reason && !(status.usageConnected && status.activityConnected) && <p>{status.reason}</p>}
      {status.legacy && <p>Your existing connection is preserved.</p>}
      {status.canConnect && !(status.usageConnected && status.activityConnected) && <button disabled={pending} onClick={() => void change(true)}>{pending ? 'Connecting…' : 'Connect Claude'}</button>}
      {status.canDisconnect && <button disabled={pending} onClick={() => void change(false)}>{pending ? 'Disconnecting…' : 'Disconnect Claude'}</button>}
    </> : !error && <p>Checking connection…</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

const timestamp = (date: string | null | undefined) => date && Number.isFinite(Date.parse(date)) ? new Date(date).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not observed';

function percent(value: number) { return value >= 100 ? `${Math.round(value)}` : `${Math.round(value * 10) / 10}`; }

function usageLimits(provider: Provider) {

  const limits = provider.usage?.limits ?? [];

  return {

    five: limits.find(limit => /five.?hour|5.?hour|5h/i.test(`${limit.id} ${limit.label}`)),

    week: limits.find(limit => /seven.?day|7.?day|weekly|week/i.test(`${limit.id} ${limit.label}`)),

  };

}

async function fetchSnapshot(refresh = false): Promise<Snapshot> {

  if (bridge) return refresh ? bridge.refresh() : bridge.getSnapshot();

  const response = await fetch('/api/status', { method: refresh ? 'POST' : 'GET' });

  if (!response.ok) throw new Error('Local service unavailable. Open the desktop app or retry.');

  const result = await response.json();

  if (!Array.isArray(result.providers)) throw new Error('Unexpected local status response.');

  return result;

}

function resetStatus(date: string | null | undefined, now: number) {
  const time = date ? Date.parse(date) : NaN;
  if (!Number.isFinite(time)) return { relative: 'Reset time unavailable', exact: null };
  const remaining = time - now;
  const exact = timestamp(date);
  if (remaining <= 0) return { relative: 'Reset due · awaiting update', exact };
  const minutes = Math.ceil(remaining / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return { relative: `Resets in ${days ? `${days}d ${hours}h` : hours ? `${hours}h ${rest}m` : `${minutes}m`}`, exact };
}
function UsageMeter({ label, kind, value, tokens, detail, stale, resetsAt, now, onSelect }: { label: string; kind: string; value: number | null | undefined; tokens?: number | null; detail: string; stale: boolean; resetsAt?: string | null; now: number; onSelect(): void }) {
  const known = validPercent(value);
  const reset = resetStatus(resetsAt, now);
  const compactReset = !reset.exact ? '—' : reset.relative.startsWith('Resets in ') ? reset.relative.slice(10) : 'Due';
  const level = !known ? 'unknown' : value >= 90 ? 'red' : value >= 75 ? 'orange' : value >= 50 ? 'yellow' : 'green';
  return <button data-testid="usage-meter" data-kind={kind} data-state={known ? 'reported' : 'unknown'} data-level={level} className={`usage-meter ${stale ? 'stale' : ''}`} title={detail} aria-label={`${label}: ${known ? `${percent(value)} percent used` : tokens != null ? `${tokens.toLocaleString()} tokens; percentage unavailable` : 'unavailable'}. ${reset.relative}${reset.exact ? `. ${reset.exact}` : ''}. ${detail}`} onClick={onSelect}>
    <span className="meter-label">{label}</span>
    <svg className="usage-ring" viewBox="0 0 32 32" aria-hidden="true"><circle className="ring-track" cx="16" cy="16" r="13.5" /><circle className="ring-value" cx="16" cy="16" r="13.5" pathLength="100" strokeDasharray={`${known ? Math.min(100, value) : 0} 100`} /></svg>
    <span className="meter-track"><span style={{ width: `${known ? Math.min(100, value) : 0}%` }} /></span>
    <span className="meter-value">{known ? `${percent(value)}%` : tokens != null ? `${Math.round(tokens / 1000)}k` : '—'}{stale && known && <span className="stale-mark" title="Older observation">*</span>}</span>
    <span className="meter-reset" data-testid="usage-reset" data-reset-state={!reset.exact ? 'unavailable' : Date.parse(resetsAt!) <= now ? 'due' : 'scheduled'} title={reset.exact ? `Local reset time: ${reset.exact}` : reset.relative}><span className="full-reset-countdown" data-testid="reset-countdown">{reset.relative}</span><span className="compact-reset-countdown" data-testid="compact-reset-countdown" aria-hidden="true">↻ {compactReset}</span>{reset.exact && <time dateTime={resetsAt!}>{reset.exact}</time>}</span>
  </button>;
}

function compactTokens(value: number) {

  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;

  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;

  return value.toLocaleString();

}

function taskAge(date: string) {

  const elapsed = Math.max(0, Date.now() - Date.parse(date));

  if (!Number.isFinite(elapsed)) return 'Unobserved';

  if (elapsed < 60_000) return 'Just now';

  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;

  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;

  return `${Math.floor(elapsed / 86_400_000)}d ago`;

}

function TaskContexts({ provider, expanded, onToggle }: { provider: Provider; expanded: boolean; onToggle(): void }) {

  const tasks = provider.tasks ?? [];
  const panelId = `task-context-${provider.id}`;

  return <section className="provider-tasks" aria-label={`${provider.name} task context`}>

    <button data-testid="task-context-toggle" className="task-section-heading" title={`${provider.name}: ${tasks.length} task sessions. ${expanded ? 'Hide' : 'Show'} context.`} aria-label={`${provider.name} task context`} aria-expanded={expanded} aria-controls={panelId} onClick={onToggle}><span className="task-heading-label"><ChevronDown size={12} /><span>Task context</span></span></button>

    <div id={panelId} hidden={!expanded} className="task-list" tabIndex={expanded && tasks.length ? 0 : undefined} aria-label={`${provider.name}: ${tasks.length} observed sessions`}>
      <div className="task-scope" title="Operating-system processes and observed sessions are separate counts."><span data-testid="process-count">{provider.status === 'unknown' ? 'Processes unknown' : `${provider.processCount} ${provider.processCount === 1 ? 'process' : 'processes'}`}</span><span aria-hidden="true"> · </span><span data-testid="task-count" aria-label={`${tasks.length} observed sessions`}>{tasks.length}</span> sessions</div>

      {expanded && tasks.map(task => {

        const context = task.context;

        const known = validPercent(context?.usedPercent);

        const used = context?.usedTokens;

        const max = context?.maxTokens;

        const capacityKnown = typeof max === 'number' && Number.isFinite(max) && max > 0;

        const validUsed = typeof used === 'number' && Number.isFinite(used) && used >= 0;

        const stateLabel = task.state === 'occupied' ? 'Working' : task.state === 'waiting' ? 'Waiting for input' : task.state === 'free' ? 'Free' : 'Activity unknown';

        const fullContext = `${validUsed ? `${used.toLocaleString()} tokens used` : 'Token count unavailable'}${capacityKnown ? ` of ${max.toLocaleString()} capacity` : '; capacity unavailable'}${known ? `; ${percent(context!.usedPercent!)} percent used` : ''}`;

        const duplicate = tasks.some(other => other.id !== task.id && other.label === task.label);

        const label = task.label.trim() || `Session ${task.id.slice(-6)}`;

        return <div key={task.id} className="task-row" data-testid="task-context" data-task-id={task.id} data-provider={provider.id} data-state={task.state} data-context-state={known ? 'reported' : 'unknown'} title={`${label}. ${stateLabel}. ${fullContext}. Observed ${timestamp(task.updatedAt)}.`}>

          <div className="task-row-heading"><span className={`task-state ${task.state}`} role="img" aria-label={stateLabel} /><span className="task-label" title={label}>{label}{duplicate && <small> · {task.id.slice(-5)}</small>}</span><time dateTime={task.updatedAt} title={`Observed ${timestamp(task.updatedAt)}`}>{taskAge(task.updatedAt)}</time></div>

          <div className="task-context-reading"><span className="task-token-count">{validUsed ? capacityKnown ? `${compactTokens(used)} / ${compactTokens(max)} tokens` : `${compactTokens(used)} tokens · capacity unavailable` : 'Context not observed'}</span>{known && <strong>{percent(context!.usedPercent!)}%</strong>}</div>

          <div className={`task-meter ${known ? '' : 'unreported'}`} role="meter" aria-label={`${label} context used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.min(100, context!.usedPercent!) : undefined} aria-valuetext={fullContext}><span style={{ width: `${known ? Math.min(100, context!.usedPercent!) : 0}%` }} /></div>

        </div>;

      })}

      {expanded && !tasks.length && <p className="tasks-empty">No task context observed yet</p>}

    </div>

  </section>;

}

function App() {

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  const [error, setError] = useState('');

  const [busy, setBusy] = useState(true);

  const [layout, setLayout] = useState<Layout>('horizontal');

  const [pinned, setPinned] = useState(false);

  const [selectedId, setSelectedId] = useState<ProviderId | null>(null);

  const [help, setHelp] = useState(false);

  const [notice, setNotice] = useState('');
  const [capabilities, setCapabilities] = useState<Capabilities>({ manualDrag: true, layouts: true, pin: true, message: null });
  const [expandedTasks, setExpandedTasks] = useState<Partial<Record<ProviderId, boolean>>>({});
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);

  const request = useRef(0);
  const dragging = useRef<number | null>(null);
  const dragFrame = useRef(0);
  const dragPosition = useRef({ x: 0, y: 0 });
  const dragOrigin = useRef({ x: 0, y: 0 });
  const suppressDragClick = useRef(false);

  function startDrag(event: React.PointerEvent<HTMLElement>) {
    suppressDragClick.current = false;
    if (!bridge || !capabilities.manualDrag || event.button !== 0 || event.pointerType !== 'mouse') return;
    if ((event.target as Element).closest('button, a, input, select, textarea, .task-list, .details, .help-panel, .notice, .connection-error')) return;
    event.preventDefault();
    dragging.current = event.pointerId;
    dragOrigin.current = { x: event.screenX, y: event.screenY };
    event.currentTarget.setPointerCapture(event.pointerId);
    void bridge.startWindowDrag({ x: event.screenX, y: event.screenY }).catch(() => { dragging.current = null; });
  }

  function moveDrag(event: React.PointerEvent<HTMLElement>) {
    if (dragging.current !== event.pointerId) return;
    dragPosition.current = { x: event.screenX, y: event.screenY };
    if (Math.hypot(event.screenX - dragOrigin.current.x, event.screenY - dragOrigin.current.y) > 3) suppressDragClick.current = true;
    if (dragFrame.current) return;
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = 0;
      if (dragging.current !== null) void bridge?.moveWindowDrag(dragPosition.current).catch(() => {});
    });
  }

  function endDrag(event: React.PointerEvent<HTMLElement>) {
    if (dragging.current !== event.pointerId) return;
    dragging.current = null;
    cancelAnimationFrame(dragFrame.current);
    dragFrame.current = 0;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (event.type === 'pointerup') void bridge?.moveWindowDrag({ x: event.screenX, y: event.screenY }).catch(() => {});
    void bridge?.endWindowDrag().catch(() => {});
  }

  const applySnapshot = useCallback((value: Snapshot) => { setSnapshot(value); setError(''); setBusy(false); }, []);

  const refresh = useCallback(async () => {

    const current = ++request.current;

    setBusy(true);

    try { const value = await fetchSnapshot(true); if (request.current === current) applySnapshot(value); }

    catch (reason) { if (request.current === current) { setError(reason instanceof Error ? reason.message : 'Could not read local usage.'); setBusy(false); } }

  }, [applySnapshot]);

  useEffect(() => {

    let alive = true;

    fetchSnapshot().then(value => { if (alive) applySnapshot(value); }).catch(() => { if (alive) { setError('Local service unavailable. Open the desktop app or retry.'); setBusy(false); } });

    bridge?.getPreferences().then(prefs => { if (alive) { setPinned(prefs.alwaysOnTop); setLayout(prefs.layout ?? 'horizontal'); } }).catch(() => {});
    bridge?.getCapabilities?.().then(value => { if (alive) setCapabilities(value); }).catch(() => {});

    const stop = bridge?.subscribe(applySnapshot);

    const poll = !bridge ? setInterval(() => { fetchSnapshot().then(value => { if (alive) applySnapshot(value); }).catch(() => { if (alive) setError('Connection lost. Values are from the last successful observation.'); }); }, 10000) : undefined;

    return () => { alive = false; stop?.(); if (poll) clearInterval(poll); };

  }, [applySnapshot]);

  useEffect(() => { if (!notice) return; const timeout = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(timeout); }, [notice]);

  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSelectedId(null); setHelp(false); } }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, []);

  useEffect(() => { bridge?.setDetailsOpen?.(Boolean(selectedId || help || error || notice)).catch(() => {}); }, [selectedId, help, error, notice]);

  useEffect(() => { if (selectedId && snapshot && !snapshot.providers.some(provider => provider.id === selectedId)) setSelectedId(null); }, [snapshot, selectedId]);

  async function toggleLayout() {

    const next = layout === 'vertical' ? 'horizontal' : 'vertical';

    try { await bridge?.setLayout?.(next); setLayout(next); } catch { setNotice('Could not change layout. Try again.'); }

  }

  async function closeWidget() {
    if (!bridge) return;
    try { await bridge.close(); } catch { setNotice('Could not close the widget. Please try again.'); }
  }
  async function togglePin() {

    if (!bridge) { setNotice('Pinning is available in the desktop app.'); return; }

    try { await bridge.setAlwaysOnTop(!pinned); setPinned(!pinned); } catch { setNotice('Could not pin the window. Try again.'); }

  }

  const providers = snapshot?.providers ?? [];
  const anyTasksExpanded = providers.some(provider => expandedTasks[provider.id]);
  useEffect(() => { bridge?.setTaskContextOpen?.(anyTasksExpanded).catch(() => {}); }, [anyTasksExpanded]);

  const selected = providers.find(provider => provider.id === selectedId);

  const lastChecked = snapshot ? new Date(snapshot.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

  return <main data-testid="signal-widget" className={`widget ${layout} ${anyTasksExpanded ? 'tasks-expanded' : ''}`} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onClickCapture={event => { if (suppressDragClick.current) { suppressDragClick.current = false; event.preventDefault(); event.stopPropagation(); } }}>
    {capabilities.manualDrag && <div className="widget-drag-grip" data-testid="drag-grip" title="Drag the grip or empty background to move" aria-label="Drag to move widget"><Grip size={18} /></div>}

    <header className="titlebar"><div className="app-title"><span className="signal-symbol"><i /><i /><i /></span><h1>AgentGlance</h1></div><div className="window-controls"><button disabled={!capabilities.layouts} title={layout === 'vertical' ? 'Horizontal layout' : 'Vertical layout'} onClick={toggleLayout}><RotateCw size={13} /></button><button disabled={!capabilities.pin} title="Always on top" aria-pressed={pinned} className={pinned ? 'active' : ''} onClick={togglePin}><Pin size={13} /></button>{bridge && <><button title="Minimize" onClick={() => bridge.minimize()}><Minus size={14} /></button><button data-testid="close-widget" title="Close widget" aria-label="Close widget" onClick={closeWidget}><X size={14} /></button></>}</div></header>

    <div className="widget-body">

      {error && <div className="connection-error" role="alert">{error}<button disabled={busy} onClick={refresh}>Retry</button></div>}

      <section className="signals" aria-label="Assistant running status and usage">

        {providers.map(provider => {

          const limits = usageLimits(provider);

          const usage = provider.usage;

          const old = Boolean(usage?.stale || error);

          const activityState = error ? 'unknown' : provider.activity?.state ?? (provider.status === 'idle' ? 'free' : 'unknown');

          const processColor = activityState === 'free' ? 'green' : activityState === 'occupied' ? 'red' : activityState === 'waiting' ? 'amber' : 'unknown';

          const processLabel = activityState === 'free' ? 'Free' : activityState === 'occupied' ? 'Occupied' : activityState === 'waiting' ? 'Waiting' : 'Unknown';

          const detail = (limit: UsageLimit | undefined, label: string) => limit && validPercent(limit.usedPercent) ? `${label} usage. ${resetStatus(limit.resetsAt, now).relative}${resetStatus(limit.resetsAt, now).exact ? ` (${resetStatus(limit.resetsAt, now).exact})` : ''}. Observed ${timestamp(usage?.updatedAt)}.${old ? ' This observation may be out of date.' : ''}` : `${label} usage is not reported by this assistant.${usage?.message ? ` ${usage.message}` : ''}`;

          return <article data-testid="provider-signal" className="provider-column" key={provider.id}><div className={`signal-housing ${selectedId === provider.id ? 'is-selected' : ''}`}>

            <button data-testid="process-light" data-state={processColor} title={`${provider.name}: ${processLabel}. ${error ? 'Activity could not be refreshed.' : provider.activity?.detail || 'Activity has not been observed yet.'} Click for details.`} className={`provider-heading process-light lamp-unit ${processColor}`} onClick={() => { setHelp(false); setSelectedId(current => current === provider.id ? null : provider.id); }} aria-expanded={selectedId === provider.id} aria-label={`${provider.name}: ${processLabel}`}>

              <span className="lamp-rim"><span className="lamp"><img className={`provider-logo ${provider.id}`} src={logos[provider.id]} alt="" /></span></span>

              <span className="provider-name">{provider.name}</span><span className={`process-label ${processColor}`}>{processLabel}</span>

            </button>

            <div className="usage-meters">

              <UsageMeter now={now} resetsAt={limits.five?.resetsAt} kind="five-hour" label="5h" value={limits.five?.usedPercent} detail={detail(limits.five, 'Five-hour')} stale={old} onSelect={() => { setHelp(false); setSelectedId(provider.id); }} />

              <UsageMeter now={now} resetsAt={limits.week?.resetsAt} kind="weekly" label="Week" value={limits.week?.usedPercent} detail={detail(limits.week, 'Weekly')} stale={old} onSelect={() => { setHelp(false); setSelectedId(provider.id); }} />

            </div>

          </div><TaskContexts provider={provider} expanded={Boolean(expandedTasks[provider.id])} onToggle={() => setExpandedTasks(current => ({ ...current, [provider.id]: !current[provider.id] }))} /></article>;

        })}

        {!providers.length && <div className="empty-state"><span className="empty-lights"><i /><i /><i /></span><strong>{busy ? 'Checking your assistants…' : 'No signed-in assistants'}</strong><p>Sign in through a supported AI CLI locally, then refresh.</p><button disabled={busy} onClick={refresh}><RefreshCw size={12} />Check again</button></div>}

      </section>

      {selected && <section className="details" aria-label={`${selected.name} usage details`}><div className="detail-heading"><strong>{selected.name}</strong><span>usage details</span><button title="Close details" onClick={() => setSelectedId(null)}><X size={13} /></button></div><p className="usage-message">{selected.usage?.message || (selected.usage?.state === 'available' ? 'Observed usage from your local assistant.' : 'Some usage information is unavailable.')}</p>{selected.usage?.stale && <p className="stale-message">Older observation — usage may have changed.</p>}<dl>{(['five', 'week'] as const).map(key => { const limit = usageLimits(selected)[key]; return <div key={key}><dt>{key === 'five' ? '5-hour window' : 'Weekly window'}</dt><dd>{limit && validPercent(limit.usedPercent) ? <><strong>{percent(limit.usedPercent)}% used</strong><span>{resetStatus(limit.resetsAt, now).relative}{resetStatus(limit.resetsAt, now).exact && <><br />{resetStatus(limit.resetsAt, now).exact}</>}</span></> : 'Unavailable'}</dd></div>; })}</dl><dl><div><dt>Usage observed</dt><dd>{timestamp(selected.usage?.updatedAt)}</dd></div><div><dt>Source</dt><dd>{selected.usage?.source || 'No usage source'}</dd></div></dl><p className="detail-note">Per-session context appears under this assistant. Task state and account usage are separate readings.</p></section>}

      {help && <section className="help-panel"><div className="detail-heading"><strong>Signals & connections</strong><button title="Close signal guide" onClick={() => setHelp(false)}><X size={13} /></button></div><ClaudeConnection />{capabilities.message && <p className="platform-note">{capabilities.message}</p>}<div className="legend"><span><i className="green-dot" />Free</span><span><i className="red-dot" />Occupied</span><span><i className="amber-dot" />Waiting for you</span><span><i />Not observed</span></div><p>The light around each AI logo shows activity: green when free, red while working, yellow when waiting for input or approval. Gray means activity is not known yet. An open process alone does not prove it is working.</p><p>The 5h and Week rings show account usage percentage <strong>used</strong>. Usage is green below 50%, yellow from 50%, orange from 75%, and red from 90%. It never changes the activity light. Task context lists locally observed sessions, including agent sessions when available. Session counts reflect observed context records. Process counts show detected operating-system processes; one process does not correspond to one task. Each context reading belongs to its session; capacity is shown only when observed. Scroll within an assistant to see more sessions. An asterisk marks an older account reading. Select a ring for reset countdowns, exact times, and sources. Use the chevron beside each assistant for task context.</p><p>Only locally signed-in assistants appear. Local credentials are never displayed. Provider logos belong to their respective owners.</p></section>}

      {notice && <div className="notice" role="status">{notice}</div>}

    </div>

    <footer><button className="info-button" title="How to read the signals" aria-expanded={help} onClick={() => { setSelectedId(null); setHelp(!help); }}><Info size={12} /><span>Usage signals</span></button><div className="sync"><time title={`Device scan: ${timestamp(snapshot?.checkedAt)}. Usage observation times can differ.`}>{busy ? 'Checking…' : lastChecked}</time><button title="Refresh usage" disabled={busy} onClick={refresh}><RefreshCw size={12} className={busy ? 'spin' : ''} /></button></div></footer>

  </main>;

}

createRoot(document.getElementById('root')!).render(<App />);
