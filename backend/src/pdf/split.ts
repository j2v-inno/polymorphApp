import { createRequire } from 'module';
import pdfParse from 'pdf-parse';
import { PDFDocument } from 'pdf-lib';
import { config } from '../config.js';

const require = createRequire(import.meta.url);

export type SplitMethod = 'equal-pages' | 'by-chapter';
export type ChapterDetectionMethod = 'outline' | 'text-scan' | 'equal-pages';

export interface PdfChunk {
  index: number;
  /** 1-indexed page numbers from the source document, for pages_with_errors intersection (§6.3.1). */
  pageNumbers: number[];
  bytes: Buffer;
  /** Chapter heading text, when the chunk came from by-chapter detection. */
  label?: string;
}

export interface SplitResult {
  chunks: PdfChunk[];
  method: SplitMethod;
  /** True when by-chapter was requested but no chapters were found any way, so this fell back to equal-pages. */
  usedFallback: boolean;
  /** Only meaningful when method is 'by-chapter'. */
  detectionMethod?: ChapterDetectionMethod;
}

interface ChapterBoundary {
  page: number;
  label: string;
}

function computeChunkCount(totalPages: number): number {
  const { minChunks, maxChunks, targetPagesPerChunk } = config.batchSplit;
  const estimated = Math.round(totalPages / targetPagesPerChunk) || minChunks;
  const desired = Math.min(maxChunks, Math.max(minChunks, estimated));
  // Can't split a document into more chunks than it has pages.
  return Math.max(1, Math.min(desired, totalPages));
}

function computePageRanges(totalPages: number, chunkCount: number): number[][] {
  const basePages = Math.floor(totalPages / chunkCount);
  const remainder = totalPages % chunkCount;
  const ranges: number[][] = [];
  let page = 1;
  for (let i = 0; i < chunkCount; i++) {
    const pagesInChunk = basePages + (i < remainder ? 1 : 0);
    ranges.push(Array.from({ length: pagesInChunk }, (_, idx) => page + idx));
    page += pagesInChunk;
  }
  return ranges;
}

async function copyChunk(sourceDoc: PDFDocument, pageNumbers: number[], index: number, label?: string): Promise<PdfChunk> {
  const chunkDoc = await PDFDocument.create();
  const copiedPages = await chunkDoc.copyPages(
    sourceDoc,
    pageNumbers.map((pageNumber) => pageNumber - 1),
  );
  copiedPages.forEach((page) => chunkDoc.addPage(page));
  const bytes = await chunkDoc.save();
  return { index, pageNumbers, bytes: Buffer.from(bytes), label };
}

/** Splits a PDF into 2-5 roughly-equal-page-count files (§1, §6.3) — the original/default method. */
async function splitByEqualPages(sourceDoc: PDFDocument): Promise<PdfChunk[]> {
  const totalPages = sourceDoc.getPageCount();
  const chunkCount = computeChunkCount(totalPages);
  const pageRanges = computePageRanges(totalPages, chunkCount);
  return Promise.all(pageRanges.map((pageNumbers, i) => copyChunk(sourceDoc, pageNumbers, i)));
}

/**
 * Per-page text via pdf-parse's `pagerender` hook, which pdf-parse calls once
 * per page during its normal walk — capturing into `pages` here gives an
 * authoritative page-indexed array instead of guessing at page boundaries by
 * splitting pdf-parse's own concatenated `result.text` output.
 */
async function extractPerPageText(pdfBytes: Buffer): Promise<string[]> {
  const pages: string[] = [];
  await pdfParse(pdfBytes, {
    pagerender: async (pageData: { getTextContent: (opts: unknown) => Promise<{ items: { str: string; transform: number[] }[] }> }) => {
      const textContent = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      let lastY: number | undefined;
      let text = '';
      for (const item of textContent.items) {
        if (lastY === item.transform[5] || lastY === undefined) {
          text += item.str;
        } else {
          text += '\n' + item.str;
        }
        lastY = item.transform[5];
      }
      pages.push(text);
      return text;
    },
  });
  return pages;
}

/**
 * Finds the first non-blank line of a page's text and tests it against
 * config.batchSplit.chapterHeadingPattern (tunable per book — chapter heading
 * style varies a lot; e.g. "CHAPTER 1", "Chapter One", roman numerals). Page-level
 * granularity only: a chapter is assumed to start at the top of whichever page
 * its heading lands on, since a PDF can only be split on page boundaries anyway.
 *
 * Only reliable when the chapter heading is itself extractable text on that
 * page — many professionally-typeset PDFs render chapter-opener titles as a
 * graphic instead, in which case this finds nothing and the caller falls back
 * further. See detectChapterBoundariesFromOutline for the more reliable path.
 */
function detectChapterHeading(pageText: string): string | undefined {
  const firstLine = pageText.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  if (!firstLine) return undefined;
  return config.batchSplit.chapterHeadingPattern.test(firstLine) ? firstLine : undefined;
}

interface LegacyOutlineItem {
  title: string;
  dest: unknown;
  items: LegacyOutlineItem[];
}
interface LegacyPdfDocumentProxy {
  getOutline(): Promise<LegacyOutlineItem[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
  destroy(): void;
}
interface LegacyPdfjsModule {
  disableWorker: boolean;
  getDocument(data: Buffer | Uint8Array): Promise<LegacyPdfDocumentProxy>;
}

/**
 * pdf-parse's own wrapper only exposes extracted text, not outline/bookmark
 * access — this reaches into its vendored pdf.js build directly for that.
 * Same pinned build (v1.10.100) already relied on indirectly via
 * extractPerPageText/text-extractable.ts, proven not to hit the
 * worker-simulation crash pdf-parse v2/pdfjs-dist v5 has in this Node
 * environment (see text-extractable.ts's comment) — deliberately NOT adding
 * pdfjs-dist as a fresh dependency to get this, to avoid re-risking that crash
 * with an unvetted version. Wrapped in try/catch since this is an internal,
 * undocumented path that could move on a pdf-parse version bump — if it does,
 * outline detection just becomes unavailable and callers fall back gracefully.
 */
function loadLegacyPdfjs(): LegacyPdfjsModule | null {
  try {
    return require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js') as LegacyPdfjsModule;
  } catch {
    return null;
  }
}

async function resolvePageIndex(doc: LegacyPdfDocumentProxy, dest: unknown): Promise<number | null> {
  if (!Array.isArray(dest) || dest.length === 0) return null;
  try {
    return await doc.getPageIndex(dest[0]);
  } catch {
    return null;
  }
}

/**
 * Reads the PDF's embedded outline/bookmark tree (the navigation panel most
 * PDF viewers show — distinct from any in-content "Table of Contents" page,
 * which is just regular text/graphics) and filters entries by title against
 * the same chapterHeadingPattern used for text-scan. Far more reliable than
 * text-scan for books whose chapter-opener titles are rendered as a graphic
 * (so no extractable heading text exists on the page itself) but whose
 * outline still carries the real title as plain text with a resolvable page
 * destination. Returns null (not an empty array) when the PDF has no outline
 * at all, or none of its entries match the pattern, so the caller can tell
 * "nothing to use here" apart from "found zero chapters" and fall back.
 */
async function detectChapterBoundariesFromOutline(pdfBytes: Buffer): Promise<ChapterBoundary[] | null> {
  const PDFJS = loadLegacyPdfjs();
  if (!PDFJS) return null;

  PDFJS.disableWorker = true;
  // getDocument()'s return value is this pdf.js build's own pre-ES2015 promise
  // shim, not a native Promise — it doesn't implement .catch(), only
  // .then(onFulfilled, onRejected), so a plain try/await is used instead of
  // chaining .catch() (which throws "not a function" if you do).
  let doc: LegacyPdfDocumentProxy;
  try {
    doc = await PDFJS.getDocument(pdfBytes);
  } catch {
    return null;
  }
  try {
    const outline = await doc.getOutline().catch(() => null);
    if (!outline || outline.length === 0) return null;

    const boundaries: ChapterBoundary[] = [];
    async function walk(items: LegacyOutlineItem[]): Promise<void> {
      for (const item of items) {
        const title = item.title?.trim();
        if (title && config.batchSplit.chapterHeadingPattern.test(title)) {
          const pageIndex = await resolvePageIndex(doc, item.dest);
          if (pageIndex !== null) boundaries.push({ page: pageIndex + 1, label: title });
        }
        await walk(item.items ?? []);
      }
    }
    await walk(outline);

    if (boundaries.length === 0) return null;

    boundaries.sort((a, b) => a.page - b.page);
    return boundaries.filter((b, i) => i === 0 || b.page !== boundaries[i - 1].page);
  } finally {
    doc.destroy();
  }
}

function boundariesToChunks(boundaries: ChapterBoundary[], totalPages: number): ChapterBoundary[] {
  // Pages before the first detected heading (title page, table of contents, etc.)
  // become their own leading chunk rather than being dropped.
  if (boundaries[0].page > 1) {
    return [{ page: 1, label: 'Front matter' }, ...boundaries];
  }
  return boundaries;
}

/**
 * Detects chapter-start pages, preferring the PDF's own outline/bookmarks
 * (most reliable — see detectChapterBoundariesFromOutline) and falling back
 * to scanning each page's first line for a heading pattern when a PDF has no
 * outline at all. Falls back further to equal-pages if neither finds
 * anything, so a mismatched pattern or outline-less PDF degrades gracefully
 * instead of erroring out.
 */
async function splitByChapter(
  sourceDoc: PDFDocument,
  pdfBytes: Buffer,
): Promise<{ chunks: PdfChunk[]; usedFallback: boolean; detectionMethod: ChapterDetectionMethod }> {
  const totalPages = sourceDoc.getPageCount();

  let boundaries = await detectChapterBoundariesFromOutline(pdfBytes);
  let detectionMethod: ChapterDetectionMethod = 'outline';

  if (!boundaries) {
    detectionMethod = 'text-scan';
    const pages = await extractPerPageText(pdfBytes);
    const textBoundaries: ChapterBoundary[] = [];
    for (let i = 0; i < pages.length; i++) {
      const label = detectChapterHeading(pages[i]);
      if (label) textBoundaries.push({ page: i + 1, label });
    }
    boundaries = textBoundaries.length > 0 ? textBoundaries : null;
  }

  if (!boundaries) {
    return { chunks: await splitByEqualPages(sourceDoc), usedFallback: true, detectionMethod: 'equal-pages' };
  }

  boundaries = boundariesToChunks(boundaries, totalPages);

  const chunks: PdfChunk[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const startPage = boundaries[i].page;
    const endPage = i + 1 < boundaries.length ? boundaries[i + 1].page - 1 : totalPages;
    const pageNumbers = Array.from({ length: endPage - startPage + 1 }, (_, idx) => startPage + idx);
    chunks.push(await copyChunk(sourceDoc, pageNumbers, i, boundaries[i].label));
  }
  return { chunks, usedFallback: false, detectionMethod };
}

export async function splitPdf(pdfBytes: Buffer, method: SplitMethod = 'equal-pages'): Promise<SplitResult> {
  const sourceDoc = await PDFDocument.load(pdfBytes);

  if (method === 'by-chapter') {
    const { chunks, usedFallback, detectionMethod } = await splitByChapter(sourceDoc, pdfBytes);
    return { chunks, method, usedFallback, detectionMethod };
  }

  return { chunks: await splitByEqualPages(sourceDoc), method, usedFallback: false };
}
