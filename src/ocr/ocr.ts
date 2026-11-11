// Text recognition (OCR) for the pages of a PDF that carry no real text layer
// -- scanned documents. On macOS this runs native/macos/metinbul-ocr, a small
// helper around the system's own on-device recognition; on Windows,
// windows-ocr.ts drives Windows' own. Nothing leaves the machine. Kept free of
// Electron so the indexer worker and the tests can use it directly.
import { execFile } from 'child_process';
import { ContentNotLocallyAvailableError } from '../scanner/windows-availability.js';

export interface OcrEngine {
  // The text recognized on each of the given pages (1-based) of a PDF, in the
  // same order; '' for a page without text. Throws when the document could
  // not be read.
  recognizePdfPages(filePath: string, pages: number[]): Promise<string[]>;
}

// How long one index update may spend on text recognition. The scanned PDFs
// beyond that wait for the next update, so a first run over thousands of
// pages never holds one update for long.
export const OCR_BUDGET_MS = 3 * 60 * 1000;

// Exit codes shared by native/macos/metinbul-ocr.swift and the Windows script.
export const OCR_EXIT_UNREADABLE = 2;
export const OCR_EXIT_NO_TURKISH = 3;
export const OCR_EXIT_CLOUD_ONLY = 5;

// A page takes about half a second on macOS and about a second on Windows.
// The limit grows with the pages asked for, so that a long scan is never
// failed for its length alone, while a short one that stalls (seen once on
// the real profile, and gone on retry) does not hold an update for long.
export function ocrTimeoutMs(pageCount: number): number {
  return 2 * 60 * 1000 + pageCount * 3 * 1000;
}

// Both engines end every page's text with a form feed.
export function splitOcrPages(output: string, count: number): string[] {
  const parts = output.split('\f');
  return Array.from({ length: count }, (_, i) => (parts[i] ?? '').trim());
}

export function createMacosOcrEngine(helperPath: string): OcrEngine {
  return {
    recognizePdfPages: (filePath, pages) => new Promise((resolve, reject) => {
      execFile(
        helperPath,
        [filePath, '--pages', pages.join(',')],
        { encoding: 'utf8', timeout: ocrTimeoutMs(pages.length), maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(splitOcrPages(String(stdout), pages.length));
          } else if (error.code === OCR_EXIT_CLOUD_ONLY) {
            reject(new ContentNotLocallyAvailableError(filePath));
          } else {
            reject(new Error(`Text recognition failed (${error.code ?? error.signal}): ${String(stderr).trim()}`));
          }
        }
      );
    })
  };
}

// Whether the helper runs on this Mac and the system recognizes Turkish.
export function isMacosOcrAvailable(helperPath: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile(helperPath, ['--check'], { timeout: 60_000 }, error => resolve(!error));
  });
}
