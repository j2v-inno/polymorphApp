import { PDFDocument, StandardFonts } from 'pdf-lib';

const PLACEHOLDER_LINE = 'A quick brown fox jumps over the lazy dog';
const REPEAT_COUNT = 10;

let cached: Buffer | null = null;

/**
 * Bulk registration has no real source document per row — every row gets
 * this same placeholder PDF (content is irrelevant; the point is exercising
 * registration + the text-extractability gate + metadata, not real document
 * ingestion). Generated once per process and reused for every row in every
 * run, since the bytes are always identical.
 */
export async function generatePlaceholderPdf(): Promise<Buffer> {
  if (cached) return cached;

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage();
  const { height } = page.getSize();
  const fontSize = 14;
  const lineHeight = fontSize + 8;

  for (let i = 0; i < REPEAT_COUNT; i++) {
    page.drawText(PLACEHOLDER_LINE, {
      x: 50,
      y: height - 60 - i * lineHeight,
      size: fontSize,
      font,
    });
  }

  // useObjectStreams:false — pdf-lib defaults to compressed object streams,
  // which pdf-parse v1's bundled (pre-2018) pdf.js throws "Invalid PDF
  // structure" on (checkTextExtractability parses this PDF's bytes directly,
  // same gotcha pdf/split.ts's copyChunk already works around).
  cached = Buffer.from(await doc.save({ useObjectStreams: false }));
  return cached;
}
