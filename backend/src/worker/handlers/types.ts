import type { FileTaskMessage } from '../payload.js';
import type { TaskInput } from '../uwbe.js';

export interface HandlerContext {
  msg: FileTaskMessage;
  taskCode: string;
  input: TaskInput;
}

export interface HandlerResult {
  /** Becomes the task's output, which the next task reads as its input. */
  output: { bytes: Buffer; fileName: string; contentType: string };
  /** Merged into the file's metadata on completion. */
  metaData?: Record<string, unknown>;
}

/**
 * `process`: the worker claims the file, runs the handler on its input and completes it with the result.
 * `trigger`: the worker only asks Orion to act (the file must stay where it is) and acknowledges the message.
 */
export type Handler =
  | {
      kind: 'process';
      /** Read this earlier task's output instead of the file's own input. For a task after QA, whose input points at the QA task's output, which never exists. */
      inputFrom?: string;
      run(ctx: HandlerContext): Promise<HandlerResult>;
      /** Runs after the file is completed, e.g. to cut sampling batches straight away. */
      afterComplete?(msg: FileTaskMessage): Promise<void>;
    }
  | {
      kind: 'trigger';
      /** May return what it did, shown on the monitor page. */
      run(msg: FileTaskMessage): Promise<Record<string, unknown> | void>;
    };

/** The file name with a new extension, e.g. ruling.pdf → ruling.json. */
export function withExtension(fileName: string, ext: string): string {
  const dot = fileName.lastIndexOf('.');
  return `${dot > 0 ? fileName.slice(0, dot) : fileName}.${ext}`;
}
