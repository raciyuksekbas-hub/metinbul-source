#!/usr/bin/env node
// Fails when `npm audit --json` reports any vulnerability, at any severity,
// for a package that is a devDependency in package.json but ships inside the
// app. Electron is the runtime of the packaged app, so `npm audit --omit=dev`
// would never look at it.
//
//   npm audit --json > audit.json || true
//   node scripts/security/audit-electron.mjs audit.json
//   npm audit --json | node scripts/security/audit-electron.mjs     (reads stdin)
//
// Exit codes: 0 none reported, 1 vulnerable, 2 the report is missing, is an
// npm error, or is not an audit report (fails closed).
// Node >= 22, no dependencies.

import { readFileSync } from 'node:fs';

const SHIPPED_DEV_DEPENDENCIES = ['electron'];

async function readReport(file) {
  if (file !== '-') return readFileSync(file, 'utf8');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const file = process.argv[2] ?? '-';
  if (file === '-' && process.stdin.isTTY) {
    console.error('usage: node scripts/security/audit-electron.mjs [npm-audit.json | - (stdin)]');
    return 2;
  }
  let report;
  try {
    report = JSON.parse(await readReport(file));
  } catch (error) {
    console.error(`cannot read the npm audit report ${file === '-' ? 'from stdin' : file}: ${error.message}`);
    return 2;
  }
  if (report.error) {
    console.error(`npm audit failed: ${report.error.code ?? ''} ${report.error.summary ?? JSON.stringify(report.error)}`);
    return 2;
  }
  if (report.auditReportVersion !== 2 || typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
    console.error('unexpected npm audit report format (expected auditReportVersion 2 with a vulnerabilities object)');
    return 2;
  }

  let vulnerable = 0;
  for (const name of SHIPPED_DEV_DEPENDENCIES) {
    const entry = report.vulnerabilities[name];
    if (!entry) {
      console.log(`${name}: no known vulnerability reported by npm audit`);
      continue;
    }
    vulnerable++;
    console.log(`${name}: ${entry.severity} - affected range ${entry.range}, fix available: ${JSON.stringify(entry.fixAvailable)}`);
    for (const via of entry.via ?? []) {
      if (typeof via === 'string') {
        console.log(`  - through the vulnerable dependency ${via}`);
      } else {
        console.log(`  - [${via.severity}] ${via.title} (${via.url}) affects ${via.range}`);
      }
    }
  }
  if (vulnerable > 0) {
    console.log('::error::A package that ships inside MetinBul has a known vulnerability. Update it before releasing.');
    return 1;
  }
  return 0;
}

process.exitCode = await main();
