import { PDFDocument } from 'pdf-lib';
import { config } from '../config.js';

export interface PdfChunk {
  index: number;
  /** 1-indexed page numbers from the source document, for pages_with_errors intersection (§6.3.1). */
  pageNumbers: number[];
  bytes: Buffer;
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

/** Splits a PDF into 2-5 roughly-equal-page-count files (§1, §6.3). */
export async function splitPdf(pdfBytes: Buffer): Promise<PdfChunk[]> {
  const sourceDoc = await PDFDocument.load(pdfBytes);
  const totalPages = sourceDoc.getPageCount();
  const chunkCount = computeChunkCount(totalPages);
  const pageRanges = computePageRanges(totalPages, chunkCount);

  const chunks: PdfChunk[] = [];
  for (let i = 0; i < pageRanges.length; i++) {
    const pageNumbers = pageRanges[i];
    const chunkDoc = await PDFDocument.create();
    const copiedPages = await chunkDoc.copyPages(
      sourceDoc,
      pageNumbers.map((pageNumber) => pageNumber - 1),
    );
    copiedPages.forEach((page) => chunkDoc.addPage(page));
    const bytes = await chunkDoc.save();
    chunks.push({ index: i, pageNumbers, bytes: Buffer.from(bytes) });
  }
  return chunks;
}
