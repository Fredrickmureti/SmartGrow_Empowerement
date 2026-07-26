import type { WorkstationRead } from '../types';

export type Tab = 'dashboard' | 'devices' | 'diagnostics' | 'logs' | 'auth';

interface Props { current: Tab; onSelect: (t: Tab) => void; workstation: WorkstationRead }

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard',   label: 'Dashboard' },
  { id: 'devices',     label: 'Devices' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'logs',        label: 'Logs' },
  { id: 'auth',        label: 'Auth' },
];

export function Sidebar({ current, onSelect, workstation }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">AccrualFlow <span>Edge</span></div>
      <div className="sidebar-ws">
        <div className="sidebar-ws-name">{workstation.name ?? 'Unnamed workstation'}</div>
        <div className="sidebar-ws-id">{workstation.workstation_id ?? '—'}</div>
      </div>
      {TABS.map((t) => (
        <button
          key={t.id}
          className="sidebar-tab"
          aria-current={current === t.id}
          onClick={() => onSelect(t.id)}
        >
          <span className="sidebar-tab-dot" />
          {t.label}
        </button>
      ))}
    </aside>
  );
}
