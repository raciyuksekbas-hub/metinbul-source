// pdf.js (inside pdf-parse) loads @napi-rs/canvas, a native Skia module, as
// soon as it is imported under Node -- only to borrow DOMMatrix, ImageData and
// Path2D, which it needs for drawing pages, never for reading their text.
//
// On Windows that module took MetinBul down as a whole: an access violation
// (0xc0000005) in skia.win32-x64-msvc.node after it had been unloaded, which
// happens when the indexer thread that loaded it ends. A colleague's review
// of 0.4.3 reproduced it three times out of three with a 120-page scanned
// PDF, and found the same crash recorded for 0.4.2 and 0.2.1 in a real
// office's event log.
//
// MetinBul only reads text, so pdf.js gets small stand-ins for those three
// classes and the native module is never loaded at all.
import { createRequire } from 'module';

const CANVAS_MODULE = '@napi-rs/canvas';

type Matrix = [number, number, number, number, number, number];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}

// A 2D DOMMatrix: pdf.js builds one when it loads (and the drawing code,
// which MetinBul never runs, uses more of it).
export class TextOnlyDOMMatrix {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  readonly is2D = true;

  constructor(init?: ArrayLike<number> | TextOnlyDOMMatrix) {
    if (init instanceof TextOnlyDOMMatrix) {
      this.set([init.a, init.b, init.c, init.d, init.e, init.f]);
    } else if (init && init.length === 6) {
      this.set([init[0], init[1], init[2], init[3], init[4], init[5]]);
    } else if (init && init.length === 16) {
      this.set([init[0], init[1], init[4], init[5], init[12], init[13]]);
    }
  }

  private set(m: Matrix): this {
    [this.a, this.b, this.c, this.d, this.e, this.f] = m;
    return this;
  }

  private get values(): Matrix {
    return [this.a, this.b, this.c, this.d, this.e, this.f];
  }

  get m11() { return this.a; }
  get m12() { return this.b; }
  get m21() { return this.c; }
  get m22() { return this.d; }
  get m41() { return this.e; }
  get m42() { return this.f; }
  get isIdentity() {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  multiplySelf(other: TextOnlyDOMMatrix): this { return this.set(multiply(this.values, new TextOnlyDOMMatrix(other).values)); }
  preMultiplySelf(other: TextOnlyDOMMatrix): this { return this.set(multiply(new TextOnlyDOMMatrix(other).values, this.values)); }
  translateSelf(x = 0, y = 0): this { return this.set(multiply(this.values, [1, 0, 0, 1, x, y])); }
  scaleSelf(sx = 1, sy = sx): this { return this.set(multiply(this.values, [sx, 0, 0, sy, 0, 0])); }
  invertSelf(): this {
    const [a, b, c, d, e, f] = this.values;
    const det = a * d - b * c;
    if (!det) return this.set([NaN, NaN, NaN, NaN, NaN, NaN]);
    return this.set([d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]);
  }

  multiply(other: TextOnlyDOMMatrix) { return new TextOnlyDOMMatrix(this).multiplySelf(other); }
  translate(x?: number, y?: number) { return new TextOnlyDOMMatrix(this).translateSelf(x, y); }
  scale(sx?: number, sy?: number) { return new TextOnlyDOMMatrix(this).scaleSelf(sx, sy); }
  inverse() { return new TextOnlyDOMMatrix(this).invertSelf(); }
  transformPoint(point: { x?: number; y?: number } = {}) {
    const x = point.x ?? 0;
    const y = point.y ?? 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
  }
}

class TextOnlyImageData {
  readonly data: Uint8ClampedArray;
  constructor(readonly width: number, readonly height: number) {
    this.data = new Uint8ClampedArray(Math.max(0, width * height * 4));
  }
}

class TextOnlyPath2D {
  addPath(): void {}
}

let prepared = false;

/**
 * Called before pdf-parse is first imported in this thread. Every thread
 * (the indexer runs on its own) has its own globals and module loader, so
 * each one prepares its own.
 */
export function preparePdfjsForTextOnly(): void {
  if (prepared) return;
  prepared = true;
  const g = globalThis as Record<string, unknown>;
  if (!g.DOMMatrix) g.DOMMatrix = TextOnlyDOMMatrix;
  if (!g.ImageData) g.ImageData = TextOnlyImageData;
  if (!g.Path2D) g.Path2D = TextOnlyPath2D;

  // pdf.js requires the module through createRequire(), which resolves it
  // here; refusing it makes pdf.js carry on without it, as it does wherever
  // the module is missing.
  const Module = createRequire(import.meta.url)('module') as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
    if (request === CANVAS_MODULE || request.startsWith(`${CANVAS_MODULE}/`)) {
      const error = new Error(`MetinBul reads PDF text without ${CANVAS_MODULE}`) as Error & { code: string };
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    return resolve.call(this, request, ...rest);
  };
}
