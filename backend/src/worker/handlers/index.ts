import { qaCluster } from './qa.js';
import { textExtract } from './text-extract.js';
import { transmission } from './transmission.js';
import type { Handler } from './types.js';
import { xmlMarkup } from './xml-markup.js';

/** Task code → handler. A new automated step is one handler and one line here. */
export const handlers: Record<string, Handler> = {
  TEXT_EXTRACT: textExtract,
  XML_MARKUP: xmlMarkup,
  QA_CLUSTER: qaCluster,
  TRANSMISSION: transmission,
};
