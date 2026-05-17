// Minimal Markdown -> .docx generator.
// Uses the `docx` npm package via Deno's npm: imports.
//
// Recognized blocks: # / ## / ### headings, blank-line-separated paragraphs,
// fenced code blocks (```...```), and unordered list items starting with - or *.
// Bold inline (**...**) is preserved.

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
} from "npm:docx@8.5.0";

export function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function runs(text: string): TextRun[] {
  // Split on **bold** while keeping the boundaries.
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((p) => p.length > 0);
  return parts.map((p) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return new TextRun({ text: p.slice(2, -2), bold: true });
    }
    return new TextRun(p);
  });
}

function blockToParagraphs(block: string): Paragraph[] {
  const trimmed = block.trim();
  if (!trimmed) return [];
  // Fenced code block.
  if (trimmed.startsWith("```")) {
    const inner = trimmed.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
    return inner.split("\n").map((line) =>
      new Paragraph({
        children: [new TextRun({ text: line || " ", font: "Consolas" })],
      })
    );
  }
  // Heading.
  const h = /^(#{1,3})\s+(.*)$/.exec(trimmed);
  if (h) {
    const level = h[1].length;
    const heading = level === 1
      ? HeadingLevel.HEADING_1
      : level === 2
      ? HeadingLevel.HEADING_2
      : HeadingLevel.HEADING_3;
    return [new Paragraph({ heading, children: runs(h[2]) })];
  }
  // Bullet list (consecutive lines).
  if (/^[-*]\s+/.test(trimmed)) {
    return trimmed.split("\n").map((line) => {
      const m = /^[-*]\s+(.*)$/.exec(line.trim());
      const txt = m ? m[1] : line;
      return new Paragraph({ bullet: { level: 0 }, children: runs(txt) });
    });
  }
  // Default paragraph (collapse internal newlines to spaces).
  return [new Paragraph({ children: runs(trimmed.replace(/\n+/g, " ")) })];
}

export async function markdownToDocx(md: string): Promise<Uint8Array> {
  const blocks = md.split(/\n{2,}/);
  const children: Paragraph[] = [];
  for (const b of blocks) children.push(...blockToParagraphs(b));
  if (children.length === 0) children.push(new Paragraph({ children: [new TextRun("")] }));
  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf);
}
