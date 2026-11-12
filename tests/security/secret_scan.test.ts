import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs scripts/security/scan-secrets.mjs against throwaway git repositories.
// Every secret below is assembled at runtime from fragments and random
// characters, so this file never contains a token-shaped string and the
// scanner stays clean when it scans this repository.

const SCANNER = fileURLToPath(new URL('../../scripts/security/scan-secrets.mjs', import.meta.url));
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const ALLOW = ['secret-scan', 'allow'].join(':');

function rand(length: number, alphabet = ALNUM): string {
  let out = '';
  for (const byte of randomBytes(length)) out += alphabet[byte % alphabet.length];
  return out;
}

// git must act on the temporary repository only, whatever the caller's environment says.
const gitEnv = { ...process.env };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete gitEnv[name];

const tempDirs: string[] = [];

function makeRepo(files: Record<string, string | Buffer>, untracked: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-secret-scan-'));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir, env: gitEnv });
  for (const [rel, content] of Object.entries(untracked)) fs.writeFileSync(path.join(dir, rel), content);
  return dir;
}

function scan(dir: string) {
  const result = spawnSync(process.execPath, [SCANNER], { cwd: dir, env: gitEnv, encoding: 'utf8' });
  return {
    status: result.status,
    lines: result.stdout.split(/\r?\n/).filter(Boolean),
    output: result.stdout + result.stderr,
  };
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('secret scanner', () => {
  const secrets = {
    privateKey: ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
    githubClassic: 'gh' + 'p_' + rand(36),
    githubOauth: 'gh' + 'o_' + rand(36),
    githubServer: 'gh' + 's_' + rand(36),
    githubFineGrained: 'github' + '_pat_' + rand(22) + '_' + rand(59),
    awsKeyId: 'AK' + 'IA' + rand(16, UPPER_DIGITS),
    slack: 'xo' + 'xb-' + rand(12, '0123456789') + '-' + rand(24),
    npm: 'np' + 'm_' + rand(36),
    google: 'AI' + 'za' + rand(35),
    apple: [rand(4, LOWER), rand(4, LOWER), rand(4, LOWER), rand(4, LOWER)].join('-'),
    generic: rand(20),
    envValue: rand(24),
    allowedValue: rand(20),
    excludedValue: 'gh' + 'p_' + rand(36),
  };

  let repo: string;
  let result: ReturnType<typeof scan>;

  beforeAll(() => {
    const leaky = [
      secrets.privateKey, // 1
      `const a = '${secrets.githubClassic}';`, // 2
      `const b = "${secrets.githubOauth}";`, // 3
      `const c = '${secrets.githubServer}';`, // 4
      `const d = '${secrets.githubFineGrained}';`, // 5
      `const e = '${secrets.awsKeyId}';`, // 6
      `const f = '${secrets.slack}';`, // 7
      `const g = '${secrets.npm}';`, // 8
      `const h = '${secrets.google}';`, // 9
      'const db' + `Password = "${secrets.generic}";`, // 10
    ].join('\n');
    const notarize = `xcrun notarytool submit app.zip --apple-id dev@example.com --pass` + `word ${secrets.apple}\n`;
    const env = 'API' + `_KEY=${secrets.envValue}\n`;
    const docs = [
      'to' + `ken = "${secrets.allowedValue}" // ${ALLOW} documented example value`, // 1: allowed
      `const leaked = '${secrets.githubClassic}';`, // 2: no marker, still reported
    ].join('\n');
    const binary = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(secrets.excludedValue)]);

    repo = makeRepo(
      {
        'src/leaky.ts': leaky,
        'scripts/notarize.sh': notarize,
        '.env': env,
        'docs/example.md': docs,
        'tests/real-fixtures/client-notes.txt': `token: '${secrets.excludedValue}'\n`,
        'node_modules/some-package/index.js': `module.exports = '${secrets.excludedValue}';\n`,
        'assets/blob.dat': binary,
        'assets/blob.txt': binary,
      },
      { 'untracked.ts': `const z = '${secrets.excludedValue}';\n` },
    );
    result = scan(repo);
  });

  it('reports every kind of secret as file:line pattern-name and exits 1', () => {
    expect(result.status).toBe(1);
    const expected = [
      'src/leaky.ts:1 private-key',
      'src/leaky.ts:2 github-token',
      'src/leaky.ts:3 github-token',
      'src/leaky.ts:4 github-token',
      'src/leaky.ts:5 github-fine-grained-token',
      'src/leaky.ts:6 aws-access-key-id',
      'src/leaky.ts:7 slack-token',
      'src/leaky.ts:8 npm-token',
      'src/leaky.ts:9 google-api-key',
      'src/leaky.ts:10 generic-secret-assignment',
      'scripts/notarize.sh:1 apple-app-specific-password',
      '.env:1 generic-secret-assignment',
      'docs/example.md:2 github-token',
    ];
    for (const line of expected) expect(result.lines).toContain(line);
    for (const line of result.lines) expect(line).toMatch(/^[^\s:]+:\d+ [a-z-]+$/);
  });

  it('honours the allow marker on its own line only', () => {
    expect(result.lines.filter((l) => l.startsWith('docs/example.md:1 '))).toEqual([]);
    expect(result.lines).toContain('docs/example.md:2 github-token');
    expect(result.output).toContain('1 line(s) allowed');
  });

  it('skips tests/real-fixtures, node_modules, binary and untracked files', () => {
    for (const prefix of ['tests/real-fixtures/', 'node_modules/', 'assets/', 'untracked.ts']) {
      expect(result.lines.filter((l) => l.startsWith(prefix))).toEqual([]);
    }
  });

  it('never prints the matched text', () => {
    for (const value of Object.values(secrets)) {
      expect(result.output).not.toContain(value);
      // nor any long piece of it (the random part is what identifies a secret)
      expect(result.output).not.toContain(value.slice(-12));
    }
  });

  it('exits 0 on a clean repository and ignores common look-alikes', () => {
    const clean = makeRepo({
      '.github/workflows/ci.yml': [
        'permissions:',
        '  id-' + 'token: write',
        'env:',
        '  GITHUB_' + 'TOKEN: ${{ secrets.GITHUB_' + 'TOKEN }}',
        '  NPM_' + 'TOKEN: ${{ secrets.NPM_' + 'TOKEN }}',
      ].join('\n'),
      'src/db.ts': [
        "db.exec(`CREATE VIRTUAL TABLE t USING fts5(body, tokenize='unicode61 remove_diacritics 2')`);",
        'interface Login { pass' + 'word: string; api' + 'Key?: string }',
        "const passwordLabel = 'Şifrenizi girin';",
        "const pass" + "word = 'correct horse battery staple';",
        "const to" + "ken = '${process.env.TOKEN}';",
        "const sec" + "ret = '********';",
      ].join('\n'),
    });
    const cleanResult = scan(clean);
    expect(cleanResult.lines).toEqual([]);
    expect(cleanResult.status).toBe(0);
  });

  it('exits 2 outside a git repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metinbul-secret-scan-nogit-'));
    tempDirs.push(dir);
    const outside = spawnSync(process.execPath, [SCANNER, dir], {
      env: { ...gitEnv, GIT_CEILING_DIRECTORIES: path.dirname(dir) },
      encoding: 'utf8',
    });
    expect(outside.status).toBe(2);
  });
});
