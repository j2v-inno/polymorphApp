import type { ComponentType } from 'react';
import type { TaskContext } from './types';
import { AcquisitionScreen } from './modes/acquisition/AcquisitionScreen';
import { QualificationScreen } from './modes/qualification/QualificationScreen';
import { BatchSplitScreen } from './modes/batch-split/BatchSplitScreen';
import { TransformationScreen } from './modes/transformation/TransformationScreen';
import { DownloadScreen } from './modes/download/DownloadScreen';

export interface ModeScreenProps {
  taskContext: TaskContext;
}

interface ModeConfig {
  component: ComponentType<ModeScreenProps>;
  /** Documentation/introspection only (§9.2) — not enforced at runtime. */
  endpoints: string[];
}

/**
 * §9.2 — taskCode is the mode registry key in both mount paths. Adding a new
 * task type is a new entry here, not a rewrite of App.tsx or the single-spa
 * lifecycle. Do not add a mode for fully-automatic/headless task types — those
 * belong in a uw-be worker loop, not a browser screen.
 */
export const modeRegistry: Record<string, ModeConfig> = {
  ACQUISITION: { component: AcquisitionScreen, endpoints: ['register-job-batch-file', 'update-file-status'] },
  QUALIFICATION: {
    component: QualificationScreen,
    endpoints: ['get-task-ongoing-file', 'update-file-meta-data', 'update-file-status', 'flow-back-file-task'],
  },
  BATCH_SPLIT: { component: BatchSplitScreen, endpoints: ['update-file-status', 'register-file', 'get-all-tasks'] },
  TRANSFORMATION: {
    component: TransformationScreen,
    endpoints: ['update-file-status', 'register-file', 'get-all-tasks'],
  },
  DOWNLOAD: { component: DownloadScreen, endpoints: ['get-file-task-output'] },
};
