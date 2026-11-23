import type { TransformDocument } from '../../pdf/transform.js';
import { withExtension, type Handler } from './types.js';

// "Rule 1.100 Title", "RULE 2.505", "rule 3.220(b) Title": any case, the number may carry (a)-style parts.
const RULE_HEADING = /^rule\s+([0-9A-Z][0-9A-Za-z.\-]*(?:\([0-9A-Za-z]+\))*)[.:\s-]*(.*)$/i;

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unesc(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Court Rules markup: one <page> per source page, <rule> for each "Rule N" heading, <para> for other lines. */
export function markUp(doc: TransformDocument, classification: string): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<courtRules sourceFileId="${doc.source_file_id}" classification="${esc(classification)}" pages="${doc.page_count}">`];
  for (const chunk of doc.chunks) {
    out.push(`  <page n="${chunk.page}">`);
    let inRule = false;
    for (const raw of chunk.text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const heading = RULE_HEADING.exec(line);
      if (heading) {
        if (inRule) out.push('    </rule>');
        out.push(`    <rule number="${esc(heading[1])}">`, `      <title>${esc(heading[2] || line)}</title>`);
        inRule = true;
      } else {
        out.push(`${inRule ? '      ' : '    '}<para>${esc(line)}</para>`);
      }
    }
    if (inRule) out.push('    </rule>');
    out.push('  </page>');
  }
  out.push('</courtRules>');
  return out.join('\n');
}

/** Well-formedness by tag balance, and the element count. Enough for markup this handler produced itself. */
export function validateXml(xml: string): { valid: boolean; elements: number; error: string | null } {
  const stack: string[] = [];
  let elements = 0;
  for (const match of xml.matchAll(/<(\/?)([A-Za-z_][\w.-]*)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = match;
    if (closing) {
      const open = stack.pop();
      if (open !== name) return { valid: false, elements, error: `</${name}> closes <${open ?? 'nothing'}>` };
    } else {
      elements++;
      if (!selfClosing) stack.push(name);
    }
  }
  return stack.length ? { valid: false, elements, error: `<${stack.at(-1)}> is never closed` } : { valid: true, elements, error: null };
}

const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Text-loss check (LDU compare): the share of the source's words, counted with repeats, still present in the markup. */
export function lduMatch(sourceText: string, xml: string): number {
  const source = words(sourceText);
  if (!source.length) return 100;
  // A rule heading lives in the number attribute, so read it back as the words it came from.
  const text = unesc(xml.replace(/<\?xml[^>]*\?>/, '').replace(/<rule number="([^"]*)">/g, ' rule $1 ').replace(/<[^>]+>/g, ' '));
  const bag = new Map<string, number>();
  for (const w of words(text)) bag.set(w, (bag.get(w) ?? 0) + 1);
  let kept = 0;
  for (const w of source) {
    const left = bag.get(w) ?? 0;
    if (left > 0) {
      kept++;
      bag.set(w, left - 1);
    }
  }
  return Math.round((kept / source.length) * 10000) / 100;
}

/** Simple text lint standing in for the spell-check utility: doubled words, stray spaces, unbalanced brackets. */
export function lintText(text: string): string[] {
  const issues: string[] = [];
  for (const m of text.matchAll(/\b(\w+)\s+\1\b/gi)) issues.push(`doubled word "${m[1]}"`);
  if (/ {2,}/.test(text)) issues.push('multiple spaces');
  const opens = (text.match(/\(/g) ?? []).length;
  const closes = (text.match(/\)/g) ?? []).length;
  if (opens !== closes) issues.push(`unbalanced parentheses (${opens} open, ${closes} close)`);
  return issues.slice(0, 20);
}

/** JSON text → Court Rules XML, with the utilities report written to the file's metadata. */
export const xmlMarkup: Handler = {
  kind: 'process',
  async run({ msg, input }) {
    const doc = JSON.parse(input.bytes.toString('utf8')) as TransformDocument;
    const classification = String(msg.file_metadata.classification ?? msg.file_metadata.suggested_classification ?? 'Unclassified');
    const xml = markUp(doc, classification);
    const sourceText = doc.chunks.map((c) => c.text).join('\n');
    const check = validateXml(xml);
    const lint = lintText(sourceText);
    return {
      output: { bytes: Buffer.from(xml, 'utf8'), fileName: withExtension(input.fileName, 'xml'), contentType: 'application/xml' },
      metaData: {
        content_format: 'xml',
        classification,
        xml_valid: check.valid,
        xml_error: check.error,
        xml_elements: check.elements,
        xml_bytes: Buffer.byteLength(xml, 'utf8'),
        ldu_match_pct: lduMatch(sourceText, xml),
        lint_issue_count: lint.length,
        lint_issues: lint,
        marked_up_at: new Date().toISOString(),
      },
    };
  },
};
