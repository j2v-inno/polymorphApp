import { extractPerPageText } from '../../pdf/split.js';
import { buildTransformDocument, toJson } from '../../pdf/transform.js';
import { withExtension, type Handler } from './types.js';

/** Keyword rules, checked in order: a suggestion the operator confirms or changes at VERIFY_CLASSIFY. No AI. */
const CLASS_RULES: Array<[RegExp, string]> = [
  [/\brepeal(ed|s)?\b/i, 'Repeal'],
  [/\bamend(ed|ment|ments|s)?\b/i, 'Amendment'],
  [/\b(administrative|supreme court)\s+order\b|\border\s+no\.?/i, 'Court Order'],
  [/\brule\s+\d+/i, 'New Rule'],
];

export function suggestClassification(text: string): string {
  return CLASS_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? 'Unclassified';
}

/** PDF → per-page JSON text, plus page/character counts and a suggested classification. */
export const textExtract: Handler = {
  kind: 'process',
  async run({ msg, input }) {
    const pages = await extractPerPageText(input.bytes);
    const doc = buildTransformDocument(pages, {
      sourceFileId: msg.file_id,
      parentFileId: null,
      splitIndex: null,
      chapterTitle: null,
    });
    const text = pages.join('\n');
    return {
      output: { bytes: Buffer.from(toJson(doc), 'utf8'), fileName: withExtension(input.fileName, 'json'), contentType: 'application/json' },
      metaData: {
        content_format: 'json',
        page_count: pages.length,
        char_count: text.replace(/\s/g, '').length,
        suggested_classification: suggestClassification(text),
        text_extracted_at: new Date().toISOString(),
      },
    };
  },
};
