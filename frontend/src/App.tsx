import { useEffect, useState } from 'react';
import { revalidateTaskContext, startFromLaunchCode } from './api-client';
import { connectHost, disconnectHost, inOwnTab } from './host';
import { modeRegistry } from './mode-registry';
import { fromLaunch, launchCodeFromUrl, resolveTaskContextPointer } from './task-context';
import { AppShell } from './components/AppShell';
import type { CustomProps, TaskContext } from './types';
import './styles.css';

type LoadState =
  | { status: 'loading' }
  // A tab whose link no longer opens anything. Not an error: nothing broke.
  | { status: 'stale' }
  | { status: 'error'; message: string }
  | { status: 'ready'; taskContext: TaskContext };

export default function App(props: CustomProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    /**
     * Where the work comes from. Opened by Orion in a tab of its own, the
     * link carries only a launch code: this app's server exchanges it with
     * Orion and answers with the task, the file, the operator and the screen,
     * and with the session every later call is made under. Mounted or framed,
     * it is the props or the address, and the bearer comes from Orion's page.
     *
     * A tab's link can go stale: it has no code, the code ran out, or the
     * operator held or finished the file. The tab then says so and stops. It
     * loads nothing, does not ask again, and goes nowhere by itself; only a
     * new launch from Orion makes a code that works.
     */
    const start = async (): Promise<TaskContext | null> => {
      if (!inOwnTab(props)) {
        // Before the first request: api-client gets its app token through the host.
        connectHost(props);
        return resolveTaskContextPointer(props);
      }

      const ct = launchCodeFromUrl();
      if (!ct) {
        setState({ status: 'stale' });
        return null;
      }

      const launched = await startFromLaunchCode(ct);
      if (cancelled) return null;
      if (launched.stale) {
        setState({ status: 'stale' });
        return null;
      }
      if (!launched.ok || !launched.data) {
        setState({ status: 'error', message: launched.error ?? 'failed to open the task from its launch code' });
        return null;
      }
      connectHost(props, launched.data.session);
      return fromLaunch(launched.data.context);
    };

    start().then(async (pointer) => {
      if (!pointer) return;
      const result = await revalidateTaskContext(pointer);
      if (cancelled) return;
      if (!result.ok || !result.data) {
        setState({ status: 'error', message: result.error ?? 'failed to validate task context' });
        return;
      }
      // §3.3 — the backend's re-fetched data is authoritative; the pointer only
      // fills in fields get-task-ongoing-file doesn't echo back.
      setState({ status: 'ready', taskContext: { ...pointer, ...result.data } });
    });

    return () => {
      cancelled = true;
      // §10 unmount hygiene — the host may mount a different task/user context
      // into this same page shortly after. Disconnecting also drops the way
      // to an app token, so a late call cannot act as the previous operator.
      disconnectHost();
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
  if (state.status === 'stale') {
    return (
      <AppShell>
        <div className="fluid-alert fluid-alert--info">Open this task from Orion.</div>
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

  // task-context.ts already chose the screen: Orion's answer for a tab opened
  // with a launch code, this page's own address (?app_screen=, then the path)
  // for an iframe or a standalone launch, Orion's app_screen prop when mounted.
  // Reading the address here would read the host's page URL under a mount.
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
