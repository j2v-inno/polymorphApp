import pdfParse from 'pdf-parse';
import { config } from '../config.js';

export interface TextExtractabilityResult {
  isTextExtractable: boolean;
  totalPages: number;
  extractedCharCount: number;
}

/**
 * §6.1 gate: "validate the uploaded PDF is text-extractable (not scanned/image-only)".
 * The doc doesn't define a precise threshold, so this uses an average-chars-per-page
 * heuristic (config.acquisitionMinAvgCharsPerPage). Tune or replace once a real
 * definition is agreed — this is a placeholder good enough to distinguish an
 * obviously-scanned PDF (near-zero extracted text) from a text PDF.
 *
 * Pinned to pdf-parse v1 deliberately: the current v2 (a pdfjs-dist v5 rewrite)
 * crashes under Node's structuredClone-based worker simulation in this
 * environment ("Cannot transfer object of unsupported type" from
 * pdfjs-dist's LoopbackPort) — v1's older, worker-free implementation doesn't
 * hit that path and is otherwise sufficient for a plain text-length check.
 */
export async function checkTextExtractability(pdfBytes: Buffer): Promise<TextExtractabilityResult> {
  const result = await pdfParse(pdfBytes);
  const totalPages = result.numpages;
  const avgCharsPerPage = totalPages > 0 ? result.text.length / totalPages : 0;
  return {
    isTextExtractable: avgCharsPerPage >= config.acquisitionMinAvgCharsPerPage,
    totalPages,
    extractedCharCount: result.text.length,
  };
}
