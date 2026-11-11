# MetinBul Test Fixtures

Bu dizin, MetinBul testleri için kullanılan fixture dosyalarını içerir veya otomatik olarak oluşturur.

## Otomatik Oluşturulan / Programatik Fixture'lar:
1. `sample.docx` - Geçerli DOCX arşiv yapısı, Türkçe mahkeme metni (`T.C. İSTANBUL BÖLGE ADLİYE MAHKEMESİ 12. HUKUK DAİRESİ`).
2. `sample.pdf` - Standart PDF 1.4 metin akışı (`T.C. ANKARA NOBETCI IS MAHKEMESINE`).
3. `sample.udf` - Standart UYAP UDF ZIP + XML yapısı (`T.C. İZMİR 3. İCRA HUKUK MAHKEMESİ GEREKÇELİ KARAR`).
4. `corrupt.docx`, `corrupt.pdf`, `corrupt.udf` - Bozuk dosya hata yakalama testleri.
5. `unsupported.txt` - Desteklenmeyen uzantı kontrollü hata testi.

## Harici / Gerçek Binary Fixture Gereksinimleri:
- `sample.doc`: Gerçek Microsoft Word 97-2003 OLE2 binary dosyası (`word-extractor` testi için).
  Eğer kullanıcı veya ortam tarafından gerçek bir `.doc` dosyası sağlanırsa testler bunu otomatik olarak okur. Sağlanmadığı durumda DOC testleri kontrollü hata/varlık testlerini çalıştırır ve eksiklik raporlanır.
