import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

async function build() {
  const distDir = path.join(rootDir, 'dist');
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(path.join(distDir, 'renderer'), { recursive: true });

  // 1. Build Main Process (ESM)
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/main/main.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: path.join(distDir, 'main.js'),
    external: ['electron', 'better-sqlite3', 'pdf-parse', 'mammoth', 'word-extractor', 'adm-zip', 'fast-xml-parser']
  });

  // 2. Build Indexer Worker (ESM, worker_threads entry point)
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/main/indexer-worker.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: path.join(distDir, 'indexer-worker.js'),
    external: ['electron', 'better-sqlite3', 'pdf-parse', 'mammoth', 'word-extractor', 'adm-zip', 'fast-xml-parser']
  });

  // 2b. Build Search Worker (ESM, worker_threads entry point)
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/main/search-worker.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: path.join(distDir, 'search-worker.js'),
    external: ['electron', 'better-sqlite3', 'pdf-parse', 'mammoth', 'word-extractor', 'adm-zip', 'fast-xml-parser']
  });

  // 3. Build Preload Script (CJS for Electron)
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/main/preload.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(distDir, 'preload.cjs'),
    external: ['electron']
  });

  // 4. Build Renderer Script
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/renderer/renderer.ts')],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    outfile: path.join(distDir, 'renderer/renderer.js')
  });

  // 5. Build Quick Search Renderer Script
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/renderer/quick-search.ts')],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    outfile: path.join(distDir, 'renderer/quick-search.js')
  });

  // 6. Build Settings Window Script
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/renderer/settings.ts')],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    outfile: path.join(distDir, 'renderer/settings.js')
  });

  // 7. Copy static assets
  fs.copyFileSync(
    path.join(rootDir, 'src/renderer/index.html'),
    path.join(distDir, 'renderer/index.html')
  );
  fs.copyFileSync(
    path.join(rootDir, 'src/renderer/quick-search.html'),
    path.join(distDir, 'renderer/quick-search.html')
  );
  fs.copyFileSync(
    path.join(rootDir, 'src/renderer/settings.html'),
    path.join(distDir, 'renderer/settings.html')
  );
  fs.copyFileSync(
    path.join(rootDir, 'src/renderer/style.css'),
    path.join(distDir, 'renderer/style.css')
  );

  // 8. Copy icon assets to dist
  const assetsDistDir = path.join(distDir, 'assets');
  fs.mkdirSync(assetsDistDir, { recursive: true });
  const assetsSourceDir = path.join(rootDir, 'assets');
  for (const file of ['icon-1024.png', 'icon.icns', 'icon.ico']) {
    const src = path.join(assetsSourceDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(assetsDistDir, file));
    }
  }

  // 9. macOS text recognition helper. electron-builder copies it to the app's
  // Resources/bin (mac.extraResources) and keeps it out of app.asar, where it
  // could not run. A macOS build without it would silently lose OCR, so a
  // compile error fails the build.
  if (process.platform === 'darwin') {
    const nativeDir = path.join(distDir, 'native');
    fs.mkdirSync(nativeDir, { recursive: true });
    execFileSync('xcrun', [
      'swiftc', '-O', '-target', 'arm64-apple-macos12',
      '-o', path.join(nativeDir, 'metinbul-ocr'),
      path.join(rootDir, 'native/macos/metinbul-ocr.swift')
    ], { stdio: 'inherit' });
  }

  console.log('MetinBul build completed successfully.');
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
