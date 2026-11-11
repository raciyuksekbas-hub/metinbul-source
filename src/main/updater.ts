/**
 * MetinBul GitHub Release Update Checker
 * 
 * Safely checks for new releases on GitHub without requiring tokens or credentials.
 * Handles private repos, network errors, and semver comparison gracefully.
 */

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseUrl?: string;
  publishedAt?: string;
  status: 'update_available' | 'up_to_date' | 'unreachable' | 'error';
  message?: string;
}

export interface GitHubReleasePayload {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
}

export const GITHUB_REPO = 'raciyuksekbas-hub/metinbul-releases';

/**
 * Compare two semver strings (e.g. '0.1.0' vs '0.1.1').
 * Returns:
 *   1 if v1 > v2
 *  -1 if v1 < v2
 *   0 if v1 === v2
 */
export function compareVersions(v1: string, v2: string): number {
  const clean1 = (v1 || '').replace(/^[vV]/, '').trim();
  const clean2 = (v2 || '').replace(/^[vV]/, '').trim();

  const parts1 = clean1.split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const parts2 = clean2.split('-')[0].split('.').map(n => parseInt(n, 10) || 0);

  const maxLen = Math.max(parts1.length, parts2.length, 3);
  for (let i = 0; i < maxLen; i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }

  return 0;
}

/**
 * Check GitHub Releases for updates.
 * Does not require credentials; gracefully reports if repo is private or unreachable.
 */
export async function checkForUpdates(
  currentVersion: string,
  options?: {
    repo?: string;
    fetchFn?: typeof fetch;
  }
): Promise<UpdateCheckResult> {
  const repo = options?.repo || GITHUB_REPO;
  const fetchImpl = options?.fetchFn || globalThis.fetch;

  if (!fetchImpl) {
    return {
      updateAvailable: false,
      currentVersion,
      status: 'unreachable',
      message: 'Ağ istemcisi bulunamadı.'
    };
  }

  const url = `https://api.github.com/repos/${repo}/releases/latest`;

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': `MetinBul-App/${currentVersion}`
      }
    });

    if (response.status === 404 || response.status === 401 || response.status === 403) {
      // Private repository, rate limited, or no releases published yet
      return {
        updateAvailable: false,
        currentVersion,
        status: 'unreachable',
        message: 'GitHub sürüm bilgisine erişilemedi (Depo özel veya henüz release yayınlanmamış).'
      };
    }

    if (!response.ok) {
      return {
        updateAvailable: false,
        currentVersion,
        status: 'unreachable',
        message: `Güncelleme kontrolü başarısız oldu (HTTP ${response.status}).`
      };
    }

    const data = await response.json() as GitHubReleasePayload;

    if (!data || typeof data !== 'object') {
      return {
        updateAvailable: false,
        currentVersion,
        status: 'error',
        message: 'Geçersiz sunucu yanıtı.'
      };
    }

    // Ignore drafts or prereleases for stable updates
    if (data.draft || data.prerelease) {
      return {
        updateAvailable: false,
        currentVersion,
        status: 'up_to_date',
        message: `MetinBul güncel (v${currentVersion}).`
      };
    }

    const rawTag = data.tag_name || data.name || '';
    const latestVersion = rawTag.replace(/^[vV]/, '').trim();

    if (!latestVersion) {
      return {
        updateAvailable: false,
        currentVersion,
        status: 'up_to_date',
        message: `MetinBul güncel (v${currentVersion}).`
      };
    }

    const comparison = compareVersions(latestVersion, currentVersion);

    if (comparison > 0) {
      return {
        updateAvailable: true,
        currentVersion,
        latestVersion,
        releaseName: data.name || `MetinBul ${latestVersion}`,
        releaseNotes: data.body || '',
        releaseUrl: data.html_url || `https://github.com/${repo}/releases/tag/${rawTag}`,
        publishedAt: data.published_at,
        status: 'update_available',
        message: `MetinBul ${latestVersion} kullanılabilir.`
      };
    }

    return {
      updateAvailable: false,
      currentVersion,
      latestVersion,
      status: 'up_to_date',
      message: `MetinBul güncel (v${currentVersion}).`
    };
  } catch (error: any) {
    return {
      updateAvailable: false,
      currentVersion,
      status: 'unreachable',
      message: 'Güncelleme sunucusuna bağlanılamadı.'
    };
  }
}
