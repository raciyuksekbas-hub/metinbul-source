#!/usr/bin/env node
// Secret scanner for the files git tracks.
//
//   node scripts/security/scan-secrets.mjs [directory-inside-a-git-repo]
//
// Scans every file `git ls-files` lists (text files only) for credentials and
// prints one line per finding: `path:line pattern-name`. It never prints the
// matched text or the line, so its output is safe to keep in CI logs.
//
// - tests/real-fixtures/ holds real client documents: it is excluded in the
//   git query and again by path, so those files are never opened.
// - node_modules/, binary files (NUL byte in the first 8 KB), symlinks and
//   files over 10 MB are skipped; the summary on stderr counts them.
// - A documented false positive is silenced by putting the marker
//   `secret-scan:allow` on the same line (e.g. in a comment). Say why next to it.
//
// Exit codes: 0 nothing found, 1 findings, 2 the scan could not run.
// Node >= 22, no dependencies.

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ALLOW_MARKER = 'secret-scan:allow';
const MAX_BYTES = 10 * 1024 * 1024;
const NEVER_OPEN_PREFIX = 'tests/real-fixtures/';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp', '.ico', '.icns',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.rtf', '.udf',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.dmg', '.pkg', '.asar',
  '.exe', '.dll', '.node', '.so', '.dylib', '.a', '.o', '.obj', '.lib', '.wasm', '.class', '.jar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.wav', '.m4a',
  '.db', '.sqlite', '.sqlite3', '.bin', '.dat',
]);

// Files where `key: value` / KEY=value without quotes is a real assignment.
const CONFIG_EXTENSIONS = new Set([
  '.env', '.ini', '.cfg', '.conf', '.properties', '.toml', '.yml', '.yaml', '.npmrc',
]);

// Identifier that ends in a credential word: password, dbPassword, API_KEY,
// apiKey, client_secret, secretKey, GITHUB_TOKEN, authToken ... but not
// tokenize, tokens or passwordLabel.
const KEY = String.raw`(?<![A-Za-z0-9_])["']?[A-Za-z0-9_.-]{0,40}?(?:password|passwd|secret|api[_-]?key|apikey|token)(?:[_-]?(?:key|value))?["']?`;
// ... assigned a quoted literal of 8+ characters without whitespace.
const QUOTED_ASSIGNMENT = new RegExp(KEY + String.raw`\s*(?::=|=>|[:=])\s*(["'\x60])([^\s"'\x60]{8,})\1`, 'i');
// ... or, in config files, a bare value of 8+ characters.
const BARE_ASSIGNMENT = new RegExp(KEY + String.raw`\s*[:=]\s*([^\s"'\x60#,;]{8,})\s*(?:#.*)?$`, 'i');

function isPlaceholder(value) {
  return (
    /\$\{|\{\{|^\$|^%.*%$|^<.*>$/.test(value) || // ${VAR}, ${{ secrets.X }}, $VAR, %VAR%, <your-token>
    /^(.)\1+$/.test(value) || //                   ******** or xxxxxxxx
    /^(?:true|false|null|none|undefined)$/i.test(value)
  );
}

function genericAssignment(line, isConfigFile) {
  const quoted = QUOTED_ASSIGNMENT.exec(line);
  if (quoted && !isPlaceholder(quoted[2])) return true;
  if (!isConfigFile) return false;
  const bare = BARE_ASSIGNMENT.exec(line);
  return Boolean(bare && !/^[[{*&!|>]/.test(bare[1]) && !isPlaceholder(bare[1]));
}

const APPLE_PASSWORD_SHAPE = /(?<![A-Za-z0-9-])[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}(?![A-Za-z0-9-])/;
const APPLE_CONTEXT = /pass(?:word)?|pwd|secret|credential|app[-_ ]?specific|apple|notar|altool/i;

const RULES = [
  { name: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/ },
  { name: 'github-fine-grained-token', re: /\bgithub_pat_[A-Za-z0-9_]{36,255}\b/ },
  { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/ },
  { name: 'aws-secret-access-key', re: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/i },
  { name: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/_-]{20,}/ },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'npmrc-auth', re: /:_auth(?:Token)?\s*=\s*(?!\$\{)[^\s"']{8,}/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/ },
  {
    name: 'apple-app-specific-password',
    test: (line) => APPLE_PASSWORD_SHAPE.test(line) && APPLE_CONTEXT.test(line),
  },
  { name: 'generic-secret-assignment', test: genericAssignment },
];

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function isExcluded(relPath) {
  const lower = relPath.toLowerCase();
  return lower.startsWith(NEVER_OPEN_PREFIX) || lower.split('/').includes('node_modules');
}

function main() {
  const start = path.resolve(process.argv[2] ?? process.cwd());
  let root;
  let files;
  try {
    root = git(['rev-parse', '--show-toplevel'], start).trim();
    files = git(['ls-files', '-z', '--', ':/', `:(top,exclude)${NEVER_OPEN_PREFIX}`], root)
      .split('\0')
      .filter(Boolean);
  } catch (error) {
    console.error(`secret scan: cannot list the files git tracks under ${start}: ${error.message}`);
    return 2;
  }

  const findings = [];
  const skipped = { excluded: 0, binary: 0, large: 0, other: 0 };
  let scanned = 0;
  let allowed = 0;

  for (const relPath of files) {
    if (isExcluded(relPath)) {
      skipped.excluded++;
      continue;
    }
    const ext = path.extname(relPath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      skipped.binary++;
      continue;
    }
    const absPath = path.join(root, relPath);
    let stat;
    try {
      stat = lstatSync(absPath);
    } catch {
      skipped.other++; // listed by git but missing from the working tree
      continue;
    }
    if (!stat.isFile()) {
      skipped.other++; // symlink or submodule: never followed
      continue;
    }
    if (stat.size > MAX_BYTES) {
      skipped.large++;
      console.error(`secret scan: skipped (over ${MAX_BYTES} bytes): ${relPath}`);
      continue;
    }
    const buffer = readFileSync(absPath);
    if (buffer.subarray(0, 8000).includes(0)) {
      skipped.binary++;
      continue;
    }

    scanned++;
    const base = path.basename(relPath).toLowerCase();
    const isConfigFile = CONFIG_EXTENSIONS.has(ext) || base.startsWith('.env') || base === '.npmrc';
    const lines = buffer.toString('utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const hits = RULES.filter((rule) => (rule.re ? rule.re.test(line) : rule.test(line, isConfigFile)));
      if (hits.length === 0) return;
      if (line.includes(ALLOW_MARKER)) {
        allowed++;
        return;
      }
      for (const rule of hits) findings.push(`${relPath}:${index + 1} ${rule.name}`);
    });
  }

  for (const finding of findings) console.log(finding);
  const skippedTotal = skipped.excluded + skipped.binary + skipped.large + skipped.other;
  console.error(
    `secret scan: ${findings.length} finding(s); ${scanned} text files scanned, ` +
      `${skippedTotal} skipped (excluded ${skipped.excluded}, binary ${skipped.binary}, ` +
      `too large ${skipped.large}, other ${skipped.other}); ${allowed} line(s) allowed by ${ALLOW_MARKER}`,
  );
  return findings.length > 0 ? 1 : 0;
}

process.exitCode = main();
