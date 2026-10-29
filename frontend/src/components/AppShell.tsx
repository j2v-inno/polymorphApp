import type { ReactNode } from 'react';
import type { TaskContext } from '../types';

// Fixed visual order — doesn't perfectly track the by-chapter flow's real
// order (register -> batch -> transform -> qualify -> download), same
// accepted mismatch as Qualification/Batch split already have there.
const STEPS: { key: string; label: string }[] = [
  { key: 'ACQUISITION', label: 'Acquisition' },
  { key: 'QUALIFICATION', label: 'Qualification' },
  { key: 'BATCH_SPLIT', label: 'Batch split' },
  { key: 'TRANSFORMATION', label: 'Transformation' },
  { key: 'DOWNLOAD', label: 'Download' },
];

const SCREEN_LABELS: Record<string, string> = {
  ...Object.fromEntries(STEPS.map((step) => [step.key, step.label])),
  BULK_REGISTRATION: 'Bulk registration',
};

interface Props {
  children: ReactNode;
  /** taskCode of the active screen, if resolved yet — undefined while loading/erroring. */
  activeMode?: string;
  taskContext?: TaskContext;
  /** Mounted or framed by Orion: Orion's own header is above, so one thin line replaces the brand bar and stepper. */
  insideOrion?: boolean;
}

/** Persistent chrome (brand bar + pipeline stepper) around every mode screen and app-level state. */
export function AppShell({ children, activeMode, taskContext, insideOrion }: Props) {
  const activeIndex = STEPS.findIndex((step) => step.key === activeMode);

  if (insideOrion) {
    const screenLabel = activeMode ? SCREEN_LABELS[activeMode] : undefined;
    const fileLabel = taskContext?.fileId !== undefined ? `File ${taskContext.fileId}` : undefined;
    const line = [fileLabel, screenLabel].filter(Boolean).join(' · ');

    return (
      <div className="fluid-app fluid-app--in-orion">
        {line && <div className="fluid-context-line">{line}</div>}
        <main className="fluid-main">
          <div className="fluid-card">{children}</div>
        </main>
      </div>
    );
  }

  return (
    <div className="fluid-app">
      <header className="fluid-topbar">
        <div className="fluid-brand">
          <span className="fluid-brand__mark">T</span>
          <div>
            <div className="fluid-brand__name">Transapp</div>
            <div className="fluid-brand__tag">Fluid document pipeline</div>
          </div>
        </div>
        {taskContext && (
          <div className="fluid-context">
            <strong>{taskContext.projectCode}</strong>
            {taskContext.workflowCode ? ` · ${taskContext.workflowCode}` : ''}
            {taskContext.jobName ? ` · Job ${taskContext.jobName}` : ''}
          </div>
        )}
      </header>

      {activeIndex >= 0 && (
        <nav className="fluid-stepper" aria-label="Pipeline progress">
          {STEPS.map((step, index) => (
            <div key={step.key} style={{ display: 'flex', alignItems: 'center' }}>
              {index > 0 && (
                <div
                  className={`fluid-step__connector${index <= activeIndex ? ' fluid-step-connector--done' : ''}`}
                />
              )}
              <div
                className={`fluid-step${
                  index < activeIndex ? ' fluid-step--done' : index === activeIndex ? ' fluid-step--active' : ''
                }`}
              >
                <span className="fluid-step__circle">{index < activeIndex ? '✓' : index + 1}</span>
                <span className="fluid-step__label">{step.label}</span>
              </div>
            </div>
          ))}
        </nav>
      )}

      <main className="fluid-main">
        <div className="fluid-card">{children}</div>
      </main>
    </div>
  );
}
