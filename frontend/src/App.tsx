import { useEffect, useState } from 'react';
import { clearApiToken, revalidateTaskContext, setApiToken } from './api-client';
import { modeRegistry } from './mode-registry';
import { resolveTaskContextPointer } from './task-context';
import { AppShell } from './components/AppShell';
import type { CustomProps, TaskContext } from './types';
import './styles.css';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; taskContext: TaskContext };

export default function App(props: CustomProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    const pointer = resolveTaskContextPointer(props);
    setApiToken(pointer.apiToken);

    let cancelled = false;
    revalidateTaskContext(pointer).then((result) => {
      if (cancelled) return;
      if (!result.ok || !result.data) {
        setState({ status: 'error', message: result.error ?? 'failed to validate task context' });
        return;
      }
      // §3.3 — the backend's re-fetched data is authoritative; the pointer only
      // fills in fields get-task-ongoing-file doesn't echo back (e.g. apiToken).
      setState({ status: 'ready', taskContext: { ...pointer, ...result.data } });
    });

    return () => {
      cancelled = true;
      // §10 unmount hygiene — the host may mount a different task/user context
      // into this same page shortly after.
      clearApiToken();
    };
    // Deliberately runs once per mount, not on every props identity change —
    // Orion remounts this Parcel (fresh bootstrap/mount) per task rather than
    // reusing one instance across tasks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.status === 'loading') {
    return (
      <AppShell>
        <div className="fluid-loading">
          <span className="fluid-spinner" />
          Loading task…
        </div>
      </AppShell>
    );
  }
  if (state.status === 'error') {
    return (
      <AppShell>
        <div className="fluid-alert fluid-alert--error">Error: {state.message}</div>
      </AppShell>
    );
  }

  // task-context.ts already chose the screen: this page's own address
  // (?app_screen=, then the path) for standalone launches, Orion's app_screen
  // prop when mounted. Reading the address here would read the host's page URL
  // under a mount.
  const modeKey = state.taskContext.taskCode ?? '';
  const mode = modeRegistry[modeKey];
  if (!mode) {
    return (
      <AppShell taskContext={state.taskContext}>
        <div className="fluid-alert fluid-alert--error">Unknown mode: "{modeKey}"</div>
      </AppShell>
    );
  }

  const ModeComponent = mode.component;
  return (
    <AppShell activeMode={modeKey} taskContext={state.taskContext}>
      <ModeComponent taskContext={state.taskContext} />
    </AppShell>
  );
}
