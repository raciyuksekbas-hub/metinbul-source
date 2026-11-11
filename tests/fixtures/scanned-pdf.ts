// Writes an image-only PDF -- what a scanner produces: one page that is a
// picture of text, with no text layer -- for the text recognition tests.
// `rotated` stores the page sideways with /Rotate 90, as scanners often do, so
// a viewer still shows it upright.
import * as fs from 'fs';

export async function writeScannedPdf(filePath: string, lines: string[], options: { rotated?: boolean } = {}): Promise<void> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const width = 1240;
  const height = 1754; // A4 at 150 dpi
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000';
  ctx.font = '44px Helvetica';
  lines.forEach((line, i) => ctx.fillText(line, 100, 200 + i * 80));
  const jpeg = canvas.toBuffer('image/jpeg');

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
  object(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  object(2, () => push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  object(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox}${options.rotated ? ' /Rotate 90' : ''} `
    + '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'));
  object(4, () => {
    push(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB `
      + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    push(jpeg);
    push('\nendstream');
  });
  object(5, () => push(`<< /Length ${drawImage.length} >>\nstream\n${drawImage}\nendstream`));
  const xref = length;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map(n => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}`
    + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  fs.writeFileSync(filePath, Buffer.concat(parts));
}
