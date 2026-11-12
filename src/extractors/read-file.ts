import * as fs from 'fs';

// Reads a whole document into memory once, refusing it by size before any of
// its content is read. The size is checked on the path first and again on the
// open descriptor, and the read never takes more than that size, so a file
// that grows or is swapped in between cannot push past the limit.
//
// The bytes land in their own ArrayBuffer (not Node's shared pool), so a
// parser may take ownership of it (pdf.js transfers the buffer it is given).
export function readFileWithinLimit(filePath: string, maxBytes: number): Buffer {
  const checkSize = (stats: fs.Stats) => {
    if (!stats.isFile()) {
      throw new Error('not a regular file');
    }
    if (stats.size > maxBytes) {
      throw new Error(`file is ${stats.size} bytes, over the limit of ${maxBytes} bytes`);
    }
  };

  checkSize(fs.statSync(filePath));
  const fd = fs.openSync(filePath, 'r');
  try {
    const stats = fs.fstatSync(fd);
    checkSize(stats);
    const data = Buffer.allocUnsafeSlow(stats.size);
    let filled = 0;
    while (filled < data.length) {
      const read = fs.readSync(fd, data, filled, data.length - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    // A file that shrank since fstat: hand on only the bytes actually read.
    return filled === data.length ? data : data.subarray(0, filled);
  } finally {
    fs.closeSync(fd);
  }
}
