import { useEffect, useState } from 'react';
import { clearApiToken, revalidateTaskContext, setApiToken } from './api-client';
import { modeRegistry } from './mode-registry';
import { resolveModeFromPath } from './mode-path';
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

  // Standalone launches (new-tab, localhost:9100/<mode-path>?...) carry the mode
  // in the URL path itself, set once per task in uw-be's external_app_integration
  // config — immune to task renames and to any resolution hiccup upstream of
  // taskCode. Parcel/single-spa mounts have no meaningful standalone path, so
  // those fall back to the resolved taskCode as before.
  const modeKey = resolveModeFromPath() ?? state.taskContext.taskCode ?? '';
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
