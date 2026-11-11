// Windows' own text recognition (Windows.Media.Ocr), driven from Windows
// PowerShell 5.1 with the PDF pages rendered by Windows.Data.Pdf -- both part
// of Windows 10 and 11, so nothing is bundled. Turkish needs the system's
// Turkish OCR component; a Turkish Windows has it, others can add it
// (installWindowsTurkishOcr). Without it the English recognizer turns
// "Ortaklığın giderilmesi davası" into "Ortakllöln giderilmesi davasl", so it
// is not used at all.
//
// Input and output go through UTF-8 temp files: Windows PowerShell decodes
// stdin and encodes stdout with the console code page, which would corrupt
// Turkish characters (windows-availability.ts does the same for that reason).
// The script itself goes in as -EncodedCommand, which is UTF-16 and needs no
// quoting.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertContentLocallyAvailable, ContentNotLocallyAvailableError } from '../scanner/windows-availability.js';
import {
  OcrEngine, OCR_EXIT_CLOUD_ONLY, OCR_EXIT_NO_TURKISH, OCR_EXIT_UNREADABLE, ocrTimeoutMs, splitOcrPages
} from './ocr.js';

// 'unavailable': no Windows.Media.Ocr (or no Windows PowerShell) at all.
export type WindowsOcrStatus = 'ready' | 'no-turkish' | 'unavailable';

export const WINDOWS_TURKISH_OCR_CAPABILITY = 'Language.OCR~~~tr-TR~0.0.1.0';

const EXIT_NO_WINRT_OCR = 4;

function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildWindowsOcrScript(jobPath?: string): string {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    '  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null',
    '  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null',
    `} catch { exit ${EXIT_NO_WINRT_OCR} }`,
    "$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('tr'))",
    `if ($null -eq $engine) { exit ${OCR_EXIT_NO_TURKISH} }`
  ];
  if (!jobPath) return [...lines, 'exit 0'].join('\n');
  return [
    ...lines,
    '$m = [System.WindowsRuntimeSystemExtensions].GetMethods()',
    "$asTaskOp = $m | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1",
    "$asTaskAction = $m | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1",
    'function Await($op, [Type]$type) { $t = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }',
    'function AwaitAction($op) { $t = $asTaskAction.Invoke($null, @($op)); $t.Wait(-1) | Out-Null }',
    '[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null',
    `$job = Get-Content -LiteralPath ${psLiteral(jobPath)} -Raw -Encoding UTF8 | ConvertFrom-Json`,
    'try {',
    '  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($job.path)) ([Windows.Storage.StorageFile])',
    '  $doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])',
    `} catch { exit ${OCR_EXIT_UNREADABLE} }`,
    '$out = New-Object System.Text.StringBuilder',
    'foreach ($n in $job.pages) {',
    "  $text = ''",
    '  if ($n -le $doc.PageCount) {',
    '    $page = $doc.GetPage([uint32]($n - 1))',
    // About 300 dpi (Size is in 1/96 inch, rotation already applied), capped
    // below the recognizer's MaxImageDimension.
    '    $scale = [Math]::Min(300 / 96, 4000 / [Math]::Max($page.Size.Width, $page.Size.Height))',
    '    $options = [Windows.Data.Pdf.PdfPageRenderOptions]::new()',
    '    $options.DestinationWidth = [uint32]($page.Size.Width * $scale)',
    '    $options.DestinationHeight = [uint32]($page.Size.Height * $scale)',
    '    $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()',
    '    AwaitAction ($page.RenderToStreamAsync($stream, $options))',
    '    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
    '    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
    '    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
    '    $text = ($result.Lines | ForEach-Object { $_.Text }) -join "`n"',
    '  }',
    '  [void]$out.Append($text).Append([char]12)',
    '}',
    '[System.IO.File]::WriteAllText($job.out, $out.ToString(), [System.Text.UTF8Encoding]::new($false))',
    'exit 0'
  ].join('\n');
}

function runPowerShell(script: string, timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass',
          '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
      );
    } catch (error) {
      resolve({ code: null, stderr: String(error) });
      return;
    }
    let stderr = '';
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { stderr += String(error); finish(null); });
    child.on('close', code => finish(code));
  });
}

let jobCounter = 0;

export function createWindowsOcrEngine(): OcrEngine {
  return {
    async recognizePdfPages(filePath, pages) {
      // The same rule as the extractors: opening an online-only placeholder
      // would download it.
      await assertContentLocallyAvailable(filePath);
      const base = path.join(os.tmpdir(), `metinbul-ocr-${process.pid}-${jobCounter++}`);
      const jobPath = `${base}.json`;
      const outPath = `${base}.txt`;
      fs.writeFileSync(jobPath, JSON.stringify({ path: filePath, pages, out: outPath }), 'utf8');
      try {
        const { code, stderr } = await runPowerShell(buildWindowsOcrScript(jobPath), ocrTimeoutMs(pages.length));
        if (code === OCR_EXIT_CLOUD_ONLY) throw new ContentNotLocallyAvailableError(filePath);
        if (code !== 0) throw new Error(`Text recognition failed (${code ?? 'timeout'}): ${stderr.trim()}`);
        return splitOcrPages(fs.readFileSync(outPath, 'utf8'), pages.length);
      } finally {
        for (const file of [jobPath, outPath]) {
          try { fs.unlinkSync(file); } catch { /* best effort */ }
        }
      }
    }
  };
}

export async function checkWindowsOcr(): Promise<WindowsOcrStatus> {
  const { code } = await runPowerShell(buildWindowsOcrScript(), 60_000);
  if (code === 0) return 'ready';
  if (code === OCR_EXIT_NO_TURKISH) return 'no-turkish';
  return 'unavailable';
}

// Adds Windows' Turkish OCR component. Needs administrator rights, so Windows
// asks the user to approve (UAC), and Windows Update to download it.
export async function installWindowsTurkishOcr(): Promise<boolean> {
  const inner = `Add-WindowsCapability -Online -Name '${WINDOWS_TURKISH_OCR_CAPABILITY}' | Out-Null`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    "  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden " +
      `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${Buffer.from(inner, 'utf16le').toString('base64')}'`,
    '  exit $p.ExitCode',
    '} catch { exit 1 }'
  ].join('\n');
  const { code } = await runPowerShell(script, 15 * 60 * 1000);
  return code === 0;
}
