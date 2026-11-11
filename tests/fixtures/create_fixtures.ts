import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const FIXTURES_DIR = __dirname;

export function setupFixtures() {
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }

  // 1. DOCX Fixture
  const docxPath = path.join(FIXTURES_DIR, 'sample.docx');
  if (!fs.existsSync(docxPath) || fs.statSync(docxPath).size === 0) {
    const docxZip = new AdmZip();
    docxZip.addFile(
      '[Content_Types].xml',
      Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
    );
    docxZip.addFile(
      '_rels/.rels',
      Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
    );
    docxZip.addFile(
      'word/document.xml',
      Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:t>T.C. İSTANBUL BÖLGE ADLİYE MAHKEMESİ 12. HUKUK DAİRESİ</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:t>Davacının kıdem ve ihbar tazminatı taleplerinin kabulü gerekmiştir.</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`)
    );
    docxZip.writeZip(docxPath);
  }

  // 2. PDF Fixture (valid minimal PDF with Turkish text)
  const pdfPath = path.join(FIXTURES_DIR, 'sample.pdf');
  if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size === 0) {
    const pdfStreamContent = 'BT /F1 12 Tf 100 700 Td (T.C. ANKARA NOBETCI IS MAHKEMESINE - Kidem tazminati ve fazla calisma alacagi) Tj ET';
    const pdfContent = `%PDF-1.4
1 0 obj
<<
  /Type /Catalog
  /Pages 2 0 R
>>
endobj
2 0 obj
<<
  /Type /Pages
  /Kids [3 0 R]
  /Count 1
>>
endobj
3 0 obj
<<
  /Type /Page
  /Parent 2 0 R
  /MediaBox [0 0 612 792]
  /Contents 4 0 R
  /Resources <<
    /Font <<
      /F1 5 0 R
    >>
  >>
>>
endobj
4 0 obj
<<
  /Length ${pdfStreamContent.length}
>>
stream
${pdfStreamContent}
endstream
endobj
5 0 obj
<<
  /Type /Font
  /Subtype /Type1
  /BaseFont /Helvetica
>>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
0000000350 00000 n 
trailer
<<
  /Size 6
  /Root 1 0 R
>>
startxref
427
%%EOF`;
    fs.writeFileSync(pdfPath, pdfContent, 'utf8');
  }

  // 3. UDF Fixture (ZIP + XML containing Turkish text)
  const udfPath = path.join(FIXTURES_DIR, 'sample.udf');
  if (!fs.existsSync(udfPath) || fs.statSync(udfPath).size === 0) {
    const udfZip = new AdmZip();
    udfZip.addFile(
      'content.xml',
      Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<template version="1.0">
  <elements>
    <element name="baslik" type="text">
      <content><![CDATA[T.C. İZMİR 3. İCRA HUKUK MAHKEMESİ GEREKÇELİ KARAR]]></content>
    </element>
    <element name="detay" type="text">
      <content><![CDATA[Borçlunun haczedilmezlik şikayetinin kabulüne karar verilmiştir.]]></content>
    </element>
  </elements>
</template>`, 'utf8')
    );
    udfZip.writeZip(udfPath);
  }

  // 4. Corrupt files
  const corruptPdf = path.join(FIXTURES_DIR, 'corrupt.pdf');
  if (!fs.existsSync(corruptPdf)) {
    fs.writeFileSync(corruptPdf, Buffer.from('NOT A VALID PDF FILE HEADER'), 'utf8');
  }
  const corruptDocx = path.join(FIXTURES_DIR, 'corrupt.docx');
  if (!fs.existsSync(corruptDocx)) {
    fs.writeFileSync(corruptDocx, Buffer.from('NOT A VALID DOCX ZIP FILE'), 'utf8');
  }
  const corruptUdf = path.join(FIXTURES_DIR, 'corrupt.udf');
  if (!fs.existsSync(corruptUdf)) {
    fs.writeFileSync(corruptUdf, Buffer.from('NOT A VALID UDF FILE'), 'utf8');
  }
  const unsupportedTxt = path.join(FIXTURES_DIR, 'unsupported.txt');
  if (!fs.existsSync(unsupportedTxt)) {
    fs.writeFileSync(unsupportedTxt, 'Düz metin dosyası', 'utf8');
  }
}
