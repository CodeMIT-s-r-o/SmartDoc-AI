import { useEffect, useState } from 'react';

interface HealthReport {
  status: 'ok' | 'error';
  db: 'up' | 'down';
  ai: 'up' | 'down';
  version: string;
}

type HealthState =
  | { kind: 'loading' }
  | { kind: 'loaded'; report: HealthReport }
  | { kind: 'failed'; message: string };

/** Placeholder shell: proves the web -> api -> db/ai path works end to end. */
export function App() {
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (res) =>
        setHealth({ kind: 'loaded', report: (await res.json()) as HealthReport }),
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setHealth({ kind: 'failed', message: String(error) });
        }
      });
    return () => controller.abort();
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '4rem auto' }}>
      <h1>SmartDoc AI</h1>
      <p>Production-grade RAG with measured cost controls.</p>
      <h2>System status</h2>
      {health.kind === 'loading' && <p>Checking…</p>}
      {health.kind === 'failed' && <p>API unreachable: {health.message}</p>}
      {health.kind === 'loaded' && (
        <ul>
          <li>API: {health.report.status}</li>
          <li>Database: {health.report.db}</li>
          <li>AI service: {health.report.ai}</li>
          <li>Version: {health.report.version}</li>
        </ul>
      )}
    </main>
  );
}
