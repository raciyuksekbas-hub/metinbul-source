import { describe, it, expect, vi } from 'vitest';
import {
  compareVersions,
  checkForUpdates,
  GITHUB_REPO
} from '../src/main/updater.js';

describe('GitHub Release Update Checker', () => {
  describe('compareVersions', () => {
    it('should correctly compare semver versions', () => {
      expect(compareVersions('0.1.1', '0.1.0')).toBe(1);
      expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
      expect(compareVersions('0.2.0', '0.1.9')).toBe(1);
      expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
      expect(compareVersions('v0.1.0', '0.1.0')).toBe(0);
      expect(compareVersions('0.1.0', '0.1.1')).toBe(-1);
      expect(compareVersions('0.1.0', '1.0.0')).toBe(-1);
    });

    it('should handle version strings with v prefix and pre-release suffix', () => {
      expect(compareVersions('v0.1.5', 'v0.1.0')).toBe(1);
      expect(compareVersions('0.1.1-beta', '0.1.0')).toBe(1);
      expect(compareVersions('0.1.0-alpha', '0.1.0')).toBe(0);
    });
  });

  describe('checkForUpdates', () => {
    it('should detect update when a newer stable release is published', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v0.1.1',
          name: 'MetinBul v0.1.1',
          body: 'Yeni özellikler ve hata düzeltmeleri',
          html_url: 'https://github.com/raciyuksekbas-hub/metinbul-releases/releases/tag/v0.1.1',
          draft: false,
          prerelease: false,
          published_at: '2026-08-25T10:00:00Z'
        })
      });

      const result = await checkForUpdates('0.1.0', { fetchFn: mockFetch as any });

      expect(result.updateAvailable).toBe(true);
      expect(result.status).toBe('update_available');
      expect(result.latestVersion).toBe('0.1.1');
      expect(result.currentVersion).toBe('0.1.0');
      expect(result.releaseUrl).toContain('releases/tag/v0.1.1');
      expect(result.message).toContain('0.1.1');
    });

    it('should report up_to_date when installed version is equal to or newer than latest', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v0.1.0',
          name: 'MetinBul v0.1.0',
          draft: false,
          prerelease: false
        })
      });

      const resultEqual = await checkForUpdates('0.1.0', { fetchFn: mockFetch as any });
      expect(resultEqual.updateAvailable).toBe(false);
      expect(resultEqual.status).toBe('up_to_date');

      const resultNewer = await checkForUpdates('0.2.0', { fetchFn: mockFetch as any });
      expect(resultNewer.updateAvailable).toBe(false);
      expect(resultNewer.status).toBe('up_to_date');
    });

    it('should ignore draft or prerelease versions for stable updates', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v0.2.0-beta',
          draft: false,
          prerelease: true
        })
      });

      const result = await checkForUpdates('0.1.0', { fetchFn: mockFetch as any });
      expect(result.updateAvailable).toBe(false);
      expect(result.status).toBe('up_to_date');
    });

    it('should gracefully handle 404 / 401 private repo status without throwing', async () => {
      const mockFetch404 = vi.fn().mockResolvedValue({
        ok: false,
        status: 404
      });

      const result404 = await checkForUpdates('0.1.0', { fetchFn: mockFetch404 as any });
      expect(result404.updateAvailable).toBe(false);
      expect(result404.status).toBe('unreachable');
      expect(result404.message).toContain('erişilemedi');
    });

    it('should handle network failure / offline state without crashing the application', async () => {
      const mockFetchFail = vi.fn().mockRejectedValue(new Error('Network offline'));

      const result = await checkForUpdates('0.1.0', { fetchFn: mockFetchFail as any });
      expect(result.updateAvailable).toBe(false);
      expect(result.status).toBe('unreachable');
      expect(result.message).toContain('bağlanılamadı');
    });
  });
});
