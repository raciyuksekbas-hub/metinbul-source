import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { AppDatabase } from '../src/db/database.js';
import { indexFolders } from '../src/search/indexer.js';
import { FIXTURES_DIR, setupFixtures } from './fixtures/create_fixtures.js';

// main.ts's resolveShouldShowOnboarding() is Electron-glue code (imports
// `app`), so it can't be unit-tested directly without a running Electron
// process. This mirrors its exact decision logic against the same
// AppDatabase primitives it calls (isOnboardingCompleted/setOnboardingCompleted/
// getAllDocumentPaths/getSearchAreas), so the underlying rule is proven at
// the unit level; the full IPC wiring is covered by the packaged smoke pass.
function resolveShouldShowOnboarding(appDb: AppDatabase): boolean {
  if (appDb.isOnboardingCompleted()) {
    return false;
  }
  const hasExistingUsage = appDb.getAllDocumentPaths().length > 0 || appDb.getSearchAreas().length > 0;
  if (hasExistingUsage) {
    appDb.setOnboardingCompleted();
    return false;
  }
  return true;
}

describe('First-Run Onboarding (spec §1)', () => {
  let db: AppDatabase;
  const tempDbPath = path.join(FIXTURES_DIR, 'onboarding_test.db');
  const testBaseDir = path.join(FIXTURES_DIR, 'test_onboarding_ws');

  beforeAll(() => {
    setupFixtures();
  });

  beforeEach(() => {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true });
    fs.mkdirSync(testBaseDir, { recursive: true });
    db = new AppDatabase(tempDbPath);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(testBaseDir)) fs.rmSync(testBaseDir, { recursive: true, force: true });
  });

  it('a genuinely fresh install (no documents, no search areas, flag unset) triggers onboarding', () => {
    expect(resolveShouldShowOnboarding(db)).toBe(true);
  });

  it('a pre-existing v0.2.0 user with indexed documents does NOT get onboarding, and the flag is silently set', async () => {
    const folder = path.join(testBaseDir, 'Desktop');
    fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(path.join(FIXTURES_DIR, 'sample.docx'), path.join(folder, 'a.docx'));
    await indexFolders([folder], db);

    expect(db.isOnboardingCompleted()).toBe(false); // upgrader never had this flag written
    expect(resolveShouldShowOnboarding(db)).toBe(false);
    expect(db.isOnboardingCompleted()).toBe(true); // now silently marked so it never re-triggers
  });

  it('a pre-existing v0.2.0 user with only search_areas configured (no documents yet) does NOT get onboarding', () => {
    const folder = path.join(testBaseDir, 'Documents');
    fs.mkdirSync(folder, { recursive: true });
    db.setSearchScopeMode('selected');
    db.addSearchArea(folder, 'include');

    expect(resolveShouldShowOnboarding(db)).toBe(false);
    expect(db.isOnboardingCompleted()).toBe(true);
  });

  it('once completed, onboarding never re-triggers even if documents/search_areas are later cleared', () => {
    db.setOnboardingCompleted();
    expect(resolveShouldShowOnboarding(db)).toBe(false);
    // Even on a DB with nothing in it otherwise.
    expect(db.getAllDocumentPaths().length).toBe(0);
    expect(db.getSearchAreas().length).toBe(0);
    expect(resolveShouldShowOnboarding(db)).toBe(false);
  });

  it('completing onboarding with "selected" mode persists scope + chosen folders and flips the flag', () => {
    const folderA = path.join(testBaseDir, 'FolderA');
    fs.mkdirSync(folderA, { recursive: true });

    // Simulates app:completeOnboarding('selected', [folderA])
    db.setSearchScopeMode('selected');
    db.addSearchArea(folderA, 'include');
    db.setOnboardingCompleted();

    expect(db.getSearchScopeMode()).toBe('selected');
    expect(db.getIncludedFolders()).toEqual([path.resolve(folderA)]);
    expect(db.isOnboardingCompleted()).toBe(true);
    expect(resolveShouldShowOnboarding(db)).toBe(false);
  });

  it('completing onboarding with "all" mode persists scope and flips the flag without adding any folders', () => {
    db.setSearchScopeMode('all');
    db.setOnboardingCompleted();

    expect(db.getSearchScopeMode()).toBe('all');
    expect(db.getSearchAreas().length).toBe(0);
    expect(resolveShouldShowOnboarding(db)).toBe(false);
  });
});
