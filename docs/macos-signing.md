# macOS: Developer ID signing, notarization, stapling

MetinBul's macOS release is produced by electron-builder, signed with a real
`Developer ID Application` certificate, notarized by Apple and stapled. There
is no ad-hoc signing anywhere in the chain and no hand-rolled ZIP/DMG step.

## Producing a release

```bash
APPLE_KEYCHAIN_PROFILE="<notarytool profile name>" npm run release:mac
```

`scripts/mac-release.mjs` is the only supported entry point for a macOS
release. It is deliberately fail-closed:

1. **Preflight** — refuses to start unless a `Developer ID Application`
   identity is in the keychain *and* `xcrun notarytool` can authenticate with
   the given profile. Without this guard electron-builder would just log
   `skipped macOS notarization` and hand back an un-notarized DMG.
2. **Build** — `npm run build` then plain `electron-builder --mac`. The app is
   signed and notarized by electron-builder itself; nothing is re-signed by
   hand and `codesign --deep --sign` is never used.
3. **Verify the .app** — asserts Developer ID authority, the hardened-runtime
   flag, a secure timestamp and a team identifier, rejects an ad-hoc
   signature, then runs `codesign --verify --deep --strict`, `spctl --assess`
   and `stapler validate`.
4. **Notarize the DMG** — electron-builder notarizes the `.app` but not the
   DMG container, so the script submits the DMG itself, requires the status to
   be exactly `Accepted` (otherwise it prints Apple's `notarytool log` and
   exits non-zero), then staples and validates it.
5. **Report** — prints the artifact path, its SHA-256 and the DMG submission
   id.

`npm run package:mac` still exists for local packaging, but it is *not* a
release path: with no credentials in the environment electron-builder signs
the app and silently skips notarization.

## Credentials

Nothing secret lives in this repository. Authentication goes through a
`notarytool` keychain profile created once with `xcrun notarytool
store-credentials`; the profile already carries the Apple ID, app-specific
password and Team ID.

* `APPLE_KEYCHAIN_PROFILE` — **required**, the profile name.
* `APPLE_KEYCHAIN` — **optional, and normally must be left unset.**
  `notarytool` stores profiles in the data protection keychain by default,
  which has no file path you can pass here. Setting this to
  `~/Library/Keychains/login.keychain-db` makes notarytool fail with
  `No Keychain password item found for profile`. Only set it if the profile
  was explicitly stored into a file-backed keychain.

Check which case applies before setting it:

```bash
xcrun notarytool history --keychain-profile "<profile>"                       # data protection keychain
xcrun notarytool history --keychain-profile "<profile>" --keychain <path>     # file-backed keychain
```

## Entitlements

`build/entitlements.mac.plist` grants exactly one entitlement:

* `com.apple.security.cs.allow-jit` — V8 cannot run without it.

electron-builder's default template also grants
`com.apple.security.cs.allow-unsigned-executable-memory` and
`com.apple.security.cs.disable-library-validation`. Both were dropped and the
packaged, hardened build was verified to still work without them:

* `disable-library-validation` is unnecessary because electron-builder signs
  the unpacked native modules (`better-sqlite3`, `@napi-rs/canvas`) with the
  same Team ID as the app, so library validation accepts them. Verified by
  `vmmap` on the running packaged app — both `.node` binaries are mapped.
* `allow-unsigned-executable-memory` is unnecessary on the arm64 target; the
  app launches, indexes and searches without it.

Add an entitlement only after a packaged Hardened Runtime build is shown to
fail without it — not because a guide lists it.

## Verifying an artifact by hand

```bash
codesign -dv --verbose=4 /Applications/MetinBul.app
codesign --verify --deep --strict --verbose=2 /Applications/MetinBul.app
spctl --assess --type execute --verbose=4 /Applications/MetinBul.app
xcrun stapler validate /Applications/MetinBul.app
xcrun stapler validate release/MetinBul-<version>-mac.dmg
spctl --assess --type open --context context:primary-signature --verbose=4 release/MetinBul-<version>-mac.dmg
```

Expected: `Authority=Developer ID Application: ...`, `flags=0x10000(runtime)`,
a `Timestamp=` line, a 10-character `TeamIdentifier=`, and
`accepted / source=Notarized Developer ID`.
