import { extractPerPageText } from './split.js';
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
 * Uses split.ts's extractPerPageText (the direct-pdf.js path) rather than
 * calling pdf-parse directly — this used to call pdf-parse's own wrapper,
 * which is reliable against real user-uploaded PDFs but throws "bad XRef
 * entry"/"Invalid PDF structure" against pdf-lib-produced ones (confirmed:
 * bulk-registration.ts's placeholder PDF hit this immediately; real
 * Acquisition uploads never had until now, since nothing fed this gate a
 * pdf-lib-generated PDF before). extractPerPageText already solved this exact
 * problem for split.ts's own re-parsing needs — see its doc comment.
 */
export async function checkTextExtractability(pdfBytes: Buffer): Promise<TextExtractabilityResult> {
  const pages = await extractPerPageText(pdfBytes);
  const totalPages = pages.length;
  const extractedCharCount = pages.reduce((sum, page) => sum + page.length, 0);
  const avgCharsPerPage = totalPages > 0 ? extractedCharCount / totalPages : 0;
  return {
    isTextExtractable: avgCharsPerPage >= config.acquisitionMinAvgCharsPerPage,
    totalPages,
    extractedCharCount,
  };
}
