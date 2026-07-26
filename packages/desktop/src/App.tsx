import { useEffect, useState } from 'react';
import { Onboarding } from './pages/Onboarding';
import { Dashboard } from './pages/Dashboard';
import { Devices } from './pages/Devices';
import { Diagnostics } from './pages/Diagnostics';
import { Logs } from './pages/Logs';
import { Auth } from './pages/Auth';
import type { WorkstationRead } from './types';
import { Sidebar, type Tab } from './components/Sidebar';

/**
 * Top-level shell. Two macro states:
 *   1. `workstation.json` absent → force the Onboarding wizard.
 *   2. Present → render the tabbed operator console.
 *
 * Every tab reads the enrolled workstation identity from the same in-memory
 * `ws` state so we don't hammer the IPC boundary on every render.
 */
export function App() {
  const [ws, setWs] = useState<WorkstationRead | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');

  const refresh = () => window.edge.workstation.read().then(setWs);
  useEffect(() => { refresh(); }, []);

  if (!ws) return <SplashScreen message="Loading workstation profile…" />;
  if (!ws.exists) return <Onboarding onEnrolled={refresh} />;

  return (
    <div className="app-shell">
      <Sidebar current={tab} onSelect={setTab} workstation={ws} />
      <main className="app-main">
        {tab === 'dashboard' && <Dashboard workstation={ws} />}
        {tab === 'devices' && <Devices workstation={ws} />}
        {tab === 'diagnostics' && <Diagnostics workstation={ws} />}
        {tab === 'logs' && <Logs />}
        {tab === 'auth' && <Auth workstation={ws} onChanged={refresh} />}
      </main>
    </div>
  );
}

function SplashScreen({ message }: { message: string }) {
  return (
    <div className="splash">
      <div className="brand">AccrualFlow <span>Edge</span></div>
      <p>{message}</p>
    </div>
  );
}
