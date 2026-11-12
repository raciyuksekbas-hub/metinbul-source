import { describe, it, expect } from 'vitest';
import {
  getPackageVersion,
  getCopyrightText,
  getFeedbackMailto,
  getAboutMetadata,
  DEVELOPER_NAME,
  FEEDBACK_EMAIL
} from '../src/main/about-info.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Read from package.json instead of hard-coding the number: the assertion is
// "about-info reports what package.json says", and a literal here turns every
// routine version bump into a spurious test failure.
const PACKAGE_VERSION: string = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json'),
    'utf-8'
  )
).version;

describe('Simplified About Info & Metadata', () => {
  it('should return package version matching package.json', () => {
    const version = getPackageVersion();
    expect(version).toBe(PACKAGE_VERSION);
    // Still guard the shape, which the literal used to cover implicitly.
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('should generate correct copyright text for 2026 and future years', () => {
    const text2026 = getCopyrightText(2026);
    expect(text2026).toBe('© 2026 Raci Çetin Yüksekbaş');

    const textFuture = getCopyrightText(2028);
    expect(textFuture).toBe('© 2026–2028 Raci Çetin Yüksekbaş');
  });

  it('should generate verified mailto URL with correct email, subject and dynamic version', () => {
    const mailto = getFeedbackMailto('0.2.0');
    expect(mailto).toBe('mailto:raci@yuksekbas.av.tr?subject=MetinBul%20Geribildirim&body=MetinBul%20s%C3%BCr%C3%BCm%C3%BC%3A%200.2.0%0A%0A');
    expect(mailto).toContain(`mailto:${FEEDBACK_EMAIL}`);
    expect(mailto).toContain('subject=MetinBul%20Geribildirim');
    expect(mailto).toContain('body=MetinBul%20s%C3%BCr%C3%BCm%C3%BC%3A%200.2.0');

    // Dynamic version
    const mailto2 = getFeedbackMailto('0.2.5');
    expect(mailto2).toContain('body=MetinBul%20s%C3%BCr%C3%BCm%C3%BC%3A%200.2.5');
  });

  it('should return complete simplified AboutMetadata structure without profession or legaltech mentions', () => {
    const meta = getAboutMetadata();
    expect(meta.name).toBe('MetinBul');
    expect(meta.version).toBe(PACKAGE_VERSION);
    expect(meta.developerName).toBe(DEVELOPER_NAME);
    expect(meta.feedback.email).toBe(FEEDBACK_EMAIL);
    expect(meta.feedback.mailtoUrl).toBeDefined();
    expect(meta.feedback.mailtoUrl).toContain(FEEDBACK_EMAIL);
    expect(meta.shortDescription).toContain('DOC, DOCX, PDF ve UDF');
    // The About text must agree with LICENSE (MIT), not reserve all rights.
    expect(meta.copyrightNote).toContain('MIT lisansıyla');
    expect(meta.copyrightNote).toContain('garanti verilmeden');
    expect(JSON.stringify(meta)).not.toMatch(/haklar[ıi]? saklı/);
    
    // Ensure no unwanted titles or brand entities
    expect(JSON.stringify(meta)).not.toContain('Avukat');
    expect(JSON.stringify(meta)).not.toContain('Yazılım Geliştirici');
    expect(JSON.stringify(meta)).not.toContain('LegalTech');
  });
});
