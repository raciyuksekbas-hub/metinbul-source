import pngToIco from 'png-to-ico';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const buf = await pngToIco(path.join(rootDir, 'assets/icon-1024.png'));
fs.writeFileSync(path.join(rootDir, 'assets/icon.ico'), buf);
console.log('wrote assets/icon.ico', buf.length, 'bytes');
