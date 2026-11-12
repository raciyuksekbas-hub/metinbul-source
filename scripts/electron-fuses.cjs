// electron-builder afterPack hook: switches off the parts of the Electron
// binary MetinBul never uses, before the app is signed.
//
// Why it matters on macOS: the user grants MetinBul access to Desktop,
// Documents, iCloud Drive or the whole disk, and macOS ties that grant to
// MetinBul's signature. With these fuses left on, any program running as the
// user could start MetinBul's own binary as a plain Node.js interpreter
// (ELECTRON_RUN_AS_NODE, NODE_OPTIONS) or attach a debugger to it (--inspect)
// and read those folders under MetinBul's name. The asar fuses make the app
// load only its own, integrity-checked app.asar.
//
// Windows is left as it is for now: it has no per-app folder grants to
// borrow, and the packaged-app smoke test in CI drives MetinBul through
// --inspect.
exports.default = async function flipElectronFuses(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const fuses = await context.packager.generateFuseConfig({
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
    // Flipping a fuse breaks the ad-hoc signature of an arm64 binary;
    // electron-builder signs the app properly afterwards.
    resetAdHocDarwinSignature: true
  });
  await context.packager.addElectronFuses(context, fuses);
};
