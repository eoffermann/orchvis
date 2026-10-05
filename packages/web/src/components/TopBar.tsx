import { useMemo } from 'react';
import type { ControlAction } from '@orchvis/protocol';
import { formatBytes } from '../graph/visual';
import type { ConnectionStatus, Filters } from '../store/types';
import { useAppState, useStoreInstance } from '../store/useStore';

/** Props for {@link TopBar}. */
export interface TopBarProps {
  /** Sends an Owner control frame. Returns the frame ID, or null when offline. */
  sendControl: (action: ControlAction) => string | null;
}

const CONNECTION_LABELS: Readonly<Record<ConnectionStatus, string>> = {
  idle: 'Not connected',
  connecting: 'Connecting',
  open: 'Connected',
  reconnecting: 'Reconnecting',
  unauthorized: 'Signed out',
};

/** A dropdown of checkboxes for one filter dimension. */
function FilterMenu(props: {
  label: string;
  options: readonly { value: string; label: string }[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const { label, options, selected, onChange } = props;
  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  return (
    <details className="filter">
      <summary className="filter-summary">
        {label}
        {selected.length > 0 ? ` (${selected.length})` : ''}
      </summary>
      <div className="filter-menu" role="group" aria-label={`Filter by ${label.toLowerCase()}`}>
        {options.length === 0 && <span className="filter-empty">None yet</span>}
        {options.map((o) => (
          <label key={o.value} className="filter-option" title={o.value}>
            <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
        {selected.length > 0 && (
          <button type="button" className="filter-clear" onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>
    </details>
  );
}

/**
 * The top bar: broker connection state, session count, media store usage
 * against its cap, repo and host filters, and the pause-all-peer-traffic
 * switch.
 */
export function TopBar({ sendControl }: TopBarProps) {
  const store = useStoreInstance();
  const connection = useAppState((s) => s.connection);
  const synced = useAppState((s) => s.synced);
  const nodes = useAppState((s) => s.data.nodes);
  const mediaStore = useAppState((s) => s.data.mediaStore);
  const pausedAll = useAppState((s) => s.data.control.pausedAll);
  const filters = useAppState((s) => s.view.filters);
  const rejection = useAppState((s) => s.data.lastRejection);

  const { total, connected, repoOptions, hostOptions } = useMemo(() => {
    const list = Object.values(nodes);
    const repos = new Map<string, string>();
    const hosts = new Set<string>();
    for (const n of list) {
      hosts.add(n.hostname);
      for (const r of n.repos) repos.set(r.key, r.name);
    }
    return {
      total: list.length,
      connected: list.filter((n) => n.connected).length,
      repoOptions: [...repos].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
      hostOptions: [...hosts].sort().map((h) => ({ value: h, label: h })),
    };
  }, [nodes]);

  const setFilters = (patch: Partial<Filters>) => store.dispatch({ type: 'filters', filters: { ...filters, ...patch } });
  const usage = mediaStore.capBytes > 0 ? Math.min(1, mediaStore.bytes / mediaStore.capBytes) : 0;
  const live = connection === 'open' && synced;
  const status = connection === 'open' && !synced ? 'Syncing' : CONNECTION_LABELS[connection];

  return (
    <header className="topbar">
      <span className="brand">orchvis</span>
      <span className={`conn conn--${live ? 'live' : connection}`} role="status">
        <span className="conn-dot" aria-hidden="true" />
        {status}
      </span>
      <span className="stat" title="Connected sessions / known sessions">
        {connected}/{total} sessions
      </span>
      <span className="stat media-usage" title={`${mediaStore.files} media files`}>
        <span>
          Media {formatBytes(mediaStore.bytes)} / {formatBytes(mediaStore.capBytes)}
        </span>
        <svg className="meter" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
          <rect className="meter-track" x="0" y="0" width="100" height="8" />
          <rect className={usage > 0.85 ? 'meter-fill meter-fill--high' : 'meter-fill'} x="0" y="0" width={100 * usage} height="8" />
        </svg>
      </span>
      <FilterMenu label="Repos" options={repoOptions} selected={filters.repos} onChange={(repos) => setFilters({ repos })} />
      <FilterMenu label="Hosts" options={hostOptions} selected={filters.hosts} onChange={(hosts) => setFilters({ hosts })} />
      <span className="spacer" />
      {rejection && (
        <span className="notice" role="alert">
          Rejected: {rejection.code}. {rejection.detail}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={pausedAll}
        className={pausedAll ? 'switch switch--on' : 'switch'}
        disabled={!live}
        onClick={() => sendControl({ action: pausedAll ? 'resume_all' : 'pause_all' })}
        title="Pause all peer-to-peer traffic. Owner messages still go through."
      >
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
        {pausedAll ? 'Peer traffic paused' : 'Pause peer traffic'}
      </button>
    </header>
  );
}
