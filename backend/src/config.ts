function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4100),

  // uw-be service credential (§4). Never sent to the browser.
  uwbe: {
    baseUrl: required('UWBE_BASE_URL'), // e.g. https://orion.internal/api
    apiToken: required('UWBE_API_TOKEN'), // "id|plaintext-token" — sent verbatim as `api-token` header
  },

  // Browser -> Fluid App Backend CORS allowlist. Needed because in Parcel mode the
  // browser still calls this backend directly (only Orion<->transapp-frontend
  // is same-realm; transapp-frontend<->transapp-backend is a normal fetch).
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:9100').split(',').map((s) => s.trim()),

  // §6.1 blocker #1 — reject vs. flag-and-continue for non-text-extractable PDFs is
  // NOT decided (owner: Bhanu). Default to the non-destructive option until confirmed.
  acquisitionGateMode: (process.env.ACQUISITION_GATE_MODE ?? 'flag') as 'flag' | 'reject',
  // Heuristic, not a spec: the doc says "text-extractable (not scanned/image-only)"
  // without a precise threshold. Below this average chars/page, treat as scanned.
  acquisitionMinAvgCharsPerPage: Number(process.env.ACQUISITION_MIN_AVG_CHARS_PER_PAGE ?? 20),

  batchSplit: {
    minChunks: Number(process.env.BATCH_SPLIT_MIN_CHUNKS ?? 2),
    maxChunks: Number(process.env.BATCH_SPLIT_MAX_CHUNKS ?? 5),
    targetPagesPerChunk: Number(process.env.BATCH_SPLIT_TARGET_PAGES_PER_CHUNK ?? 20),
    // §6.3.1 — task graph field used to identify the clean vs. manual-fix task. The
    // real get-all-tasks response shape hasn't been confirmed; this assumes a
    // `task_code` field on each task node. Adjust in uwbe-client/endpoints.ts
    // (resolveSplitTargetTasks) once confirmed.
    downloadReadyTaskCode: process.env.BATCH_SPLIT_DOWNLOAD_TASK_CODE ?? 'DOWNLOAD',
    manualFixTaskCode: process.env.BATCH_SPLIT_MANUAL_FIX_TASK_CODE ?? 'MANUAL_FIX',
    // by-chapter split method routes every child to the Transformation task
    // (below) instead of download-ready/manual-fix — there's no
    // pages_with_errors data yet at split time in that flow (qualification
    // runs per-chapter AFTER transformation, not on the whole doc before
    // splitting), so each chapter gets transformed then reviewed on its own
    // qualification task. qualificationTaskCode itself is still used — by
    // Transformation's own completion, to resolve where each transformed
    // chapter routes next (routes/transformation.ts).
    qualificationTaskCode: process.env.BATCH_SPLIT_QUALIFICATION_TASK_CODE ?? 'QUALIFICATION',
    // Where by-chapter routes each split chapter (PDF text -> XML/JSON runs
    // here before qualification reviews the structured output).
    transformTaskCode: process.env.BATCH_SPLIT_TRANSFORM_TASK_CODE ?? 'TRANSFORMATION',
    // Heading style is book-specific and there's no way to know it up front, so
    // this is tunable per project via env rather than hardcoded. Tested against
    // outline/bookmark titles first, or the first non-blank line of each page
    // if a PDF has no outline (see pdf/split.ts's splitByChapter). Default
    // catches "CHAPTER 1"/"Chapter One"/"Part IV" AND bare-roman-numeral
    // POV-chapter titles like "I Jason"/"Ii Piper" (common in multi-POV YA
    // series — verified against a real Heroes of Olympus complete-series PDF,
    // whose chapters are titled exactly that way, not "Chapter N").
    chapterHeadingPattern: new RegExp(
      process.env.BATCH_SPLIT_CHAPTER_HEADING_PATTERN ??
        '^(chapter|part)\\s+([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\\b|^[ivxlcdm]+[.:]?\\s+\\S+',
      'i',
    ),
  },
};
