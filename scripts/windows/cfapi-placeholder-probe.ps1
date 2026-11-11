<#
.SYNOPSIS
  Determines whether this Windows machine can produce a REAL dehydrated cloud
  placeholder -- one carrying FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS -- without
  any cloud account or credentials, and if so verifies that MetinBul's indexer
  leaves it dehydrated.

.DESCRIPTION
  FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS (0x400000) is documented as settable by
  kernel-mode callers only, so a test process cannot fake it. The only way to
  obtain a genuine one without OneDrive is to register a sync root with the
  Cloud Files API (cldflt.sys) and create a placeholder through it -- exactly
  what OneDrive Files On-Demand does underneath.

  This script is a capability probe, not a pass/fail gate. It reports one of:

    CFAPI_PROBE_RESULT=PLACEHOLDER_VERIFIED   real placeholder created and the
                                              hydration-state invariant held
    CFAPI_PROBE_RESULT=PLACEHOLDER_FAILED     placeholder created but MetinBul
                                              did not behave correctly
    CFAPI_PROBE_RESULT=UNAVAILABLE            this machine cannot create one

  UNAVAILABLE is an honest "not proven here", never a pass.

.NOTES
  Requires elevation. Cleans up the sync root it registers.
#>

$ErrorActionPreference = 'Stop'

$FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000

function Write-Result([string]$value, [string]$detail) {
  Write-Host ""
  Write-Host "CFAPI_PROBE_RESULT=$value"
  Write-Host "CFAPI_PROBE_DETAIL=$detail"
  if ($env:GITHUB_OUTPUT) {
    "result=$value"  | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
    "detail=$detail" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
  }
}

Write-Host "=== Stage 1: is the Cloud Files minifilter present? ==="
try {
  $svc = Get-Service -Name CldFlt -ErrorAction Stop
  Write-Host "CldFlt service: Status=$($svc.Status) StartType=$($svc.StartType)"
  if ($svc.Status -ne 'Running') {
    Write-Host "Attempting to start CldFlt..."
    try {
      Start-Service -Name CldFlt -ErrorAction Stop
      Write-Host "CldFlt started."
    } catch {
      Write-Host "Could not start CldFlt: $($_.Exception.Message)"
    }
  }
} catch {
  Write-Result 'UNAVAILABLE' "CldFlt service not present on this image: $($_.Exception.Message)"
  exit 0
}

Write-Host ""
Write-Host "Loaded filters:"
try { fltmc filters | Out-String | Write-Host } catch { Write-Host "fltmc unavailable" }

Write-Host ""
Write-Host "=== Stage 2/3: register a sync root and create a dehydrated placeholder ==="

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CfApi
{
    [StructLayout(LayoutKind.Sequential)]
    public struct CF_SYNC_REGISTRATION
    {
        public uint StructSize;
        [MarshalAs(UnmanagedType.LPWStr)] public string ProviderName;
        [MarshalAs(UnmanagedType.LPWStr)] public string ProviderVersion;
        public IntPtr SyncRootIdentity;
        public uint SyncRootIdentityLength;
        public IntPtr FileIdentity;
        public uint FileIdentityLength;
        public IntPtr ProviderId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CF_HYDRATION_POLICY { public ushort Primary; public ushort Modifier; }

    [StructLayout(LayoutKind.Sequential)]
    public struct CF_POPULATION_POLICY { public ushort Primary; public ushort Modifier; }

    [StructLayout(LayoutKind.Sequential)]
    public struct CF_SYNC_POLICIES
    {
        public uint StructSize;
        public CF_HYDRATION_POLICY Hydration;
        public CF_POPULATION_POLICY Population;
        public uint InSync;
        public uint HardLink;
        public uint PlaceholderManagement;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct FILE_BASIC_INFO
    {
        public long CreationTime;
        public long LastAccessTime;
        public long LastWriteTime;
        public long ChangeTime;
        public uint FileAttributes;
        public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CF_FS_METADATA
    {
        public FILE_BASIC_INFO BasicInfo;
        public long FileSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CF_PLACEHOLDER_CREATE_INFO
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string RelativeFileName;
        public CF_FS_METADATA FsMetadata;
        public IntPtr FileIdentity;
        public uint FileIdentityLength;
        public uint Flags;
        public int Result;
        public long CreateUsn;
    }

    [DllImport("cldapi.dll", CharSet = CharSet.Unicode)]
    public static extern int CfRegisterSyncRoot(
        string SyncRootPath,
        ref CF_SYNC_REGISTRATION Registration,
        ref CF_SYNC_POLICIES Policies,
        uint RegisterFlags);

    [StructLayout(LayoutKind.Sequential)]
    public struct CF_CALLBACK_REGISTRATION
    {
        public uint Type;
        public IntPtr Callback;
    }

    [DllImport("cldapi.dll", CharSet = CharSet.Unicode)]
    public static extern int CfUnregisterSyncRoot(string SyncRootPath);

    [DllImport("cldapi.dll", CharSet = CharSet.Unicode)]
    public static extern int CfConnectSyncRoot(
        string SyncRootPath,
        [In] CF_CALLBACK_REGISTRATION[] CallbackTable,
        IntPtr CallbackContext,
        uint ConnectFlags,
        out long ConnectionKey);

    [DllImport("cldapi.dll")]
    public static extern int CfDisconnectSyncRoot(long ConnectionKey);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetLongPathNameW(string lpszShortPath, System.Text.StringBuilder lpszLongPath, uint cchBuffer);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("cldapi.dll")]
    public static extern int CfConvertToPlaceholder(
        IntPtr FileHandle,
        IntPtr FileIdentity,
        uint FileIdentityLength,
        uint ConvertFlags,
        IntPtr ConvertUsn,
        IntPtr Overlapped);

    [DllImport("cldapi.dll", CharSet = CharSet.Unicode)]
    public static extern int CfCreatePlaceholders(
        string BaseDirectoryPath,
        [In, Out] CF_PLACEHOLDER_CREATE_INFO[] PlaceholderArray,
        uint PlaceholderCount,
        uint CreateFlags,
        out uint EntriesProcessed);
}
'@

# The sync root must be a real long path. $env:TEMP on a CI runner resolves to
# an 8.3 short name (C:\Users\RUNNER~1\...), which CFAPI rejects, so prefer an
# explicitly long location and expand any short components that remain.
$syncRootBase = if ($env:RUNNER_TEMP -and (Test-Path $env:RUNNER_TEMP)) { $env:RUNNER_TEMP } else { $env:TEMP }
$syncRoot = Join-Path $syncRootBase ("metinbul-cfapi-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $syncRoot -Force | Out-Null

$longBuffer = New-Object System.Text.StringBuilder 32768
$longLength = [CfApi]::GetLongPathNameW($syncRoot, $longBuffer, 32768)
if ($longLength -gt 0) { $syncRoot = $longBuffer.ToString() }
Write-Host "Sync root: $syncRoot"
Write-Host "Volume filesystem: $((Get-Volume -DriveLetter $syncRoot.Substring(0,1)).FileSystemType)"

$registered = $false
$connected = $false
$connectionKey = [long]0
try {
  $reg = New-Object CfApi+CF_SYNC_REGISTRATION
  $reg.StructSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type]'CfApi+CF_SYNC_REGISTRATION')
  $reg.ProviderName = 'MetinBulPlaceholderProbe'
  $reg.ProviderVersion = '1.0'
  $reg.SyncRootIdentity = [IntPtr]::Zero
  $reg.SyncRootIdentityLength = 0
  $reg.FileIdentity = [IntPtr]::Zero
  $reg.FileIdentityLength = 0
  $reg.ProviderId = [IntPtr]::Zero

  $pol = New-Object CfApi+CF_SYNC_POLICIES
  $pol.StructSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type]'CfApi+CF_SYNC_POLICIES')
  $pol.Hydration.Primary = 1          # CF_HYDRATION_POLICY_PROGRESSIVE
  $pol.Hydration.Modifier = 0
  $pol.Population.Primary = 2         # CF_POPULATION_POLICY_FULL
  $pol.Population.Modifier = 0
  $pol.InSync = 0
  $pol.HardLink = 0
  $pol.PlaceholderManagement = 0

  $hr = [CfApi]::CfRegisterSyncRoot($syncRoot, [ref]$reg, [ref]$pol, 0)
  Write-Host ("CfRegisterSyncRoot -> 0x{0:X8}" -f $hr)
  if ($hr -ne 0) {
    Write-Result 'UNAVAILABLE' ("CfRegisterSyncRoot failed with 0x{0:X8}" -f $hr)
    exit 0
  }
  $registered = $true

  # CfCreatePlaceholders is serviced by the filter driver on behalf of a live
  # provider, so the sync root has to be connected first. We register only the
  # terminating entry: this probe must never service a hydration request, and
  # an unhandled FETCH_DATA is exactly the behaviour we want if one ever fires.
  $callbacks = New-Object 'CfApi+CF_CALLBACK_REGISTRATION[]' 1
  $terminator = New-Object CfApi+CF_CALLBACK_REGISTRATION
  $terminator.Type = [uint32]::MaxValue  # CF_CALLBACK_TYPE_NONE
  $terminator.Callback = [IntPtr]::Zero
  $callbacks[0] = $terminator

  $connectionKey = [long]0
  $hrConnect = [CfApi]::CfConnectSyncRoot($syncRoot, $callbacks, [IntPtr]::Zero, 0, [ref]$connectionKey)
  Write-Host ("CfConnectSyncRoot -> 0x{0:X8}" -f $hrConnect)
  if ($hrConnect -eq 0) { $connected = $true }

  # If CldFlt never attaches an instance to the volume, the API is registered
  # but not actually servicing anything on this image.
  Write-Host "Filter instances after connect:"
  try { fltmc instances -f CldFlt | Out-String | Write-Host } catch { Write-Host "  (fltmc instances failed)" }

  # A placeholder with a non-zero FileSize and no content is dehydrated: its
  # data lives "in the cloud" as far as the filter driver is concerned.
  $info = New-Object 'CfApi+CF_PLACEHOLDER_CREATE_INFO[]' 1
  $entry = New-Object CfApi+CF_PLACEHOLDER_CREATE_INFO
  $entry.RelativeFileName = 'cevrimici_dilekce.docx'
  $now = [DateTime]::UtcNow.ToFileTimeUtc()
  $entry.FsMetadata.BasicInfo.CreationTime = $now
  $entry.FsMetadata.BasicInfo.LastAccessTime = $now
  $entry.FsMetadata.BasicInfo.LastWriteTime = $now
  $entry.FsMetadata.BasicInfo.ChangeTime = $now
  $entry.FsMetadata.BasicInfo.FileAttributes = 0x80   # FILE_ATTRIBUTE_NORMAL
  $entry.FsMetadata.FileSize = 65536
  $entry.FileIdentity = [IntPtr]::Zero
  $entry.FileIdentityLength = 0
  $entry.Flags = 2                                    # MARK_IN_SYNC
  $info[0] = $entry

  $processed = 0
  $hr2 = [CfApi]::CfCreatePlaceholders($syncRoot, $info, 1, 0, [ref]$processed)
  Write-Host ("CfCreatePlaceholders -> 0x{0:X8} (entries processed: {1}, entry result: 0x{2:X8})" -f $hr2, $processed, $info[0].Result)

  if ($hr2 -ne 0 -or $info[0].Result -ne 0) {
    # Retry without MARK_IN_SYNC in case the flag is what the driver rejected.
    Write-Host "Retrying CfCreatePlaceholders with CF_PLACEHOLDER_CREATE_FLAG_NONE..."
    $entry.Flags = 0
    $info[0] = $entry
    $processed = 0
    $hr2 = [CfApi]::CfCreatePlaceholders($syncRoot, $info, 1, 0, [ref]$processed)
    Write-Host ("CfCreatePlaceholders (retry) -> 0x{0:X8} (entries processed: {1}, entry result: 0x{2:X8})" -f $hr2, $processed, $info[0].Result)
  }

  $placeholder = Join-Path $syncRoot 'cevrimici_dilekce.docx'

  if ($hr2 -ne 0 -or $info[0].Result -ne 0) {
    # Route B: create a real file and convert it into a DEHYDRATED placeholder.
    # This is the "user freed up space on an already-synced file" transition and
    # avoids the struct-array marshalling that route A depends on.
    Write-Host ""
    Write-Host "Route A failed. Trying CfConvertToPlaceholder on a real file..."
    [System.IO.File]::WriteAllBytes($placeholder, (New-Object byte[] 65536))

    $GENERIC_READ_WRITE = [uint32]3221225472  # GENERIC_READ | GENERIC_WRITE
    $OPEN_EXISTING = 3
    $handle = [CfApi]::CreateFileW($placeholder, $GENERIC_READ_WRITE, 0, [IntPtr]::Zero, $OPEN_EXISTING, 0x02000000, [IntPtr]::Zero)
    if ($handle -eq [IntPtr]::new(-1)) {
      Write-Result 'UNAVAILABLE' "CreateFileW on the sync-root file failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
      exit 0
    }

    try {
      # CF_CONVERT_FLAG_MARK_IN_SYNC (1) | CF_CONVERT_FLAG_DEHYDRATE (2)
      $hr3 = [CfApi]::CfConvertToPlaceholder($handle, [IntPtr]::Zero, 0, 3, [IntPtr]::Zero, [IntPtr]::Zero)
      Write-Host ("CfConvertToPlaceholder -> 0x{0:X8}" -f $hr3)
    } finally {
      [CfApi]::CloseHandle($handle) | Out-Null
    }

    if ($hr3 -ne 0) {
      Write-Result 'UNAVAILABLE' ("Neither route produced a placeholder (create=0x{0:X8}, convert=0x{1:X8}, connect=0x{2:X8})" -f $hr2, $hr3, $hrConnect)
      exit 0
    }
  }
  $attrsBefore = [int][System.IO.File]::GetAttributes($placeholder)
  Write-Host ("Placeholder attributes: 0x{0:X8}" -f $attrsBefore)

  if (($attrsBefore -band $FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) -eq 0) {
    Write-Result 'UNAVAILABLE' ("Created file is not dehydrated (attributes 0x{0:X8} lack RECALL_ON_DATA_ACCESS)" -f $attrsBefore)
    exit 0
  }

  Write-Host ""
  Write-Host "=== Stage 4: a REAL dehydrated placeholder exists. Run MetinBul's indexer over it. ==="

  # Drive the real pipeline: scanner guard -> indexer -> extractor boundary.
  # The assertions live in tests/windows_real_fs.test.ts, which activates its
  # CFAPI block only when this variable points at a real sync root.
  $env:METINBUL_CFAPI_SYNC_ROOT = $syncRoot
  npx vitest run tests/windows_real_fs.test.ts
  $indexExit = $LASTEXITCODE
  Write-Host "Indexer harness exit code: $indexExit"

  $attrsAfter = [int][System.IO.File]::GetAttributes($placeholder)
  Write-Host ("Placeholder attributes after indexing: 0x{0:X8}" -f $attrsAfter)

  $stillDehydrated = ($attrsAfter -band $FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) -ne 0
  Write-Host "HYDRATION_STATE_BEFORE == HYDRATION_STATE_AFTER : $($attrsBefore -eq $attrsAfter)"
  Write-Host "Still dehydrated                                : $stillDehydrated"

  if ($indexExit -eq 0 -and $stillDehydrated -and $attrsBefore -eq $attrsAfter) {
    Write-Result 'PLACEHOLDER_VERIFIED' 'Real dehydrated placeholder stayed dehydrated across a full index run'
  } else {
    Write-Result 'PLACEHOLDER_FAILED' ("indexExit=$indexExit stillDehydrated=$stillDehydrated before=0x{0:X8} after=0x{1:X8}" -f $attrsBefore, $attrsAfter)
    exit 1
  }
}
finally {
  if ($connected) {
    try { [CfApi]::CfDisconnectSyncRoot($connectionKey) | Out-Null } catch { }
  }
  if ($registered) {
    try { [CfApi]::CfUnregisterSyncRoot($syncRoot) | Out-Null } catch { }
  }
  try { Remove-Item -LiteralPath $syncRoot -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}
