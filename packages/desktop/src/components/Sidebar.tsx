import type { WorkstationRead } from '../types';
import { monogram, shortId } from '../lib/identity';

export type Tab = 'dashboard' | 'devices' | 'diagnostics' | 'logs' | 'auth';

interface Props { current: Tab; onSelect: (t: Tab) => void; workstation: WorkstationRead }

const TABS: { id: Tab; label: string; group: string }[] = [
  { id: 'dashboard',   label: 'Overview',    group: 'Operate' },
  { id: 'devices',     label: 'Devices',     group: 'Operate' },
  { id: 'diagnostics', label: 'Diagnostics', group: 'Support' },
  { id: 'logs',        label: 'Activity log', group: 'Support' },
  { id: 'auth',        label: 'Identity',    group: 'Support' },
];

export function Sidebar({ current, onSelect, workstation }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">AccrualFlow <span>Edge</span></div>
      <div className="sidebar-ws">
        <div className="sidebar-ws-avatar">{monogram(workstation.name)}</div>
        <div className="sidebar-ws-meta">
          <div className="sidebar-ws-name" title={workstation.name ?? undefined}>
            {workstation.name ?? 'Unnamed workstation'}
          </div>
          <div className="sidebar-ws-id">{shortId('workstation', workstation.workstation_id)}</div>
        </div>
      </div>
      {TABS.map((t, i) => (
        <div key={t.id}>
          {(i === 0 || TABS[i - 1].group !== t.group) && (
            <div className="sidebar-section">{t.group}</div>
          )}
          <button
            className="sidebar-tab"
            aria-current={current === t.id}
            onClick={() => onSelect(t.id)}
          >
            <span className="sidebar-tab-dot" />
            {t.label}
          </button>
        </div>
      ))}
      <div className="sidebar-spacer" />
      <div className="sidebar-foot">Workstation console</div>
    </aside>
  );
}
