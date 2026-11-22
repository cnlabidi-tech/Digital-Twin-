/**
 * Dashboard layout + authentication gate.
 * In secure mode the user must log in; panels adapt to the role
 * (viewer: read-only, operator: commands/acks, admin: policy/overrides/audit).
 */
import { useEffect } from 'react';
import { AlertsPanel } from './components/AlertsPanel';
import { ControlPanel } from './components/ControlPanel';
import { EventHistory } from './components/EventHistory';
import { Header } from './components/Header';
import { LiveCharts } from './components/LiveCharts';
import { Login } from './components/Login';
import { PipelineSchematic } from './components/PipelineSchematic';
import { SecurityPanel } from './components/SecurityPanel';
import { SimPanel } from './components/SimPanel';
import { TwinPanel } from './components/TwinPanel';
import { getJson } from './lib/api';
import { atLeast, logout, useMe } from './lib/auth';
import { bootstrap, connect } from './lib/store';

let started = false;

export function App() {
  const { me, needLogin, refresh } = useMe();

  useEffect(() => {
    if (me && !started) {
      started = true;
      connect();
      void bootstrap(getJson);
    }
  }, [me]);

  if (needLogin) return <Login onDone={refresh} />;
  if (!me) return <div className="login-wrap"><div className="empty">Connecting…</div></div>;

  const operator = atLeast(me, 'operator');
  const admin = atLeast(me, 'admin');
  return (
    <div className="app">
      <Header
        right={me.loginRequired ? (
          <span className="pill user">
            {me.username} · {me.role} <button className="linklike" onClick={logout}>logout</button>
          </span>
        ) : <span className="pill warn">dev mode · no login</span>}
      />
      <main className="grid">
        <section className="col-main">
          <PipelineSchematic />
          <TwinPanel canRelearn={admin} />
          <LiveCharts />
          <EventHistory />
        </section>
        <aside className="col-side">
          <AlertsPanel canAck={operator} />
          <ControlPanel canControl={operator} canPolicy={admin} />
          <SecurityPanel isAdmin={admin} />
          <SimPanel />
        </aside>
      </main>
    </div>
  );
}
