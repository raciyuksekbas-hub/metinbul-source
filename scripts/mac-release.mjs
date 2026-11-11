// Fail-closed macOS release driver: Developer ID signing + notarization +
// stapling, all gated so that a release artifact can never come out of here
// ad-hoc signed, unsigned or un-notarized.
//
// electron-builder already signs and notarizes the .app itself (see the
// `mac.notarize` / `dmg.sign` settings in package.json). What it does NOT do
// is notarize the DMG container, and it *silently skips* notarization when
// the credentials are missing -- both of those are handled here.
//
// Credentials come from a notarytool keychain profile; nothing secret is
// stored in the repository. See docs/macos-signing.md.
//
//   APPLE_KEYCHAIN_PROFILE  (required) notarytool profile name
//   APPLE_KEYCHAIN          (optional) keychain file holding that profile.
//                           Leave unset when the profile lives in the data
//                           protection keychain, which is notarytool's own
//                           default -- passing a login.keychain path there
//                           makes notarytool fail to find the profile.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

function run(command, args, { capture = true, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit'
  });
  const output = capture ? `${result.stdout ?? ''}${result.stderr ?? ''}` : '';
  if (result.status !== 0 && !allowFailure) {
    fail(`${command} ${args.join(' ')} exited with ${result.status}\n${output}`);
  }
  return { status: result.status, output };
}

// notarytool's `--keychain` is optional: when omitted it reads the profile
// from the data protection keychain. Only pass it when the caller really has
// the profile in a file-backed keychain.
function notaryAuthArgs() {
  const profile = process.env.APPLE_KEYCHAIN_PROFILE;
  if (!profile) {
    fail('APPLE_KEYCHAIN_PROFILE is not set -- refusing to build a release that would silently skip notarization.');
  }
  const args = ['--keychain-profile', profile];
  if (process.env.APPLE_KEYCHAIN) {
    args.push('--keychain', process.env.APPLE_KEYCHAIN);
  }
  return args;
}

function preflight() {
  const auth = notaryAuthArgs();

  const identities = run('security', ['find-identity', '-v', '-p', 'codesigning']).output;
  if (!identities.includes('Developer ID Application')) {
    fail('no "Developer ID Application" identity in the codesigning keychain.');
  }
  console.log('preflight: Developer ID Application identity present');

  const history = run('xcrun', ['notarytool', 'history', ...auth, '--output-format', 'json'], {
    allowFailure: true
  });
  if (history.status !== 0) {
    fail(`notarytool could not authenticate with the keychain profile:\n${history.output}`);
  }
  console.log(`preflight: notarytool profile "${process.env.APPLE_KEYCHAIN_PROFILE}" authenticates`);
}

function verifyApp(appPath) {
  if (!fs.existsSync(appPath)) fail(`signed app not found at ${appPath}`);

  const details = run('codesign', ['-dv', '--verbose=4', appPath]).output;
  const checks = [
    ['Developer ID Application authority', /Authority=Developer ID Application/],
    ['hardened runtime flag', /flags=0x[0-9a-f]*10000[0-9a-f]*\(.*runtime.*\)/],
    ['secure timestamp', /^Timestamp=/m],
    ['team identifier', /TeamIdentifier=[A-Z0-9]{10}/]
  ];
  for (const [label, pattern] of checks) {
    if (!pattern.test(details)) fail(`${appPath}: missing ${label}\n${details}`);
  }
  if (/adhoc/.test(details)) fail(`${appPath}: signature is ad-hoc`);
  console.log(`verify: ${path.basename(appPath)} carries a Developer ID signature with hardened runtime and a secure timestamp`);

  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  run('xcrun', ['stapler', 'validate', appPath]);
  console.log(`verify: ${path.basename(appPath)} passes codesign --verify, spctl and stapler validate`);

  // The text recognition helper sits in Resources, outside codesign's
  // --deep walk, and notarization rejects an unsigned binary anywhere.
  const ocrHelper = path.join(appPath, 'Contents/Resources/bin/metinbul-ocr');
  if (!fs.existsSync(ocrHelper)) fail(`text recognition helper not found at ${ocrHelper}`);
  const helperDetails = run('codesign', ['-dv', '--verbose=4', ocrHelper]).output;
  for (const [label, pattern] of checks) {
    if (!pattern.test(helperDetails)) fail(`${ocrHelper}: missing ${label}\n${helperDetails}`);
  }
  run('codesign', ['--verify', '--strict', '--verbose=2', ocrHelper]);
  run(ocrHelper, ['--check']);
  console.log('verify: metinbul-ocr carries the same signature and recognizes Turkish');
}

function notarizeAndStapleDmg(dmgPath) {
  const auth = notaryAuthArgs();
  if (!fs.existsSync(dmgPath)) fail(`DMG not found at ${dmgPath}`);

  const signature = run('codesign', ['-dv', '--verbose=2', dmgPath]).output;
  if (!/Authority=Developer ID Application/.test(signature)) {
    fail(`${dmgPath} is not signed with a Developer ID Application identity\n${signature}`);
  }

  console.log(`notarize: submitting ${path.basename(dmgPath)} ...`);
  const submit = run(
    'xcrun',
    ['notarytool', 'submit', dmgPath, ...auth, '--wait', '--output-format', 'json'],
    { allowFailure: true }
  );

  let result;
  try {
    result = JSON.parse(submit.output.trim().split('\n').filter(Boolean).pop());
  } catch {
    fail(`could not parse notarytool output:\n${submit.output}`);
  }

  const submissionId = result.id;
  console.log(`notarize: submission ${submissionId} -> ${result.status}`);

  if (result.status !== 'Accepted') {
    const log = run('xcrun', ['notarytool', 'log', submissionId, ...auth], { allowFailure: true });
    fail(`notarization was not Accepted (status: ${result.status}).\nApple log:\n${log.output}`);
  }

  run('xcrun', ['stapler', 'staple', dmgPath]);
  run('xcrun', ['stapler', 'validate', dmgPath]);
  run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmgPath]);
  console.log(`notarize: ${path.basename(dmgPath)} stapled, validated and accepted by Gatekeeper`);

  return submissionId;
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const appPath = path.join(rootDir, 'release/mac-arm64/MetinBul.app');
const dmgPath = path.join(rootDir, 'release/MetinBul-' +
  JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version + '-mac.dmg');

preflight();
run('npm', ['run', 'build'], { capture: false });
run('npx', ['electron-builder', '--mac', '--publish=never'], { capture: false });
verifyApp(appPath);
const submissionId = notarizeAndStapleDmg(dmgPath);

console.log('\nRelease artifact');
console.log(`  path          ${dmgPath}`);
console.log(`  sha256        ${sha256(dmgPath)}`);
console.log(`  dmg notarized ${submissionId} (Accepted)`);
