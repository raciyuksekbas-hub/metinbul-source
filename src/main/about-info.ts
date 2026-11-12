import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Verified developer & feedback contact details from repository metadata
export const DEVELOPER_NAME = 'Raci Çetin Yüksekbaş';
export const FEEDBACK_EMAIL = 'raci@yuksekbas.av.tr';

export interface AboutMetadata {
  name: string;
  version: string;
  shortDescription: string;
  copyright: string;
  copyrightNote: string;
  developerName: string;
  // The source commit the app was built from (scripts/build.mjs).
  build?: BuildInfo;
  feedback: {
    text: string;
    email: string;
    mailtoUrl: string;
  };
}

export interface BuildInfo {
  commit: string;
  dirty: boolean;
}

export function getBuildInfo(): BuildInfo | undefined {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'build-info.json'), 'utf-8'));
    if (typeof info.commit === 'string' && /^[0-9a-f]{7,40}$|^unknown$/.test(info.commit)) {
      return { commit: info.commit, dirty: info.dirty === true };
    }
  } catch {
    // Run from the sources (tests): no build info.
  }
  return undefined;
}

export function getPackageVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    
    // Search in parent paths for package.json
    let currentDir = __dirname;
    for (let i = 0; i < 4; i++) {
      const pkgPath = path.join(currentDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.version) {
          return pkg.version;
        }
      }
      currentDir = path.dirname(currentDir);
    }
  } catch {
    // Fallback if filesystem read fails
  }
  return '0.1.0';
}

export function getCopyrightText(currentYear: number = new Date().getFullYear()): string {
  if (currentYear > 2026) {
    return `© 2026–${currentYear} ${DEVELOPER_NAME}. Tüm hakları saklıdır.`;
  }
  return `© 2026 ${DEVELOPER_NAME}. Tüm hakları saklıdır.`;
}

export function getFeedbackMailto(version: string = getPackageVersion()): string {
  const subject = encodeURIComponent('MetinBul Geribildirim');
  const body = encodeURIComponent(`MetinBul sürümü: ${version}\n\n`);
  return `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`;
}

export function getAboutMetadata(): AboutMetadata {
  const version = getPackageVersion();
  const mailtoUrl = getFeedbackMailto(version);

  return {
    name: 'MetinBul',
    version,
    shortDescription: 'Bilgisayarınızdaki DOC, DOCX, PDF ve UDF belgelerinin metin içeriklerinde yerel olarak arama yapan masaüstü aracı.',
    copyright: getCopyrightText(),
    copyrightNote: 'MetinBul’un kaynak kodu, görsel kimliği ve dağıtım paketleri üzerindeki haklar saklıdır.',
    developerName: DEVELOPER_NAME,
    build: getBuildInfo(),
    feedback: {
      text: 'MetinBul ile ilgili hata bildirimlerinizi, önerilerinizi ve kullanım deneyiminizi paylaşabilirsiniz.',
      email: FEEDBACK_EMAIL,
      mailtoUrl
    }
  };
}
