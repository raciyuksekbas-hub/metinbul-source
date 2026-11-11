// MetinBul's text recognition helper for macOS. Reads a PDF that has no text
// layer -- a scanned document -- and prints the text macOS's own on-device
// recognition (Vision, the engine behind Live Text) finds on its pages.
// Nothing leaves the Mac.
//
//   metinbul-ocr --check                       exit 0 when Turkish recognition
//                                              is available
//   metinbul-ocr <file.pdf> [--pages 1,3,...]  the recognized text of the given
//                                              pages (all when omitted) on
//                                              stdout, each followed by a form
//                                              feed (U+000C)
//
// Exit codes: 0 done (the text may be empty), 1 usage, 2 the PDF cannot be
// opened, 3 no Turkish recognition on this macOS, 4 MetinBul went away,
// 5 the file's content is only in the cloud.
//
// Built by scripts/build.mjs and shipped in the app's Resources/bin.
import AppKit
import Foundation
import PDFKit
import Vision

let SF_DATALESS: UInt32 = 0x40000000
// About 300 dpi for an A4 page, and a cap on the long side so a poster-sized
// page cannot exhaust memory.
let pixelsPerPoint: CGFloat = 300 / 72
let maxSide: CGFloat = 4000

func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

func turkishSupported() -> Bool {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    let languages = (try? request.supportedRecognitionLanguages()) ?? []
    return languages.contains { $0.hasPrefix("tr") }
}

// MetinBul starts this helper for one document at a time. If MetinBul quits
// or is killed meanwhile, stop rather than finish a long document for no one.
var parentWatch: DispatchSourceTimer?
func watchParent() {
    let parent = getppid()
    let timer = DispatchSource.makeTimerSource(queue: .global())
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler { if getppid() != parent { exit(4) } }
    timer.resume()
    parentWatch = timer
}

// PDFKit's thumbnail honours the page's /Rotate; drawing the page into a
// context by hand does not, and a scanned page stored sideways then reads as
// nothing at all.
func render(_ page: PDFPage) -> CGImage? {
    let box = page.bounds(for: .mediaBox)
    let sideways = page.rotation % 180 != 0
    let width = sideways ? box.height : box.width
    let height = sideways ? box.width : box.height
    guard width > 0, height > 0 else { return nil }
    let scale = min(pixelsPerPoint, maxSide / max(width, height))
    let image = page.thumbnail(of: NSSize(width: width * scale, height: height * scale), for: .mediaBox)
    var rect = CGRect(origin: .zero, size: image.size)
    return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

func recognize(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["tr-TR"]
    request.usesLanguageCorrection = true
    do {
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    } catch {
        return ""
    }
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

let usage = "usage: metinbul-ocr --check | <file.pdf> [--pages 1,3,...]"
let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 1 || (arguments.count == 3 && arguments[1] == "--pages") else { fail(1, usage) }
guard turkishSupported() else { fail(3, "Turkish text recognition is not available on this macOS") }
if arguments[0] == "--check" {
    print("ok")
    exit(0)
}

let filePath = arguments[0]
// 1-based page numbers, as MetinBul counts them.
var requestedPages: [Int]?
if arguments.count == 3 {
    let numbers = arguments[2].split(separator: ",").map { Int($0.trimmingCharacters(in: .whitespaces)) }
    guard !numbers.isEmpty, numbers.allSatisfy({ ($0 ?? 0) > 0 }) else { fail(1, usage) }
    requestedPages = numbers.map { $0! }
}
// The same rule as the scanner: never open a file whose content is only in
// the cloud, since reading it would download it.
var info = stat()
if stat(filePath, &info) == 0 && (info.st_flags & SF_DATALESS) != 0 {
    fail(5, "the file's content is only in the cloud")
}
watchParent()

guard let document = PDFDocument(url: URL(fileURLWithPath: filePath)) else { fail(2, "cannot open the PDF") }
if document.isLocked && !document.unlock(withPassword: "") { fail(2, "the PDF is password protected") }

// One entry per requested page, in order, so MetinBul can put each page's
// text back in its place; a page that does not exist reads as empty.
let output = FileHandle.standardOutput
for number in requestedPages ?? Array(1...max(document.pageCount, 1)) {
    autoreleasepool {
        var text = ""
        if number <= document.pageCount, let page = document.page(at: number - 1), let image = render(page) {
            text = recognize(image)
        }
        output.write(Data((text + "\u{0C}").utf8))
    }
}
exit(0)
