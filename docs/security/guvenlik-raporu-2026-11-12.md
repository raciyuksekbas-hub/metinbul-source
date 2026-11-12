# MetinBul Güvenlik Denetimi ve Sertleştirme Raporu

Tarih: 12 Kasım 2026 · Dal: `security/hardening`

Bu rapor bir **kaynak kodu incelemesi** ve buna dayanan düzeltmelerdir; bir sızma testi değildir. Belirtilen her test gerçekten çalıştırılmıştır: macOS'takiler bu Mac'te, Windows'takiler GitHub Actions'ın `windows-2022` çalıştırıcısında. Denenemeyenler ayrıca belirtilmiştir.

## 1. Denetlenen sürüm ve Git commit'i

| | |
|---|---|
| Sürüm | 0.4.2 (`package.json`) |
| Denetlenen commit | `1ddcd4b` (özel depo `main`), açık kaynak aynası `metinbul-source`'ta `20a6c84` |
| Yayımlanmış ikili dosyalar | v0.4.2, `48c3abe`'den derlenmiş (MIT commit'inden bir önce) |
| Çalışma ortamı | Electron 43.4.1 → **43.8.8**, better-sqlite3 13.0.3 (SQLite 3.53.4), Node 26 (testler) |

Yerel çalışma kopyasında kullanıcıya ait commit'lenmemiş değişiklik yoktu (yalnızca izlenmeyen `graphify-out/` ve `scratch/` klasörleri; dokunulmadı).

## 2. İncelenen güvenlik alanları

- Ana süreç: `src/main/main.ts`, `preload.ts`, `updater.ts`, `search-service.ts`, `search-worker.ts`, `indexer-worker.ts`, `about-info.ts`
- Veritabanı: `src/db/database.ts`
- Tarayıcı ve indeksleyici: `src/scanner/scanner.ts`, `roots.ts`, `windows-availability.ts`, `src/search/indexer.ts`, `search.ts`
- Ayrıştırıcılar: `src/extractors/*` (adm-zip, mammoth, pdf-parse/pdf.js, fast-xml-parser, word-extractor)
- OCR: `src/ocr/ocr.ts`, `windows-ocr.ts`, `native/macos/metinbul-ocr.swift`
- Arayüz: `src/renderer/*` (HTML üretimi, kaçışlama)
- Paketleme ve dağıtım: `package.json` (electron-builder), `build/entitlements.mac.plist`, `scripts/build.mjs`, `scripts/mac-release.mjs`
- Tedarik zinciri: `package-lock.json` (npm audit), `.github/workflows/*`

## 3. Doğrulanan güvenlik açıkları ve önem dereceleri

Satır numaraları düzeltme öncesi koda (`1ddcd4b`) aittir. Önem derecesi, MetinBul'un tehdit modeline göre verilmiştir: belgeler gizli, uygulama yerel, saldırgan çoğunlukla "kötü niyetli bir belge gönderen kişi" ya da "kullanıcının hesabında çalışan başka bir program"dır.

| No | Bulgu | Önem | Durum |
|---|---|---|---|
| G-1 | Sembolik bağlantı / junction ile hariç tutulan klasör indekslenebiliyor | Yüksek | Giderildi |
| G-2 | Electron 43.4.1'de bilinen 9 açık (sandbox'lı preload kod önbelleği zehirleme dâhil) | Yüksek | Giderildi (43.8.8) |
| G-3 | UDF/DOCX sıkıştırma bombası: sınırsız açma, bellek tükenmesi (adm-zip ≤ 0.6.0 açıkları dâhil) | Yüksek | Giderildi |
| G-4 | macOS'ta Electron sigortaları açık: başka bir program MetinBul'un klasör izinlerini ödünç alabilir | Orta–Yüksek | Giderildi (macOS) |
| G-5 | `app:openFile` herhangi bir yolu açıyor; `app:openExternal` her http/https/mailto adresine izin veriyor | Orta | Giderildi |
| G-6 | Sandbox kapalı, gezinme/pencere kilidi yok, izinler varsayılan olarak onaylanıyor, CSP yok, IPC göndericisi doğrulanmıyor | Orta | Giderildi |
| G-7 | Silinen ve hariç tutulan belgelerin metni veritabanı dosyasında fiziksel olarak kalıyor | Orta | İleriye dönük giderildi; eski kalıntı için bkz. §7 |
| G-8 | Bir belge ayrıştırıcıyı kilitlerse indeksleme kalıcı olarak duruyor | Orta | Giderildi |
| G-9 | Veritabanı dosyaları 0644 izinli oluşturuluyor | Düşük | Giderildi |
| G-10 | Windows OCR geçici dosyaları (belge yolu ve tanınan metin) tahmin edilebilir adlarla `%TEMP%`'e yazılıyor, çökmede kalıyor | Düşük | Giderildi |
| G-11 | Arama tablosu geçişi atomik değil; yarıda kalırsa eski belgeler aranamaz oluyor | Düşük (işlevsel) | Giderildi |
| G-12 | IPC parametreleri doğrulanmıyor (arama alanı türü, tema, yol biçimi, uzunluk) | Düşük | Giderildi |
| G-13 | GitHub Actions sürüm etiketine bağlı (SHA değil); bir iş akışında şablon ifadesi betiğe gömülü; checkout kimlik bilgisini bırakıyor | Düşük | Giderildi |
| G-14 | Geliştirme araçlarında açıklar (kullanılmayan `@electron/rebuild` üzerinden kritik `tar`, vite, vitest vb.) | Düşük (yalnızca geliştirme makinesi) | Büyük kısmı giderildi; bkz. §8 |
| G-15 | Belge adı taşıyan ama bir programı ya da betiği gösteren bağlantı indeksleniyor ve "Aç" ile çalıştırılabiliyor | Orta | Giderildi |
| G-16 | `--remote-debugging-port` gibi bayraklarla başka bir program MetinBul'u yönetip onun klasör izinleriyle okuyabiliyor (sigortaların bıraktığı yol) | Orta (macOS) | Giderildi (macOS) |

G-15 ve G-16 bağımsız gözden geçirmede bulundu (§3 sonu). Aynı gözden geçirme, bu çalışmanın kendi ilk sürümünde düzeltilmesi gereken hataları da gösterdi; bunlar ilgili bulguların altında yazılıdır.

### G-1 · Sembolik bağlantı ile hariç tutmanın aşılması — Yüksek
- **Konum:** `src/scanner/scanner.ts:398-410` (bağlantı izlenirken hariç tutma, bağlantının kendi yoluna göre yapılıyordu), `:430-434` (gerçek yol yalnızca "daha önce ziyaret edildi mi" için kullanılıyordu), `src/search/indexer.ts:174` (eski kayıtları silme kararı da yalnızca yola bakıyordu).
- **Ön koşul:** Aranan bir klasörün içinde hariç tutulan klasöre giden bir sembolik bağlantı veya Windows junction'ı. Bunu kullanıcı, bir eşitleme aracı ya da paylaşılan klasöre yazabilen başka biri oluşturabilir.
- **Etki:** Kullanıcının "aranmasın" dediği klasördeki belgelerin tam metni indekse giriyor ve arama sonuçlarında görünüyordu.
- **Çözüm:** Hariç tutmalar hem kullanıcının yazdığı biçimde hem de bağlantılar çözülmüş gerçek yol olarak tutuluyor (`resolveExclusions`). Her bağlantı ve her alt klasör gerçek yoluna göre denetleniyor. Reddedilen bağlantılar `ScanStats.refusedPaths`'e kaydediliyor, indeksleyici de önceki sürümün bunların altına eklediği kayıtları siliyor. Her belge okunmadan hemen önce gerçek yolu yeniden denetleniyor; böylece tarama ile okuma arasında dosyanın bağlantıyla değiştirilmesi (TOCTOU) de işe yaramıyor. Bağlantı döngüleri zaten sonlanıyordu; test edildi.
- **Bilinçli olarak korunan davranış:** Hariç tutulmamış bir yere, örneğin harici bir diske giden bağlantı eskisi gibi izleniyor. Mevcut bir test bu özelliği güvence altına alıyor; arama alanının dışına çıkan her bağlantıyı reddetmeyi denedim, bu özelliği bozduğu için geri aldım.

### G-2 · Electron çalışma ortamındaki bilinen açıklar — Yüksek
- **Konum:** `package.json` (`electron ^43.4.1`). Electron `devDependencies` altında olduğu için `npm audit --omit=dev` onu göstermiyordu; oysa uygulamanın içinde dağıtılan çalışma ortamıdır.
- **Etki:** GHSA-qmv3-fv6v-rmhq (ele geçirilmiş bir renderer'ın sandbox'lı preload kod önbelleğini zehirlemesi), GHSA-997q-gvvc-jwmx (openExternal izninin yanlış kaynağa atfedilmesi) ve 7 açık daha.
- **Çözüm:** Aynı ana sürüm içinde 43.8.8'e yükseltildi (yerel modül yeniden derleme gerektirmedi; better-sqlite3 N-API prebuild'leri kullanıyor).

### G-3 · Kötü niyetli belgeler (UDF, DOCX, DOC, PDF) — Yüksek
- **Konum:** `src/extractors/udf.ts:48, 60` (`new AdmZip` + sınırsız `getData()`), `:68` (UDF düz XML yolu, boyut sınırı yok), `:5` (XML ayrıştırıcı varsayılan ayarlarla); `docx.ts:9` (mammoth/JSZip parçaları sınırsız açıyor); `doc.ts:14`; `pdf.ts:11` (dosya boyutu sınırı yok).
- **Ön koşul:** Kullanıcının indekslenen bir klasörüne hazırlanmış bir belgenin girmesi (e-posta eki, karşı taraftan gelen dosya, indirilen bir UYAP belgesi).
- **Etki (ölçüldü):**
  - `adm-zip` 0.6.1'in kendi koruması yalnızca arşivin bildirdiği boyuta bakıyor: 1 GiB bildiren 1 MiB'lık bir UDF, 1 GiB bellek ayırttı.
  - Tek bir 64 KiB'lık giriş adı `getEntries()` sırasında 730 MiB tüketti.
  - `word-extractor` 1.0.4'te birkaç KiB'lık hazırlanmış `.doc` dosyası (döngüsel sektör zinciri, çocuklarını paylaşan dizin kayıtları, aynı baytı gösteren metin parçaları) **bütün süreci** "heap out of memory" ile çökertti.
  - mammoth, paketin kendi ilişki tablosuna göre `word/payload.bin` gibi XML uzantısı olmayan bir parçayı da ayrıştırabiliyor. Bu yüzden sadece `.xml` parçalarını denetlemek yetmiyor.
- **Çözüm:**
  - `src/extractors/limits.ts`: bütün sınırlar tek yerde ve gerekçeleriyle. Dosya boyutu PDF için 512 MiB, DOCX/DOC/UDF için 256 MiB. ZIP en çok 10.000 giriş ve 4.096 baytlık ad. UDF XML 64 MiB, 1.000.000 düğüm, iç içelik 100. DOCX parça başına 64 MiB, toplam 256 MiB, 1.000.000 eleman.
  - `read-file.ts`: boyut okumadan önce ve açık dosyada tekrar denetleniyor. Dosya bir kez okunuyor, sadece normal dosyalar kabul ediliyor.
  - `zip.ts` (yeni, `adm-zip` yerine): giriş sayısı ve ad uzunluğu ayrıştırmadan önce denetleniyor. Yinelenen adlar, şifreli girişler ve bilinmeyen sıkıştırma yöntemleri reddediliyor. Açma işlemi `zlib.inflateRawSync` ile bildirilen boyut ve sınırın küçüğüyle kısıtlanıyor; açıldıktan sonra boyut ve CRC-32 doğrulanıyor.
  - `udf.ts`: `<!DOCTYPE`/`<!ENTITY` reddediliyor (billion laughs). Ayrıştırmadan önce doğrusal bir ön tarama düğüm ve metin bütçesini denetliyor. Metin toplama özyinelemesiz yapılıyor.
  - `ooxml.ts`: mammoth'un açtığı her parça, adı ne olursa olsun, bu sınırlardan geçiyor; DOCTYPE içeren parçalar reddediliyor.
  - `doc.ts`: `word-extractor`'ın çöken üç fonksiyonu sınırlı sürümleriyle değiştirildi; bileşik dosya başlığı gerçek dosya boyutuna göre denetleniyor. Kütüphanenin iç yapısı beklenenden farklıysa `.doc` korumasız ayrıştırılmıyor, reddediliyor.
  - `pdf.ts`: boyut sınırı; `isEvalSupported: false` (pdf.js'in yazı tipi kodu üretmesini kapatır, CVE-2024-4367 türü açıklara karşı ek önlem; kullanılan pdfjs-dist 5.4.296 bu CVE'yi zaten içermiyor).
  - Ana süreç: indeksleme işçisine 4 GiB yığın sınırı (`resourceLimits`). Bellek tükenirse bütün uygulama yerine sadece işçi durur, bekçi (G-8) belgeyi atlar.
- **Kalan risk:** `word-extractor` ve pdf.js'in bazı yollarında yavaş, ikinci dereceden işlem süreleri olabilir. Bunlar artık uygulamayı çökertmiyor ve indekslemeyi kalıcı olarak durdurmuyor; bekçi en geç 5 dakikada o belgeyi atlıyor. Ayrıştırıcıları ayrı ve kaynakları sınırlı bir süreçte (Electron `utilityProcess`) çalıştırmak daha güçlü bir yalıtım olur; bkz. §10.
- **Bilinçli davranış değişiklikleri:** `.doc` uzantılı bir DOCX artık mammoth ile okunuyor. Başına veri eklenmiş ya da çok parçalı ZIP'ler, 4.096 bayttan uzun giriş adları ve DOCTYPE içeren UDF'ler reddediliyor. Gerçek belgeler üzerindeki karşılaştırma için bkz. §5.
- **Kütüphane iç yapısına bağımlılık:** mammoth'un belgelenmemiş `{ file }` girişi ve `word-extractor` 1.0.4'ün iç modülleri kullanılıyor. İkisi de testlerle güvenceye alındı; bu iki paketin sürümü yükseltilirken testler yeniden çalıştırılmalıdır.

### G-4 · macOS'ta Electron sigortaları — Orta–Yüksek
- **Konum:** `package.json` `build` bölümü: `electronFuses` ya da eşdeğer bir adım yoktu.
- **Ön koşul:** Kullanıcının hesabında çalışan herhangi bir program (ör. zararlı bir indirme).
- **Etki:** Kullanıcı MetinBul'a Masaüstü, Belgeler, iCloud Drive ya da tam disk erişimi verir; macOS bu izni MetinBul'un imzasına bağlar. Sigortalar açıkken başka bir program `ELECTRON_RUN_AS_NODE=1 /Applications/MetinBul.app/Contents/MacOS/MetinBul -e "…"` ile MetinBul'u düz bir Node.js yorumlayıcısı olarak çalıştırıp (ya da `NODE_OPTIONS`, `--inspect` ile) bu klasörleri MetinBul'un adıyla okuyabilirdi.
- **Çözüm:** `scripts/electron-fuses.cjs` (electron-builder `afterPack`) macOS paketinde `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` sigortalarını kapatıyor; `OnlyLoadAppFromAsar` ve `EnableEmbeddedAsarIntegrityValidation` sigortalarını açıyor. İmzalamadan önce uygulanıyor.
- **Windows:** Bilinçli olarak değiştirilmedi. Windows'ta uygulamaya özgü klasör izni yok, ödünç alınacak bir yetki doğmuyor. Ayrıca CI'daki paket duman testi uygulamayı `--inspect` ile sürüyor.
- **Sınır:** Sigortalar ve G-16, başka bir programın MetinBul üzerinden *yeni* dosya okumasını engeller. İndeksin kendisi ise `~/Library/Application Support` altında duruyor. macOS bu klasörü korumuyor, yani aynı kullanıcı hesabında çalışan bir program, Belgeler ve Masaüstü'nden indekslenmiş metni doğrudan dosyadan okuyabilir. Bunu kapatan şey, anahtarı Keychain'de MetinBul'un imzasına bağlı tutulan şifrelemedir (§7).

### G-15 · Belge gibi görünen bağlantı ile program çalıştırma — Orta
- **Konum:** `src/scanner/scanner.ts:405` (dosya bağlantısında uzantı bağlantının adından alınıyordu); G-5'teki ilk düzeltme de yalnızca adı ve indekste olup olmadığını denetliyordu.
- **Ön koşul:** İndekslenen bir klasöre (paylaşılan klasör, açılmış bir arşiv) `Dilekce.pdf → ./payload` gibi bir bağlantı konması.
- **Etki:** Bağlantı indekse giriyor, adıyla bulunuyor; "Aç" denince macOS hedefi açıyordu. Hedef bir betikse Terminal ile çalışıyordu (gözden geçirmede `NSWorkspace` ile doğrulandı).
- **Çözüm:** Tarayıcı, hedefi belge türünde olmayan bağlantıları indekslemiyor. `openFile`, `showInFolder` ve sonuç menüsü gerçek hedefin normal bir dosya ve belge türünde olduğunu ayrıca denetliyor.

### G-16 · Hata ayıklama bayraklarıyla uygulamanın yönetilmesi — Orta (macOS)
- **Konum:** `src/main/main.ts` başı: komut satırı hiç denetlenmiyordu.
- **Etki:** Sigortalar Node.js tarafını kapatıyordu, ama `--remote-debugging-port` ile açılan bir MetinBul'un sayfalarına bağlanan bir program `window.api` üzerinden arama alanı ekleyip yeniden tarama başlatabilir ve aramayla, MetinBul'un izniyle korunan klasörlerin metnini okuyabilirdi.
- **Çözüm:** Paketlenmiş macOS uygulaması `--remote-debugging-port/-pipe`, `--inspect*`, `--js-flags`, `--*-cmd-prefix`, `--gpu-launcher` gibi bayraklarla açılmayı reddediyor (`FORBIDDEN_SWITCHES`). Denendi: süreç kod 1 ile çıkıyor, hata ayıklama portu 100 ms aralıklarla bakıldığında hiç açılmıyor; bayraksız açılış normal.

### G-5 · Dosya ve bağlantı açma kanalları — Orta
- **Konum:** `src/main/main.ts:1233-1246` (`app:openFile`: renderer'dan gelen ve var olan her yol `shell.openPath` ile açılıyordu), `:1248-1258` (`app:showInFolder`), `:1264-1274` (`app:openExternal`: her `http(s)://` ve `mailto:` adresi).
- **Ön koşul:** Renderer'da MetinBul'un göndermediği bir kodun çalışması. İncelemede bunu sağlayan bir XSS bulunamadı (bkz. §3 sonu); bu nedenle bu bir derinlemesine savunma bulgusudur.
- **Etki:** `shell.openPath` verilen dosyayı çift tıklanmış gibi açar: bir `.app`, `.command`, `.exe` ya da betik çalışırdı. Dış bağlantılar her siteye yönlendirebilirdi.
- **Çözüm:** `src/main/security.ts`: `isOpenableDocument` yalnızca indekste bulunan, desteklenen türdeki (`.doc/.docx/.pdf/.udf`) belgeleri kabul ediyor (`AppDatabase.hasDocument`, belge metni okumadan yalnızca yol indeksinden). `isAllowedExternalUrl` yalnızca `https://github.com/raciyuksekbas-hub/metinbul-releases…` ve geri bildirim adresine, sadece konu ve gövde içeren bir `mailto:` kabul ediyor. Benzer görünen alan adları, kullanıcı adı ya da port içeren adresler, başka protokoller ve ek alıcılı (`cc`, `bcc`, `to`) e-postalar reddediliyor. Ek alıcı açığı, ilk sürümde vardı ve gözden geçirmede bulundu.

### G-6 · Electron işlem ve IPC güvenliği — Orta
- **Konum:** `src/main/main.ts:424, 618, 720` (`sandbox: false`); `will-navigate`, `setWindowOpenHandler`, `setPermissionRequestHandler` hiç yoktu; HTML sayfalarında CSP yoktu; `:1102-1495` arasındaki 37 IPC işleyicisi göndericiyi doğrulamıyordu.
- **Etki:** Electron izin isteklerini varsayılan olarak onaylar. Bir sayfa başka bir adrese yönlendirilebilseydi, o adres MetinBul'un önyükleme API'sine sahip olurdu.
- **Çözüm:** Üç pencerenin üçünde de sandbox açıldı (`sandbox: true`). Önyükleme betiği sadece `electron`'u kullandığı için uyarlama gerekmedi. `app.enableSandbox()` bilinçli olarak kullanılmadı: Windows CI'da ölçüldüğü üzere, kullanıcıların GPU ve sandbox sorunlarına karşı verdiği `--no-sandbox` bayrağıyla birlikte uygulamayı açılışta erişim ihlaliyle (0xC0000005) çökertiyor. Gezinme, yönlendirme, yeni pencere ve `<webview>` reddediliyor. Bütün izin istekleri ve denetimleri reddediliyor. Üç sayfaya katı bir CSP eklendi (`default-src 'none'; script-src 'self'; connect-src 'none'; object-src 'none'` …). Her IPC isteği, gönderen çerçevenin MetinBul'un üç sayfasından birinin üst çerçevesi olduğu doğrulandıktan sonra işleniyor (`handle()` / `isTrustedSender`). Yazım denetimi kapatıldı (sözlük indirmesi yok). Ana süreçte `umask 077`.

### G-7 · Silinen metnin dosyada kalması — Orta
- **Konum:** `src/db/database.ts:88-95` (`secure_delete` kapalı), `:172-176` (FTS5 tablosu metnin normalleştirilmiş bir kopyasını ayrıca saklıyor), `:489-505` (silme).
- **Ön koşul:** Veritabanı dosyasına ya da bir yedeğine erişim.
- **Etki:** SQLite silinen satırları boş sayfalarda, FTS5 ise silinen belgelerin trigram parçalarını bir sonraki birleştirmeye kadar tutar. Kullanıcının hariç tuttuğu ya da silinen belgelerin metni dosyadan kurtarılabilirdi. Test bunu gösteriyor (kontrol testi: güvenli silme kapalıyken işaret metni dosyada kalıyor).
- **Çözüm:**
  - `PRAGMA secure_delete = ON`: silinen satırlar sıfırlarla üzerine yazılır.
  - Silme geçişinden sonra arama dizininin parçaları kısa adımlarla birleştirilir (`compactSearchIndex`, FTS5 `merge`). Bu, silinen belgelerin trigram girdilerini düşürür. Ardından `wal_checkpoint(TRUNCATE)` yapılır.
  - Silmeler 50'şerlik işlemlere bölündü.
- **Ölçülen maliyet (5.000 sentetik belge, 460 MB):** 1.000 belgenin silinmesi toplam 0,6 sn (en uzun grup 43 ms), ardından tam birleştirme 1,2 sn (en uzun adım 27 ms). Sorgu süresi değişmedi. Bir testte silinen belgeye özgü trigramların dizinden kalktığı (`fts5vocab`) doğrulanıyor.
- **İlk sürümdeki hata (gözden geçirmeden):** İlk olarak FTS5'in kendi `secure-delete` ayarı kullanılmıştı. Bu ayar büyük indekste bir silmeyi 35–60 kat yavaşlatıyor ve 50 belgelik bir grubun yazma kilidini saniyelerce tutmasına yol açıyordu. Bu sırada ana süreç bir ayar yazmaya çalışırsa 3 sn donup `SQLITE_BUSY` hatası veriyordu. Ayar kaldırıldı; daha önce açılmış bir profilde de kapatılıyor.

### G-8 · Kilitlenen belge ayrıştırıcısı — Orta
- **Konum:** `src/main/main.ts:969-1037`: indeksleme işçisini izleyen bir zaman sınırı yoktu.
- **Etki:** Sonsuz döngüye giren ya da işçiyi çökerten bir belge, indekslemeyi uygulama yeniden başlayana kadar durduruyordu. Belge "okunamadı" diye kaydedilmediği için her açılışta aynı yere takılıyordu.
- **Çözüm:**
  - İşçi her belgeyi okumadan önce süre sınırıyla bildiriyor. Metin için sınır 5 dk artı her 50 MB için 1 dk; böylece yavaş bir ağ paylaşımındaki büyük bir PDF de yetişiyor. OCR için sınır, OCR'ın kendi zaman aşımı artı 2 dk.
  - Süre aşılırsa, işçi o belgede çökerse ya da belgenin ortasında sessizce sonlanırsa ana süreç işçiyi durduruyor. Belge "okunamadı" olarak kaydediliyor (önceden indekslenmiş metni korunuyor) ve güncelleme aynı tetikleyiciyle, o belgenin ötesinden sürüyor. Belge, Ayarlar › İndeks'teki "İşlenemeyen belgeler" listesinde görünür.
  - Okunan belge, bir sonraki ilerleme mesajında unutuluyor.
  - İşçinin V8 yığını 2 GiB ile sınırlı.
- **Bekçinin bulduğu gerçek hata:** Bu Mac'teki bir `.doc` belgesi eski ayrıştırıcıda hiç çözülmeyen bir söz (promise) bırakıyordu. Bu durumda işçi sessizce sonlanıyordu (bkz. §5).
- **İlk sürümdeki hatalar (gözden geçirmeden):**
  - Yığın sınırı 4 GiB'tı. Electron'da sürecin bütün iş parçacıkları tek bir ~4 GiB'lık V8 alanını paylaştığı için bu sınıra hiç ulaşılmıyordu; bellek bombası yine bütün uygulamayı çökertiyordu. Electron 43.8.8'in Node'uyla doğrulandı: 4096 MB ile süreç çöktü (çıkış kodu 134), 2048 MB ile ana süreç 1 GiB tutarken bile sadece işçi durdu.
  - Okunan belge unutulmuyordu, bu yüzden sonraki bir hata sağlam bir belgeye yüklenebiliyordu.

### G-9 · Veritabanı dosya izinleri — Düşük
- **Konum:** `src/db/database.ts:84` (klasör izin belirtilmeden oluşturuluyor), `:88` (dosyalar 0644).
- **Not:** Bu makinedeki gerçek profilde klasör zaten 0700 (Electron/macOS varsayılanı), dosyalar 0644. Yani başka kullanıcılar klasöre giremiyordu; ancak kopyalar ve yedekler 0644'ü taşıyor.
- **Çözüm:** `src/db/private-files.ts`: klasör 0700; veritabanı, `-wal`, `-shm`, `-journal` 0600. Yalnızca kullanıcının sahip olduğu dosyalarda, bağlantı izlenmeden ve yol üzerinden yapılıyor. Dosyalar bilinçli olarak açılmıyor; çünkü POSIX kilitleri süreç başınadır ve bir tanıtıcıyı kapatmak aynı süreçteki SQLite bağlantılarının kilitlerini düşürür. Windows'ta değişiklik yapılmadı; bkz. §9.

### G-10 · OCR geçici dosyaları — Düşük
- **Konum:** `src/ocr/windows-ocr.ts:132` ve `src/scanner/windows-availability.ts:196`: `%TEMP%\metinbul-ocr-<pid>-<n>.json/.txt` (belgenin yolu ve tanınan metni).
- **Çözüm:** `src/shared/private-temp.ts`: her iş için rastgele adlı, 0700 bir klasör (`mkdtemp`), dosyalar `wx` ile oluşturuluyor, iş bitince klasör siliniyor. Açılışta eski sürümlerin ve çökmelerin bıraktığı kalıntılar (yalnızca MetinBul'un adlandırma biçimindekiler, bağlantı izlenmeden, yalnızca kullanıcının dosyaları) temizleniyor.

### G-11 · Atomik olmayan şema geçişi — Düşük (işlevsel)
- **Konum:** `src/db/database.ts:154-167`: eski FTS tablosu siliniyor, yenisi oluşturulup dolduruluyordu; tek işlem değildi.
- **Etki:** Geçiş yarıda kalırsa boş bir trigram tablosu kalıyordu; indeksleyici değişmeyen belgeleri atladığı için tablo bir daha dolmuyor, eski belgeler aranamaz kalıyordu.
- **Çözüm:** Kontrol, silme, oluşturma ve doldurma tek bir `IMMEDIATE` işlemde yapılıyor. Kesinti geri alınıyor, bir sonraki açılışta geçiş baştan tamamlanıyor. Bu, ana süreç ile indeksleme işçisinin aynı anda geçiş yapmasını da engelliyor.

### G-12 · IPC parametre doğrulaması — Düşük
- `app:addSearchArea` türü (`include/exclude`) doğrulamıyor ve yolun var olan bir klasör olduğuna bakmıyordu (`main.ts:1190`). `app:completeOnboarding`, `setSearchScopeMode`, `setTheme`, `copyToClipboard`, `setQuickSearchShortcut`, `search` için de tür ve uzunluk sınırları eklendi (sorgu ≤ 1.000 karakter, pano ≤ 64 KB, yol ≤ 32.767 karakter ve NUL içermez).

### G-13 · CI iş akışları — Düşük
- `actions/checkout@v4` gibi değişebilen etiketler tam commit SHA'larına sabitlendi. `windows-placeholder-acceptance.yml:68-69` adım çıktılarını doğrudan PowerShell betiğine gömüyordu; artık ortam değişkeniyle geçiyor. O iş akışına açık `permissions: contents: read` eklendi. Checkout'lar kimlik bilgisini bırakmıyor (`persist-credentials: false`).

### İncelenip sorun bulunmayan alanlar
- **XSS:** Renderer, belge adı, klasör ve yolu `escapeHtml`, metin parçalarını `sanitizeSnippet` ile kaçışlıyor; yalnızca çıplak `<mark>` geçiyor. Kötü niyetli ad ve içerikli sentetik belgelerle test edildi.
- **PowerShell enjeksiyonu:** Belge yolları betiğe gömülmüyor; JSON iş dosyasıyla geçiyor. Gömülen geçici yollar `''` kaçışlı tırnak içinde. OCR betiği `-EncodedCommand` ile çalışıyor. Yönetici yetkisi yalnızca kullanıcının bastığı "Türkçe metin tanımayı yükle" düğmesinde, UAC onayıyla isteniyor.
- **macOS OCR yardımcısı:** `execFile` argüman dizisiyle çalışıyor (kabuk yok). Swift kodunda ağ ya da geçici dosya yok.
- **Ağ:** Uygulamadaki tek ağ isteği güncelleme denetimi (§6). Arama sorguları hiçbir yere yazılmıyor.
- **macOS imzalama:** Hardened Runtime açık. Tek yetki (entitlement) V8 için gerekli `com.apple.security.cs.allow-jit`. `mac-release.mjs` imza, notarization ve staple adımlarını denetliyor, eksikse yayını durduruyor.

### Bağımsız gözden geçirme

Değişikliklerin yeni bir risk yaratıp yaratmadığını, işi yapanın akıl yürütmesine bağlı kalmamak için ayrı bir inceleme denetledi. Bulguları kendi denemelerimle doğrulayıp uyguladım:
- G-15 ve G-16.
- G-7 (FTS5 `secure-delete` maliyeti).
- G-8 (yığın sınırı, unutulmayan belge).
- E-posta ek alıcısı.
- Uzun sorgu: 1.000 karakteri aşan bir sorgu sessizce boş sonuç veriyordu, artık kısaltılıyor.
- Kurulum yolu: yolunda `%` ya da Windows ağ paylaşımı olan kurulumlarda bütün IPC'nin reddedilmesi.

**Bilinçli olarak değiştirilmeyen bir bulgu:** Hariç tutulan şey bir sembolik bağlantıysa, MetinBul o bağlantının hedef klasörünü de hariç tutuyor. Hedef ayrıca bir arama alanı olsa bile indeksten çıkarıyor. Bu, uygulamanın mevcut kuralıyla ("kullanıcının hariç tutması, açık eklemesinden önce gelir") tutarlı. Gizlilik açısından da gereğinden fazla hariç tutmak, eksik hariç tutmaktan güvenlidir. İstenirse "bağlantıyı hariç tutmak sadece bağlantıyı kapsar" biçimine çevrilebilir.

**Windows CI'ın bulduğu hata:** `app.enableSandbox()`, `--no-sandbox` bayrağıyla birlikte uygulamayı Windows'ta açılışta çökertiyordu (G-6). Ayrı bir tanı çalışmasında, çağrı varken ve yokken üçer farklı açılışla ölçüldü, sonra kaldırıldı.

### Tutarlılık bulguları (güvenlik dışı, bilginize)
- Ayarlar › Hakkında "MetinBul'un kaynak kodu … üzerindeki haklar saklıdır" diyor; oysa kaynak kodu MIT lisansıyla yayımlandı. Hukuki metin olduğu için değiştirilmedi; karar sizin.
- Yayımlanan 0.4.2 ikili dosyalarındaki `package.json` lisansı hâlâ "ISC". `metinbul-source`, ikili dosyaların derlendiği commit'ten iki commit ileride (MIT ve CI değişikliği).

## 4. Yapılan kod değişiklikleri

`security/hardening` dalındaki commit'ler (`1ddcd4b` üzerine):

| Commit | İçerik |
|---|---|
| `39e9979` | Bağımlılık güncellemeleri (Electron 43.8.8, fast-xml-parser 5.12.0, adm-zip geliştirme bağımlılığına, `@electron/rebuild` kaldırıldı) |
| `a4c9fbc` | Belge ayrıştırıcılarının sınırlandırılması (G-3) |
| `532c289` | CI: SHA sabitleme, güvenlik iş akışı, gizli anahtar tarayıcısı (G-13) |
| `50f143f` | Uygulama sertleştirmesi (G-1, G-4–G-12) |
| `e1ae2dc` | Bu rapor |
| `4568579`, `ae16f0b` | Windows CI'ın bulduğu hatalar: başarısız kurucunun kilidi, junction döngüsü, test yazımı, ACL testi |
| `baa5905` | `app.enableSandbox()` kaldırıldı (Windows'ta `--no-sandbox` ile çökme) |
| `ca18058` | Bağımsız gözden geçirmenin bulguları (G-7, G-8 düzeltmeleri, G-15, G-16, e-posta, uzun sorgu, kurulum yolu) |

| Alan | Dosyalar |
|---|---|
| Electron ve IPC | `src/main/security.ts` (yeni), `src/main/main.ts`, `src/renderer/index.html`, `quick-search.html`, `settings.html` |
| Veritabanı | `src/db/private-files.ts` (yeni), `src/db/database.ts` |
| Tarayıcı ve indeksleyici | `src/scanner/scanner.ts`, `src/search/indexer.ts`, `src/main/indexer-worker.ts` |
| Ayrıştırıcılar | `src/extractors/*` (bkz. G-3) |
| Geçici dosyalar | `src/shared/private-temp.ts` (yeni), `src/ocr/windows-ocr.ts`, `src/scanner/windows-availability.ts` |
| Paketleme | `scripts/electron-fuses.cjs` (yeni), `package.json` (`afterPack`, bağımlılıklar, `security:*` betikleri) |
| Kaynak–paket ilişkisi | `scripts/build.mjs` (`dist/build-info.json`), `src/main/about-info.ts`, `src/renderer/settings/about-view.ts` |
| Tedarik zinciri | `.github/workflows/security.yml` (yeni), `windows-package.yml`, `windows-placeholder-acceptance.yml`, `scripts/security/scan-secrets.mjs`, `scripts/security/audit-electron.mjs` (yeni) |
| Testler | `tests/security/*.test.ts` (yeni), `tests/search_service.test.ts` (bir statik denetim güncellendi) |

Kullanıcının gördüğü değişiklikler bilinçli olarak az tutuldu:
- Ayarlar › Hakkında'da sürümün yanında derleme commit'i görünür ("Sürüm 0.4.2 · Derleme 1ddcd4bfee65").
- Arama kutularında yazım denetimi (kırmızı alt çizgi) yok.
- Hariç tutulan klasöre giden bir bağlantının altındaki belgeler artık aranmaz.
- Okunurken kilitlenen bir belge "İşlenemeyen belgeler" listesine düşer.

## 5. Çalıştırılan testler ve gerçek sonuçları

Hepsi bu Mac'te (macOS 27, Apple Silicon), 12 Kasım 2026'da çalıştırıldı.

| Ne | Sonuç |
|---|---|
| Tüm test paketi (`npx vitest run`, macOS) | **557 geçti, 0 başarısız, 16 atlandı** (49 dosya). Atlananların hepsi yalnızca Windows'ta çalışan testler. |
| Tip denetimi (`npx tsc --noEmit`) | Hatasız |
| Gizli anahtar taraması (`npm run security:secrets`) | 0 bulgu |
| Bağımlılık taraması (`npm run security:audit`) | Üretim: 0 açık; Electron: 0 açık; tümü: 6 orta (electron-builder → minimatch, yalnızca derleme) |
| Gerçek belge örnekleri (`tests/extractors/real_fixtures.test.ts`, 4 gerçek belge, içerik yazdırılmadan) | 5/5 geçti |
| Gerçek belgelerde eski ve yeni ayrıştırıcı karşılaştırması (yalnızca sayılar) | 1.431 belge (452 DOCX, 587 UDF, 14 DOC, 1.133 PDF'ten 378'i): okunan her belgede metin **bire bir aynı**; yeninin okuyamayıp eskinin okuduğu belge **yok**; 1 `.doc` eski ayrıştırıcıyı süresiz bekletiyordu, yenisi 0,2 sn'de okudu; 11 belge ikisinde de okunamıyor (zaten okunamayan belgeler). Buluttaki 2.132 belge açılmadı. |

**Yeni güvenlik testleri** (`tests/security/`, tamamen sentetik veriyle), istenen 12 senaryoya göre:

| # | Senaryo | Test dosyası | Sonuç |
|---|---|---|---|
| 1 | Hariç tutulan klasöre sembolik bağlantı | `symlink_exclusion.test.ts` (8 test) | Geçti. Eski kodda 8'in 6'sı başarısız; kalan 2'si korunan davranışı (harici diske bağlantı, döngü) sınıyor. |
| 2 | IPC'ye beklenmeyen yol ve parametre | `ipc_and_electron.test.ts` | Geçti |
| 3 | HTML içeren dosya adları ve içerikler | `xss_rendering.test.ts` | Geçti (indeksle, ara, ekrana bas: `<mark>` dışında etiket yok) |
| 4–5 | Bozuk/aşırı büyük UDF/ZIP, hatalı XML | `malicious_documents.test.ts` (50 test) | Geçti: her bomba en fazla 64–256 MiB bellek artışı ve 1–5 sn içinde reddediliyor |
| 6 | Beklenmeyen URL ve protokoller | `ipc_and_electron.test.ts` | Geçti |
| 7 | Veritabanı dosya izinleri | `db_protection.test.ts` | Geçti (macOS'ta; Windows için `windows_acl.test.ts`, bkz. §9) |
| 8 | Geçişte kesinti ve geri alma | `db_protection.test.ts` | Geçti. Eski kodda başarısız. |
| 9 | Yerel indeksleme ve aramada ağ bağlantısı olmaması | `privacy_and_network.test.ts` | Geçti; Node'un tüm bağlantı ve DNS fonksiyonları tuzaklandı (tuzağın çalıştığı ayrı bir kontrol testiyle gösterildi) |
| 10 | Arama sorgusunun kaydedilmemesi | `privacy_and_network.test.ts` | Geçti: sorgu veritabanında, -wal/-shm'de, geçici dosyalarda ve günlükte yok |
| 11 | Değişikliklerden sonra OCR ve arama | Mevcut OCR ve arama testleri + gerçek belge karşılaştırması | macOS'ta geçti. Windows OCR testleri bu makinede çalışmaz (bkz. §9) |
| 12 | Yayımlanan yapılandırmada Electron ayarları | `ipc_and_electron.test.ts` (kaynak) + paketlenmiş uygulama üzerinde canlı deneme (aşağıda) | Geçti |
| — | Silinen metnin dosyada kalmaması | `db_protection.test.ts` | Geçti. Kontrol testi: güvenli silme kapalıyken metin dosyada kalıyor. |
| — | Geçici dosyalar ve indeksleme bekçisi | `temp_and_watchdog.test.ts` | Geçti |

**Paketlenmiş son macOS uygulaması** (`ca18058`'den derlendi, Developer ID ile imzalı, geçici profiller; kullanıcının kendi MetinBul'una ve profiline dokunulmadı):
- İmza geçerli, sigortalar beklendiği gibi.
- `--remote-debugging-port`, `--inspect`, `--remote-debugging-pipe` ve `--js-flags` ile açılış reddediliyor: çıkış kodu 1, port hiç açılmıyor. Bayraksız açılış normal (5/5).

Paketlenmiş uygulama artık hata ayıklama portuyla açılmadığı için sayfa ve uçtan uca denemeler, aynı kodun (`ca18058`) paketlenmemiş hâlinde CDP ile yapıldı: **35 kontrolün 33'ü geçti.** Bir önceki paketlenmiş uygulamada (`50f143f`, bayrak denetimi eklenmeden önce) aynı denemeler pakette yapılmıştı: 38'de 36, aynı iki istisnayla. Kontroller:

- Sayfalarda Node.js yok (`require` ve `process` tanımsız), önyükleme API'si var.
- `openFile('/System/Applications/Calculator.app')` reddedildi, hiçbir uygulama açılmadı.
- Başka siteye `openExternal`, `window.open`, sayfanın başka adrese yönlendirilmesi, sayfadan `fetch` ve satır içi betik engellendi. Biçimi bozuk `addSearchArea` çağrıları reddedildi.
- Uçtan uca: "seçili klasörler" modunda kurulum, sentetik DOCX/PDF/UDF indekslendi ve arandı (Türkçe karakterler dâhil).
- Hariç tutma: hariç tutmadan önce bağlantının arkasındaki klasör aranabiliyordu (kontrol); hariç tutulduktan sonra bulunmuyor.
- İndekslenmiş bir belge Finder'da gösterilebiliyor. Profil klasörü 0700, veritabanı dosyaları 0600.
- (Yalnızca pakette, `50f143f` ve `ca18058`) `ELECTRON_RUN_AS_NODE=1`, `NODE_OPTIONS=--require …` ve `--inspect` ile kod çalıştırılamadı, hata ayıklama portu açılmadı.
- Başarısız iki kontrol, `eval`'ın CSP ile engellendiğini CDP üzerinden ölçme denemesi. Chromium, geliştirici araçlarından çalıştırılan kodu bu yasaktan bilinçli olarak muaf tutuyor, yani bu bir ölçüm sınırı. Politikada `unsafe-eval` olmadığı statik testle, CSP'nin uygulandığı da satır içi betik engeliyle doğrulandı.

## 6. Ağ trafiği envanteri

| Hedef | Başlatan kod | Gönderilen veri | Amaç | Kullanıcı bilgisi |
|---|---|---|---|---|
| `https://api.github.com/repos/raciyuksekbas-hub/metinbul-releases/releases/latest` | `src/main/updater.ts` (`checkForUpdates`). Bir pencere ilk açıldığında 3 sn sonra (`main.ts` `scheduleUpdateCheck`) ve Ayarlar › Hakkında › "Güncellemeleri Denetle" ile | `GET`; başlıklar yalnızca `Accept` ve `User-Agent: MetinBul-App/<sürüm>`. Gövde yok. Belge, sorgu, yol, indeks verisi yok. GitHub, IP adresini ve sürümü görür. | Yeni sürüm bildirimi | Hakkında sayfasında sonuç gösterilir |
| Windows Update | `src/ocr/windows-ocr.ts` `installWindowsTurkishOcr` (`Add-WindowsCapability`) | Windows'un kendi isteği | Türkçe OCR bileşenini yüklemek | Yalnızca kullanıcının bastığı düğmeyle ve UAC onayıyla |
| Kullanıcının tarayıcısı / e-posta istemcisi | `shell.openExternal` | — (MetinBul bağlantı kurmaz, adresi işletim sistemine verir) | Sürümler sayfası, geri bildirim e-postası | Kullanıcının tıklamasıyla; artık yalnızca bu iki hedef |

Bunların dışında ağ kodu yok. Bu, bir testle (`privacy_and_network.test.ts`) kaynak kodu taranarak ve indeksleme ile arama sırasında Node'un bütün bağlantı ve DNS fonksiyonları tuzaklanarak doğrulanıyor.
- **Electron/Chromium:** Sayfalar yereldir; CSP `connect-src 'none'`. Yazım denetimi kapatıldığı için sözlük indirmesi yok. `crashReporter`, otomatik güncelleyici (`autoUpdater`) ya da telemetri yok.
- **Geliştirme ve yayımlanan sürüm farkı:** Ağ davranışı aynı. Tek fark, geliştirme modunda (`npm run dev`) sigortaların uygulanmamasıdır; bu ağla ilgili değildir.

## 7. Veritabanı şifrelemesi (`security/db-encryption` dalı)

Önce dosya izinleri ve güvenli silme tamamlandı (G-7, G-9). Şifreleme ayrı bir dalda, onların üzerine eklendi (`7182554`).

**Nasıl çalışıyor:**
- **Şifreleme:** İndeks SQLite3 Multiple Ciphers ile ChaCha20-Poly1305 kullanılarak şifreleniyor. `better-sqlite3` aynı sürümün (13.0.3) şifreleme destekli derlemesiyle (`better-sqlite3-multiple-ciphers`) değiştirildi. Bu derleme Node-API kullanıyor, hazır ikili dosyalarla geliyor, SQLite sürümü aynı (3.53.4) ve FTS5 trigram araması değişmedi. Kodda başka bir şey değişmesin diye npm takma adıyla kuruldu.
- **Anahtar:** Her profil için rastgele 256 bitlik bir anahtar üretiliyor. Kaynak kodunda ortak ya da sabit bir anahtar yok. Anahtar `metinbul.key` dosyasında (0600), Electron `safeStorage` ile mühürlü duruyor: macOS'ta Anahtar Zinciri, Windows'ta DPAPI. Bağlantılara ham anahtar olarak verildiği için her açılışta yavaş bir anahtar türetme yapılmıyor.
- **Açılışta**, indekse dokunan her şeyden önce (`prepareDatabaseKey`):
  - Yeni kurulum doğrudan şifreli başlıyor.
  - Eski düz indeks bir işçi iş parçacığında yerinde şifreleniyor. Bu, SQLite3MC'nin `rekey` işlemi: geri alma günlüğü altında tek bir işlem. Yarıda kesilirse sonraki açılışta düz indeks olduğu gibi geri geliyor ve işlem yeniden deneniyor. Kesintiden kalan bir günlük, karar verilmeden önce geri sarılıyor.
  - Bu sırada gelen ikinci açılış istekleri bekletiliyor.
- **Anahtar kaybı:** Anahtar Zinciri sıfırlanmışsa ya da profil başka bir bilgisayara kopyalanmışsa, indeks **silinmeden** `metinbul.db.unreadable-<tarih>` adıyla kenara taşınıyor. Yeni bir indeks başlatılıyor ve kullanıcıya bir açıklama gösteriliyor. Belgeler etkilenmiyor; yeniden oluşturulan şey arama indeksi ve MetinBul ayarları. Anahtar geri gelirse, örneğin Anahtar Zinciri yedekten dönerse, eski dosya geri konabilir.
- **Kilitli Anahtar Zinciri:** Sistem anahtarı şu an açamıyorsa hiçbir şeye dokunulmuyor, kullanıcıya söylenip uygulama kapanıyor.
- **Geri dönüş:** `decryptInPlace` indeksi aynı işlem güvencesiyle düz hâle döndürebiliyor; testlerde sınandı.
- **Geliştirme sürümleri:** Anahtar mühürlenmiyor ve `safeStorage` hiç yüklenmiyor. Electron 43'te `safeStorage`'ı içe aktarmak bile Anahtar Zinciri'nde "MetinBul Safe Storage" kaydı oluşturuyor. İmzasız bir sürümün oluşturduğu kayıt, imzalı uygulamanın daha sonra izin istemesine yol açardı. Bu durum test sırasında yaşandı; o test kaydı sizin onayınızla silindi.

**Ölçülen maliyet (4.000 sentetik belge):**

| | Şifresiz | Şifreli |
|---|---|---|
| Arama, sorgu başına | 0,84 ms | 1,13 ms |
| Tüm belgeleri baştan indeksleme (arka planda) | 9,8 sn | 16,2 sn |
| 370 MB'lık düz indeksi yerinde şifreleme | | 6,6 sn |

Bu Mac'teki yaklaşık 718 MB'lık indeksin ilk açılışta şifrelenmesi 13 saniye kadar sürer.

**Koruma sınırı:** Şifreleme; kapalı bir bilgisayarın diskine, yedeklere, başka bir kullanıcı hesabına ve başka bilgisayara kopyalanan bir profile karşı korur. macOS'ta anahtar Anahtar Zinciri'nde MetinBul'un imzasına bağlı olduğu için, aynı hesapta çalışan başka bir program da anahtarı sorusuz alamaz. Ancak MetinBul çalışırken aynı hesaptaki bir programa karşı mutlak koruma sağlamaz. Windows'ta DPAPI, aynı kullanıcının başka programlarını ayırt etmez. Dosya yerinde yeniden yazıldığı için düz hâlin eski blokları APFS ve SSD'de fiziksel olarak silinmeyebilir. Bunları ancak disk şifrelemesi (FileVault, BitLocker) kapsar.

**Testler** (`tests/security/encryption.test.ts`, 15 test):
- Şifreli dosyada metin, ad ve trigram parçası yok (kontrol: düz dosyada var).
- Anahtarsız ya da başka bir anahtarla açılmıyor.
- Geçişte bütün belgeler, ayarlar ve arama korunuyor; geri dönüş de çalışıyor.
- Anahtar dosyası mühürlü ve 0600. Başka bir kullanıcı açamıyor, bozuk dosya bildiriliyor.
- Açılış durumlarının hepsi sınanıyor: yeni, şifreli, geçiş, başarısız geçiş ve yeniden deneme, kayıp anahtar (taşındı, silinmedi), kilitli sistem (hiçbir şeye dokunulmadı).
- **Kesinti testi:** Şifreleme ayrı bir süreçte 8 farklı anda zorla öldürüldü. Her seferinde sonraki açılışta indeks ya bozulmamış düz hâlinde bulunup şifrelendi ya da bozulmamış şifreli hâliyle açıldı. 601 belgenin hepsi duruyordu, `integrity_check` her seferinde `ok` verdi. Bu Mac'te bir öldürme tam yeniden yazmanın ortasına, yarım günlükle denk geldi.

## 8. Bağımlılık güvenlik taraması

| | Önce (`1ddcd4b`) | Sonra |
|---|---|---|
| Üretim bağımlılıkları (`npm audit --omit=dev`) | 2: `adm-zip` yüksek (8 tavsiye), `fast-xml-parser` düşük | **0** |
| Electron (uygulamanın çalışma ortamı) | Yüksek, 9 tavsiye (< 43.8.1) | **0** (43.8.8) |
| Tüm bağımlılıklar | 23 (1 kritik `tar`, 12 yüksek) | 6 orta |

- Kalan 6 orta açık electron-builder'ın bağımlılık ağacında (`minimatch` ReDoS). Bunlar sadece paket derlenirken çalışır ve uygulamaya girmez. npm'in önerdiği "düzeltme" electron-builder 25.1.0'a geri dönmek; bu yapılmadı.
- `adm-zip` artık uygulamayla dağıtılmıyor. Sadece testler ve CI duman testi arşiv üretmek için kullanıyor.
- `word-extractor` 1.0.4 ve `mammoth` için npm'de kayıtlı bir tavsiye yok. Ancak bu çalışmada `word-extractor`'da süreci çökerten üç kusur bulundu ve uygulama içinde yamalandı (G-3). Bu, kütüphanenin geliştiricisine bildirilmeye değer.
- npm 11, bazı paketlerin kurulum betiklerini onay ister hâle geldi. Electron'un ikili dosyası bu yüzden otomatik inmedi; `node node_modules/electron/install.js` ile indirildi (paketteki SHA-256 değerleriyle doğrulanarak).

## 9. Windows ve macOS doğrulama durumu

**macOS (bu makinede doğrulandı):**
- Bütün testler, gerçek belge karşılaştırması ve paketlenmiş uygulama üzerinde canlı deneme yapıldı.
- Sigortalar `@electron/fuses read` ile, imza `codesign --verify --deep --strict` ile, asar bütünlüğü `Info.plist`'te doğrulandı.
- Paket Developer ID ile imzalandı ama notarize edilmedi (test paketi). Yayın için her zamanki `npm run release:mac` süreci gerekir.

**Windows (GitHub Actions, `windows-2022`, son commit `ca18058` üzerinde doğrulandı):** Dal sizin onayınızla özel depoya gönderildi ve taslak PR açıldı ([raciyuksekbas-hub/metinbul#1](https://github.com/raciyuksekbas-hub/metinbul/pull/1)). main'e birleştirilmedi, sürüm yayımlanmadı.
- **Windows Package:**
  - 48 test dosyası geçti. Windows OCR testleri, gerçek dosya sistemi testleri ve `windows_acl.test.ts` dahil. Sonuncusu, indeks klasörünün ve dosyalarının ACL'sinde Everyone, Users, Authenticated Users, Guests ve Anonymous için izin olmadığını SID düzeyinde doğruluyor.
  - Tip denetimi, derleme ve NSIS paketi tamam.
  - Paketlenmiş uygulama açılıyor ve temiz kapanıyor.
  - Bildirim alanı ve arama duman testinin **21 kontrolünün 21'i** geçti: paketteki arama işçisi uzun DOCX belgelerini indeksleyip hepsini buluyor, arama sırasında uygulama yanıt veriyor.
  - Kurma, kısayol, açma ve kaldırma çalışıyor. Kurulum dosyasının SHA-256 değeri kayda yazılıyor.
- **Windows Placeholder Acceptance:** başarılı (şablon ifadesi düzeltmesi dahil).
- **Security (`security.yml`):** bağımlılık ve gizli anahtar denetimleri PR üzerinde başarılı. CodeQL lisans nedeniyle sadece elle çalışıyor ve henüz çalıştırılmadı.
- **Windows'un yakaladığı hatalar** (hepsi düzeltildi, sonra yeniden çalıştırıldı):
  - `app.enableSandbox()` ile `--no-sandbox` birlikte kullanılınca açılışta çökme.
  - Hata veren veritabanı kurucusunun dosyayı kilitli bırakması.
  - Windows 8.3 kısa adları yüzünden bir junction döngüsünün bir tur fazla dolaşılması (bu hata bu çalışmadan önce de vardı).
  - CRLF satır sonları yüzünden test yazım hataları.
  - ACL testinde PowerShell modül sorunu. İlk Windows turunda ACL kontrolü bu yüzden aslında çalışmamıştı; icacls ile yeniden yazılınca çalıştı ve geçti.
- **İndeks şifrelemesiyle (`57d5fbd` ve sonrası):**
  - 49 test dosyası geçti; şifreleme testleri, şifreleme sırasında süreci öldüren kesinti testi dahil.
  - Paketlenmiş uygulama, anahtarı DPAPI ile mühürlenmiş şifreli bir dizinle açıldı.
  - Bildirim alanı ve arama duman testinin **21 kontrolünün 21'i** geçti: belgeler şifreli dizine indekslendi ve hepsi bulundu.
  - Kurma ve kaldırma çalışıyor.
  - Bir turda iki şifreleme testi meşgul çalıştırıcıda 5 sn'lik varsayılan süreyi aştı. Süre 30 sn'ye çıkarılınca geçti.
- **Hâlâ denenmemiş:** gerçek bir kullanıcı bilgisayarında (Windows 10/11, SmartScreen, kurumsal antivirüs) elle kullanım. CI çalıştırıcısı bir sunucu sürümüdür (Windows Server 2022).

**Windows ACL kararı:** MetinBul ACL'leri değiştirmiyor. `%APPDATA%` kullanıcı profilinin ACL'sini devralır. ACL'yi icacls ile değiştiren bir kod, kullanıcıyı kendi verisinden kilitleme riski taşır. Varsayım CI'da yukarıdaki testle doğrulandı.

**Windows sigortaları:** Değiştirilmedi. Windows'ta ödünç alınacak uygulamaya özgü klasör izni yok, CI duman testi de uygulamayı `--inspect` ile sürüyor. İleride duman testi CDP'ye taşınırsa Windows'ta da kapatılabilir.

## 10. Giderilemeyen riskler ve kurumsal kullanım için kalan gereklilikler

**Bilinen kalan riskler:**
1. **İndeks şifrelemesi** (§7) ayrı bir dalda hazır. Birleştirilene kadar yayımlanmış sürümlerde indeks şifresiz. Şifreleme MetinBul çalışırken aynı hesaptaki bir programa karşı mutlak koruma sağlamaz; disk şifrelemesi (FileVault, BitLocker) yine açık olmalıdır.
2. **Önceden silinmiş belgelerin kalıntısı:** Güvenli silme ileriye dönüktür. Eski kalıntıyı temizlemek için tek seferlik `VACUUM` gerekir.
3. **Ayrıştırıcılar aynı süreçte çalışıyor:** İşçi iş parçacığı (worker thread) gerçek bir süreç yalıtımı değildir. Sınırlar ve bekçi çökmeyi ve sonsuz beklemeyi önlüyor, ama bellek hatası türünden (native) bir açık bütün uygulamayı etkiler. Daha güçlü çözüm, ayrıştırmayı kaynakları sınırlı ayrı bir `utilityProcess`'e taşımaktır (mimari değişiklik, ayrı iş).
4. **Windows imzasız:** Kurulum dosyası kod imzası taşımıyor. Kullanıcılar dosyanın MetinBul'dan geldiğini SmartScreen'e güvenerek değil, SHA-256 ile doğrulayabilir.
5. **Derleme kaynağı (provenance):** Uygulama artık hangi commit'ten derlendiğini gösteriyor. Ancak bir SHA-256 değeri, dosyanın o kaynaktan derlendiğini kanıtlamaz, sadece dosyanın değişmediğini gösterir. GitHub'ın derleme kanıtı (`actions/attest-build-provenance`) kullanıcıya ait özel depolarda kullanılamıyor. Windows derlemesi açık `metinbul-source` deposunda yapılırsa kanıt eklenebilir.
6. **Kütüphane iç yapısına bağımlılık:** `word-extractor` yamaları ve mammoth'un `{ file }` girişi. Sürüm yükseltmelerinde testler mutlaka çalıştırılmalı.
7. **Sembolik bağlantıların dışarıyı göstermesi:** Hariç tutulmamış bir yere giden bağlantı bilinçli olarak izlenmeye devam ediyor. Arama alanı dışına çıkan bir bağlantının içeriği de aranır. İstenirse bu bir ayarla kapatılabilir.
8. **Kapsam dışına çıkan ama hariç tutulmayan klasörler:** Bir arama alanı listeden kaldırılırsa ya da "tüm bilgisayar" modundan çıkılırsa eski kayıtlar aramada görünmez ama dosyada kalır. Dosyadan da silinmesi için klasör hariç tutulmalıdır. Bu davranış, takılı olmayan diskin indeksini korumak için değiştirilmedi.

9. **Ulaşılamayan ağ paylaşımları:** İndeksleme işçisi bazı dosya işlemlerini eşzamanlı yapıyor (bu çalışmadan önce de PDF'lerde böyleydi). Bağlı ama yanıt vermeyen bir paylaşım işçiyi bekletebilir; bekçi bunu durdurmaya çalışır, ama işletim sistemi çağrısı dönene kadar işçi kapanmayabilir.
10. **Windows'ta sigortalar ve bayrak denetimi uygulanmadı** (G-4, G-16). Windows'ta ödünç alınacak klasör izni olmadığı için önceliği düşük. CI duman testi `--inspect` ile çalıştığı için önce o testin CDP'ye taşınması gerekir.

**Kurumsal kullanım için öneriler:**
- Taslak PR'ın gözden geçirilip birleştirilmesi ve yeni sürümün (0.4.3) her zamanki yayın süreciyle yayımlanması.
- Windows kurulum dosyası için kod imzalama sertifikası.
- İndeks şifrelemesinin (§7) Windows'ta da sınanıp birleştirilmesi.
- Ayrıştırıcıların ayrı süreçte çalıştırılması (madde 3).
- Bir güvenlik politikası dosyası (`SECURITY.md`): açık bildirme yolu, desteklenen sürümler.
- `metinbul-source` deposunda GitHub'ın ücretsiz gizli anahtar taraması (push protection), CodeQL ve Dependabot'un açılması. Açık depolar için ücretsizdir ve depo ayarı olduğu için kararı size bırakıldı.
- Bağımsız bir sızma testi. Bu rapor bir kaynak kodu incelemesidir, sızma testi değildir.
