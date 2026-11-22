/** Dashboard layout. Later phases plug their panels into the marked slots. */
import { AlertsPanel } from './components/AlertsPanel';
import { ControlPanel } from './components/ControlPanel';
import { EventHistory } from './components/EventHistory';
import { Header } from './components/Header';
import { LiveCharts } from './components/LiveCharts';
import { PipelineSchematic } from './components/PipelineSchematic';
import { SimPanel } from './components/SimPanel';
import { TwinPanel } from './components/TwinPanel';

export function App() {
  return (
    <div className="app">
      <Header />
      <main className="grid">
        <section className="col-main">
          <PipelineSchematic />
          <TwinPanel />
          <LiveCharts />
          <EventHistory />
        </section>
        <aside className="col-side">
          <AlertsPanel />
          <ControlPanel />
          <SimPanel />
        </aside>
      </main>
    </div>
  );
}
