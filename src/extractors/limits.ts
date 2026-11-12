// Resource limits for reading documents. Every document is untrusted input (it
// may come from a court, the other side or a client), so each parser works
// inside these bounds: a file that would need more fails on its own and is
// recorded as unreadable, instead of exhausting the indexer's memory or CPU.
//
// The values are generous for real legal files; the measured costs noted
// below are what an adversarial file can force at the limit.

const MiB = 1024 * 1024;

// --- Whole files, checked with stat before a single byte is read -----------

/** Largest PDF read. Scanned court files run to hundreds of MiB. */
export const PDF_MAX_FILE_BYTES = 512 * MiB;

/** Largest DOCX read (a ZIP package; images make up most of a big one). */
export const DOCX_MAX_FILE_BYTES = 256 * MiB;

/** Largest Word 97-2003 .doc read. */
export const DOC_MAX_FILE_BYTES = 256 * MiB;

/** Largest UDF read, as a ZIP or as a plain XML file. */
export const UDF_MAX_FILE_BYTES = 256 * MiB;

// --- ZIP packages (UDF and DOCX) --------------------------------------------

/** Entries in one archive. A UDF has a handful, a DOCX a few hundred. */
export const ZIP_MAX_ENTRIES = 10_000;

/** Bytes in one entry name. Real names are short paths like word/document.xml. */
export const ZIP_MAX_ENTRY_NAME_BYTES = 4096;

// --- UDF ---------------------------------------------------------------------

/**
 * UDF content.xml after decompression (or a plain XML .udf). The text itself
 * sits in one CDATA block; a big UDF's XML is a few MiB.
 */
export const UDF_MAX_XML_BYTES = 64 * MiB;

/**
 * Elements, CDATA sections and processing-instruction tokens in the UDF XML.
 * The parser keeps an object per node (measured 150-370 bytes each), so this
 * caps the tree at roughly 400 MiB. A 1000-page UDF has about 150 000.
 */
export const UDF_MAX_XML_NODES = 1_000_000;

/**
 * Characters the XML parser builds up one at a time: plain text between tags
 * (comments do not end a run) and tabs inside a tag. Each costs about 34 bytes
 * of transient memory, so 1 Mi characters is about 34 MiB. UDF keeps its text
 * in CDATA, which is not affected; plain text runs are whitespace.
 */
export const UDF_MAX_XML_TEXT_RUN = 1 * MiB;

/**
 * Element nesting depth (fast-xml-parser's maxNestedTags, default 100). A UDF
 * is about 5 levels deep.
 */
export const UDF_MAX_XML_DEPTH = 100;

// --- DOCX --------------------------------------------------------------------

/** One part of the package after decompression (document.xml, styles...). */
export const DOCX_MAX_PART_BYTES = 64 * MiB;

/** All parts read for one document together, after decompression. */
export const DOCX_MAX_TOTAL_PART_BYTES = 256 * MiB;

/**
 * Elements across the XML parts read for one document. mammoth builds a DOM
 * and its own tree, measured at about 1.2-1.4 KiB per element: 1 000 000 is
 * about 1.4 GiB, which a dense Word document of some 2000 pages reaches.
 */
export const DOCX_MAX_XML_ELEMENTS = 1_000_000;

/** Attributes across the XML parts read for one document (about 200 bytes each). */
export const DOCX_MAX_XML_ATTRIBUTES = 2_000_000;
