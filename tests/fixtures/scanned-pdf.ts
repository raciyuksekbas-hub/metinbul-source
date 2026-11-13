// Writes an image-only PDF -- what a scanner produces: pages that are
// pictures of text, with no text layer -- for the text recognition tests.
// `rotated` stores the pages sideways with /Rotate 90, as scanners often do,
// so a viewer still shows them upright. `pages` repeats the page that many
// times (a long scan), each with its own page number below the lines.
import * as fs from 'fs';

export async function writeScannedPdf(
  filePath: string,
  lines: string[],
  options: { rotated?: boolean; pages?: number } = {}
): Promise<void> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const width = 1240;
  const height = 1754; // A4 at 150 dpi
  const pageCount = Math.max(1, options.pages ?? 1);
  const jpegs: Buffer[] = [];
  for (let page = 0; page < pageCount; page++) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#000';
    ctx.font = '44px Helvetica';
    const pageLines = pageCount > 1 ? [...lines, `Sayfa ${page + 1}`] : lines;
    pageLines.forEach((line, i) => ctx.fillText(line, 100, 200 + i * 80));
    jpegs.push(canvas.toBuffer('image/jpeg'));
  }

  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: string | Buffer) => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    parts.push(buffer);
    length += buffer.length;
  };
  const object = (n: number, body: () => void) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    body();
    push('\nendobj\n');
  };

  const mediaBox = options.rotated ? '[0 0 842 595]' : '[0 0 595 842]';
  // Sideways: the image is drawn turned a quarter left, and /Rotate 90 turns it back.
  const drawImage = options.rotated ? 'q 0 595 -842 0 842 0 cm /Im0 Do Q' : 'q 595 0 0 842 0 0 cm /Im0 Do Q';
  push('%PDF-1.4\n');
  // Objects: 1 catalog, 2 page tree, then per page: page, image, contents.
  const pageObject = (page: number) => 3 + page * 3;
  object(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  object(2, () => push(`<< /Type /Pages /Kids [${jpegs.map((_, page) => `${pageObject(page)} 0 R`).join(' ')}] /Count ${pageCount} >>`));
  jpegs.forEach((jpeg, page) => {
    const n = pageObject(page);
    object(n, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox}${options.rotated ? ' /Rotate 90' : ''} `
      + `/Resources << /XObject << /Im0 ${n + 1} 0 R >> >> /Contents ${n + 2} 0 R >>`));
    object(n + 1, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB `
        + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
      push(jpeg);
      push('\nendstream');
    });
    object(n + 2, () => push(`<< /Length ${drawImage.length} >>\nstream\n${drawImage}\nendstream`));
  });
  const objectCount = pageObject(pageCount);
  const xref = length;
  let table = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (let n = 1; n < objectCount; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(`${table}trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  fs.writeFileSync(filePath, Buffer.concat(parts));
}
