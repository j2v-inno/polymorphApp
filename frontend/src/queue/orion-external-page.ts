/**
 * What this app uses of Orion's External page, declared from Orion's contract
 * (version 1, "The External page: what an outside app passes in and hears
 * back"). Orion does not publish these types yet, so they are written here
 * and nothing is imported from Orion.
 */
export type OrionTheme = 'dark' | 'light';

export interface OrionExternalPageProps {
  theme?: OrionTheme;
  /** This app's Web App code in Orion. Process is live only on tasks that use it. */
  webApp?: string;
}

// ---------------------------------------------------------------- the bus

/** Who Orion recognises in this browser. Said by Orion. */
export type OrionOperatorChanged =
  | { status: 'signed-in'; email: string; name: string }
  | { status: 'signed-out' }
  | { status: 'unreachable' };

/** A remark left at an earlier task. */
export interface OrionRemark {
  remarks: string;
  task_code: string;
  task_name: string;
  task_updated_at: string;
  user_id: string;
  user_name: string;
}

/** Orion has started this file as the operator. Said by Orion. */
export interface OrionFileStarted {
  file_id: string;
  project_id: string;
  task_id: string;
  user_id: string;
  workflow_id: string;
  app_screen: string | null;
  file_name: string;
  project_code: string;
  /** `null` when Orion could not read them. */
  remarks: OrionRemark[] | null;
  /** `true` when said again for a file already started. */
  repeat: boolean;
  task_name: string;
  task_uid: string;
  workflow_code: string;
  /** Resolves to the app token for this app's server; rejects when Orion issues none. */
  getAppToken: () => Promise<string>;
}

/** A file that was open is no longer open for the operator. Said by Orion. */
export interface OrionFileClosed {
  file_id: string;
}

/** This app's server has finished or held the file through Orion's API. */
export interface OrionFileFinished {
  file_id: string;
}

/** This app cannot work the file; Orion shows `message` as this app's own. */
export interface OrionFileFailed {
  file_id: string;
  message: string;
}

/** Every event on the bus, by name. */
export interface OrionEvents {
  'file-closed': OrionFileClosed;
  'file-failed': OrionFileFailed;
  'file-finished': OrionFileFinished;
  'file-started': OrionFileStarted;
  'operator-changed': OrionOperatorChanged;
}

export type OrionEventName = keyof OrionEvents;

export type OrionListener<N extends OrionEventName> = (payload: OrionEvents[N]) => void;

export interface OrionBus {
  /** Listens. Returns a function that stops listening. */
  on: <N extends OrionEventName>(name: N, listener: OrionListener<N>) => () => void;
  off: <N extends OrionEventName>(name: N, listener: OrionListener<N>) => void;
  emit: <N extends OrionEventName>(name: N, payload: OrionEvents[N]) => void;
}

// ---------------------------------------------------------------- entry.js

export interface OrionExternalPage {
  /** A prop left out keeps its value. */
  update: (props: OrionExternalPageProps) => void;
  unmount: () => void;
  /** The same object as the module's `bus`. */
  bus: OrionBus;
}

export interface OrionEntry {
  /** One bus per document: listen on it before mounting, as an event said before is lost. */
  bus: OrionBus;
  /** `'1'`. Within a version Orion only adds; ignore what is not known here. */
  CONTRACT_VERSION: string;
  mountOrion: (element: HTMLElement, props?: OrionExternalPageProps) => OrionExternalPage;
}
