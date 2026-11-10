import { useEffect, useRef, useState } from 'react';
import { AppShell } from '../components/AppShell';
import { ORION_ENTRY_URL } from '../config';
import type { OrionEntry, OrionExternalPage, OrionOperator, OrionTheme } from './orion-external-page';

// This app's code on Orion's Web Apps screen. Process is live only on tasks
// whose Web App has it.
const WEB_APP_CODE = 'transapp';

type Operator = { status: 'checking' } | { status: 'signed-in'; operator: OrionOperator } | { status: 'signed-out' };

function initialTheme(): OrionTheme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * The operator's queue: Orion's External page, drawn by Orion into a box in
 * this app's own tab. Orion recognises her by her own Orion sign-in in this
 * browser; nothing about her is passed in.
 *
 * Pressing Process does nothing here yet: Orion has not built Process or the
 * event bus that would say which file she started.
 */
export function QueueScreen() {
  const box = useRef<HTMLDivElement>(null);
  const page = useRef<OrionExternalPage | null>(null);
  const [theme, setTheme] = useState<OrionTheme>(initialTheme);
  const [operator, setOperator] = useState<Operator>({ status: 'checking' });
  const [loadError, setLoadError] = useState<string | null>(null);

  // This app's own dark is `dark` on <html> (styles.css). In its own tab the
  // queue sets it; Orion is told separately, through `theme`.
  useEffect(() => {
    const root = document.documentElement;
    const had = root.classList.contains('dark');
    root.classList.toggle('dark', theme === 'dark');
    return () => {
      root.classList.toggle('dark', had);
    };
  }, [theme]);

  useEffect(() => {
    let cancelled = false;

    import(/* webpackIgnore: true */ ORION_ENTRY_URL)
      .then((orion: OrionEntry) => {
        if (cancelled || !box.current) return;
        page.current = orion.mountOrion(box.current, {
          theme,
          webApp: WEB_APP_CODE,
          // Stand-in: when Orion's event bus is built, this becomes a listener
          // on `operator-changed`, added before mountOrion is called.
          onOperatorChange: (signedIn) => {
            if (cancelled) return;
            setOperator(signedIn ? { status: 'signed-in', operator: signedIn } : { status: 'signed-out' });
          },
        });
      })
      .catch((err: unknown) => {
        console.error('[transapp] could not load Orion:', err);
        if (!cancelled) setLoadError(`Orion's queue could not be loaded from ${ORION_ENTRY_URL}.`);
      });

    // Leaving the queue takes Orion's page with it.
    return () => {
      cancelled = true;
      page.current?.unmount();
      page.current = null;
    };
    // Mounted once; a theme change goes through update() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    page.current?.update({ theme });
  }, [theme]);

  const signedInLine =
    operator.status === 'signed-in'
      ? `Signed in to Orion as ${operator.operator.name}`
      : operator.status === 'signed-out'
        ? 'Not signed in to Orion'
        : loadError
          ? undefined
          : 'Checking your Orion sign-in…';

  return (
    <AppShell
      fill
      aside={
        <div className="fluid-queue__aside">
          {signedInLine && (
            <span className="fluid-queue__operator" title={operator.status === 'signed-in' ? operator.operator.email : undefined}>
              {signedInLine}
            </span>
          )}
          <button
            type="button"
            className="fluid-queue__theme"
            aria-pressed={theme === 'dark'}
            onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      }
    >
      {loadError ? (
        <div className="fluid-alert fluid-alert--error">{loadError}</div>
      ) : (
        <div ref={box} className="fluid-queue__box" />
      )}
    </AppShell>
  );
}
