export type TransformFormat = 'xml' | 'json';

export interface TransformChunk {
  order: number;
  /** 1-indexed page number within the already-split chapter file this chunk came from. */
  page: number;
  /** Only set on the first chunk (chapter_title, if known) — every other chunk is null. */
  heading: string | null;
  text: string;
}

export interface TransformDocument {
  /** This chapter file's own fileId — the transformation's input. */
  source_file_id: number;
  /** Carried from the chapter file's meta_data — the original whole-book file, for traceability. */
  parent_file_id: number | null;
  split_index: number | null;
  chapter_title: string | null;
  page_count: number;
  chunks: TransformChunk[];
}

export interface TransformMeta {
  sourceFileId: number;
  parentFileId: number | null;
  splitIndex: number | null;
  chapterTitle: string | null;
}

/**
 * One chunk per page (see FLUID_APP_DEV_CONTEXT.md's absence of a spec here,
 * and the plan's own note): pdf-parse's pagerender hook (extractPerPageText)
 * only gives line-level text with no blank-line/paragraph signal, so
 * paragraph-level chunking isn't reliably derivable without a new heuristic.
 * Page-level is the same granularity this codebase already trusts elsewhere
 * (chapter-boundary detection assumes a chapter starts at the top of
 * whichever page its heading lands on, for the same reason).
 */
export function buildTransformDocument(pages: string[], meta: TransformMeta): TransformDocument {
  return {
    source_file_id: meta.sourceFileId,
    parent_file_id: meta.parentFileId,
    split_index: meta.splitIndex,
    chapter_title: meta.chapterTitle,
    page_count: pages.length,
    chunks: pages.map((text, i) => ({
      order: i,
      page: i + 1,
      heading: i === 0 ? meta.chapterTitle : null,
      text,
    })),
  };
}

export function toJson(doc: TransformDocument): string {
  return JSON.stringify(doc, null, 2);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlField(name: string, value: string | number | null, indent: string): string {
  return `${indent}<${name}>${value === null ? '' : escapeXml(String(value))}</${name}>`;
}

export function toXml(doc: TransformDocument): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<document>'];
  lines.push(xmlField('source_file_id', doc.source_file_id, '  '));
  lines.push(xmlField('parent_file_id', doc.parent_file_id, '  '));
  lines.push(xmlField('split_index', doc.split_index, '  '));
  lines.push(xmlField('chapter_title', doc.chapter_title, '  '));
  lines.push(xmlField('page_count', doc.page_count, '  '));
  lines.push('  <chunks>');
  for (const chunk of doc.chunks) {
    lines.push(`    <chunk order="${chunk.order}" page="${chunk.page}">`);
    lines.push(xmlField('heading', chunk.heading, '      '));
    lines.push(xmlField('text', chunk.text, '      '));
    lines.push('    </chunk>');
  }
  lines.push('  </chunks>');
  lines.push('</document>');
  return lines.join('\n');
}

export function serializeTransformDocument(doc: TransformDocument, format: TransformFormat): string {
  return format === 'xml' ? toXml(doc) : toJson(doc);
}
