# MetinBul 0.4.3 Windows İnceleme Raporuna Yanıt

Tarih: 13 Kasım 2026 · Dal: `fix/windows-review` (`13377d6` = v0.4.4 üzerine)

Bu belge, bir meslektaşın 12 Kasım 2026 tarihli "MetinBul 0.4.3 Windows İnceleme Raporu"ndaki bulguları
tek tek ele alır. Her bulgu önce kaynak kodunda doğrulandı, sonra düzeltildi ve test edildi. Rapordaki
satır numaraları `metinbul-source` deposundaki 0.4.3 koduna göredir.

Testlerin nerede çalıştığı her maddede belirtilmiştir:

- **macOS:** Geliştiricinin Mac'i.
- **Windows CI:** GitHub Actions `windows-2022` çalıştırıcısı.
- **Başsız:** Paketlenmemiş uygulama, ayrı bir deneme profiliyle, pencereler ekranda gösterilmeden
  ve global kısayol alınmadan sürüldü.

Denenemeyenler ayrıca yazılmıştır.

## Özet

| # | Bulgu | Durum |
|---|---|---|
| Y1 | Taranmış PDF'te Windows'ta tümden çökme | Düzeltildi |
| Y2 | "Belgelerim" bağlantısı yüzünden Belgeler taranmıyor | Düzeltildi |
| Y3 | "Bilgisayarın Tümü" Windows'ta yalnız kullanıcı klasörü; AppData taranıyor | Düzeltildi |
| Y4 | Google Drive (G:) Windows'ta "bulutta" sayılmıyor | Düzeltildi (uyarı ile) |
| Y5 | Şapkalı harfler eşleşmiyor | Düzeltildi |
| Y6 | Ctrl+Shift+M başka programların kısayolunu çalıyor | Düzeltildi |
| O1 | Otomatik güncelleme değişmemiş belgelerin metnini okuyor, her 1.000 belgede bir PowerShell | Düzeltildi |
| O2 | SQLite geçici dosyaları şifresiz %TEMP%'e düşebilir | Düzeltildi |
| O3 | Şifreleme başarısız olursa sessizce şifresiz kalıyor | Düzeltildi |
| O4 | PDF sıkıştırma bombası | Düzeltildi (bellek bekçisi) |
| O5 | Kapsam dışı kalan belgelerin metni dizinde kalıyor | Düzeltildi |
| O6 | Kaldırınca dizin, anahtar ve Run kaydı kalıyor | Düzeltildi |
| O7 | Dizin dolaşan profilde (%APPDATA%\Roaming) | Düzeltildi |
| O8 | Güncelleme sürerken yapılan alan değişikliği uygulanmıyor | Düzeltildi |
| O9 | Kapsam süzgeci 1.000 adaydan sonra; metin kopyaları | Kapsam düzeltildi, kopyalar kaldı |
| B1–B6 | Bellek önerileri | 1, 2, 3, 4, 5 yapıldı; 6 ertelendi |
| D1–D12 | Düşük önem | 9'u yapıldı, 3'ü ertelendi (gerekçeli) |
| T1–T2 | Windows'ta iki test sorunu | Düzeltildi |
| G | npm 11 kurulum betikleri | Düzeltildi |

## Yüksek önem

### Y1. Taranmış PDF'te tümden çökme

**Doğrulandı.** pdf.js (pdf-parse içinde) yüklenirken `@napi-rs/canvas` yerel Skia modülünü
yüklüyor. Tek amacı sayfa çizmek için `DOMMatrix`, `ImageData` ve `Path2D` sınıflarını ödünç almak.
Metin çıkarma bunları hiç kullanmıyor. Modül yalnızca dizinleme işçisinde yükleniyor ve işçi her
güncellemenin sonunda kapanıyor. Raporun bulduğu imza (modül bellekten atılmışken
`0xc0000005`) bununla tutarlı.

**Yapılan:**

- `src/extractors/pdfjs-env.ts` pdf.js'e bu üç sınıfın küçük, saf JavaScript karşılıklarını veriyor.
- Yerel modülün yüklenmesi engelleniyor. Modül pakete de konmuyor (`!node_modules/@napi-rs/**`).
  Kurulum dosyası bu sayede küçülüyor.

**Sınama:**

- **Bu Mac'teki 1.037 gerçek PDF:** Eski yöntem (modül yüklü) ile yenisi karşılaştırıldı.
  1.033'ünde metin bayt bayt aynı, 0 fark; 4 dosya ikisinde de okunamadı. Yalnızca sayılar
  yazdırıldı, belge adı ya da içerik yazdırılmadı. Buluttaki dosyalara dokunulmadı.
- **Yeni test:** `tests/extractors/pdf_text_only.test.ts` ayrı bir süreçte PDF okuyup yüklenen
  yerel kütüphaneleri listeliyor; Skia/canvas yok.
- **Windows CI'ın uçtan uca denemesi** (`scripts/windows/indexing-smoke.mjs`):
  - Paketlenmiş uygulama 120 sayfalık taranmış bir PDF'i dizinliyor ve metin tanımadan geçiriyor.
  - İkinci bir güncellemeden ve ikisinin her birinden bir dakika sonra uygulamanın açık kaldığı
    denetleniyor.
  - Windows Uygulama günlüğünde MetinBul için olay 1000 olmamalı.
  - **Sonuç (düzeltme):** Uygulama iki güncellemeden ve sonrasındaki dakikalardan sonra açıktı;
    metin tanıma taramayı aranabilir yaptı; olay günlüğünde MetinBul için hiçbir kayıt yok.
- **Çökmenin eski kodda yeniden üretimi:** 0.4.4 kodu aynı denemeyle ayrıca çalıştırıldı.
  - **Sonuç (0.4.4):** Kurulumdan yaklaşık 100 saniye sonra kapandı.
  - Olay günlüğü raporla birebir aynı: `Faulting module name: skia.win32-x64-msvc.node_unloaded`,
    `Exception code: 0xc0000005`.
  - Yani çökme CI'da üretilebiliyor ve düzeltme onu gideriyor.
  - Not: İlk tanı çalışmasında denemenin kendisinde bir açık vardı. Uygulama ölünce bekleyen istek
    yanıtsız kalıyor ve betik 0 koduyla çıkıyordu. Düzeltilip yeniden çalıştırıldı.

### Y2. "Belgelerim" bağlantısı Belgeler'i gizliyor

**Doğrulandı** (`scanner.ts`): Klasör, okunmadan önce "gezildi" sayılıyordu. Türkçe Windows'ta
"Belgelerim", "Documents"tan önce sıralandığı için asıl Belgeler atlanıyordu.

**Yapılan:**

- Klasör ancak listesi okunabildiğinde gezilmiş sayılıyor.
- Aynı düzeyde gerçek klasörler bağlantılardan önce okunuyor. Böylece belgeler kendi yollarıyla
  dizinleniyor.

**Sınama:** `tests/scanner/unlistable_link.test.ts`:

- Eski kodda başarısız oluyor, yenisinde geçiyor.
- Windows CI'da gerçek bir junction'la ve `icacls /deny *S-1-1-0:(RD) /L` ile de çalışıyor.

### Y3. "Bilgisayarın Tümü" Windows'ta yalnız kullanıcı klasörü

**Doğrulandı** (`roots.ts`).

**Yapılan:**

- **Kapsam:** Windows'ta kullanıcı klasörüne ek olarak bilgisayarın diğer yerel sabit diskleri
  (D:, E: …) taranıyor; macOS'taki `/Volumes` gibi.
  - Sistem diski kullanıcı klasörüyle temsil ediliyor; C:\ kökü taranmıyor.
  - Ağ, çıkarılabilir ve optik sürücüler taranmıyor. Google Drive diski de taranmıyor (Y4).
  - Diskler `Win32_LogicalDisk` ile bir kez listeleniyor.
- **Hiçbir zaman taranmayanlar:**
  - Kullanıcı açıkça seçse de: `$Recycle.Bin`, `System Volume Information`, `$WINDOWS.~BT` vb.
  - Disk kökündeki `Windows`, `Program Files`, `ProgramData` vb. (kullanıcı o klasörün kendisini
    seçmediyse).
  - Kullanıcı klasöründeki `AppData` (içinden bir klasör seçilmediyse).
- **Arayüz:** Ayarlar ve kurulum ekranındaki açıklama Windows'ta neyin tarandığını söylüyor.

**Sınama:** `tests/scanner/windows_roots.test.ts`. Disk listesi, Google Drive tanıma ve geri dönüşüm
kutusu testleri her yerde, Windows'a özgü kurallar Windows CI'da çalışıyor.

### Y4. Google Drive diski

**Doğrulandı.** Google Drive diski Windows'a FAT32 biçimli yerel disk olarak görünüyor ve bulut
öznitelikleri taşımıyor; MetinBul dosyanın bilgisayarda olup olmadığını anlayamıyor.

**Yapılan:**

- Disk, "Google Drive" etiketinden tanınıyor ve "Bilgisayarın Tümü"ne girmiyor.
- Kullanıcı o diskten klasör eklerken ne olacağı söyleniyor ve onayı isteniyor: "okudukça Google
  Drive indirir".
- Yayın README'sindeki "indirmeden atlar" ifadesi Windows için düzeltilecek (sürüm yayımlanırken).

**Sınama:** Etiket tanıma birim testinde. Gerçek bir Google Drive kurulumuyla **denenmedi**.

### Y5. Şapkalı harfler

**Doğrulandı.**

**Yapılan:**

- **Normalleştirme:** Dizinleme ve arama â, î, û harflerini a, i, u sayıyor. Harf sayısı
  değişmediği için alıntıda belgenin kendi yazımı ("şikâyet") vurgulanıyor.
- **Yükseltme:** 0.4.4'ün dizin tablosu, ilk güncellemede dizinleme işçisinde bir kez yeniden
  kuruluyor.
  - 200 belgelik parçalar halinde ilerliyor; tablo bitince yerine geçiyor.
  - Yükseltme sırasında arama eski tabloyla, kendi biçimiyle sürüyor.
  - Arada değişen ya da silinen belgeler yerine geçme anında düzeltiliyor.
  - Yarıda kalırsa bir sonraki güncellemede baştan başlıyor.
- **Ö/Ç/Ş… harflerini düz harfe katlama** (isteğe bağlı) bu sürümde yok.

**Sınama:**

- `tests/search/circumflex_and_upgrade.test.ts`: iki yazımın birbirini bulması, eski tablonun
  yükseltilmesi, yükseltme sırasında değişen/silinen belgeler, yarıda kalan yükseltme.
- Başsız uygulamada "şikayet" iki yazımı da buldu.
- 2.200 belgelik, 140 MB metinli, şifreli eski bir dizin 15,7 saniyede ve +54 MB bellekle yükseltildi.

### Y6. Kısayol

**Doğrulandı.**

**Yapılan:**

- **Varsayılan:** Windows varsayılanı **Ctrl+Alt+Space**. Kendi kısayolunu seçmiş kullanıcınınki
  korunuyor.
- **Geçerlilik:** Kısayolda Ctrl, Alt ya da Cmd/Windows tuşu şart (yalnız Shift'li olanlar
  reddediliyor). Ctrl+C/V/X/Z/S…, Alt+F4, Alt+Tab, Cmd+Space ve Windows tuşlu sistem
  kısayolları gerekçesiyle reddediliyor.
- **Kaydedici düzeltmesi:** Windows tuşu artık "Super" olarak kaydediliyor. Eskiden "Command"
  yazılıyordu ve Electron bunu Windows'ta tanımıyor.
- **Kurulum ekranı:** Kısayol gösteriliyor ve orada değiştirilebiliyor.

**Denenmedi:** Ctrl+Alt+Space'in Office, Teams, Chrome ve Türkçe klavyelerle gerçekten
çakışmadığı bir ofis bilgisayarında. Rapordaki öneri gibi yayından önce denenmeli.

## Orta önem

- **O1. Değişmemiş belgeler:**
  - Karar artık metin okunmadan veriliyor (yol, değişiklik zamanı, boyut, durum).
  - Windows öznitelik denetimi yalnız okunacak (yeni, değişmiş ya da bekleyen) dosyalara uygulanıyor;
    değişiklik yoksa hiç PowerShell açılmıyor. Test: `tests/windows_placeholder.test.ts`.
- **O2. Geçici dosyalar:** Şifreli dizinde `PRAGMA temp_store = MEMORY`, yazan ve okuyan
  bağlantıların hepsinde.
- **O3. Şifreleme hatası görünür:**
  - Ayarlar › İndeks'te kalıcı uyarı, Hakkında'da "Arama dizini: şifreli / şifrelenmemiş" satırı.
  - Şifrelemeden önce boş disk alanı denetleniyor (dizin boyutu + 64 MB).
- **O4. PDF bombası:**
  - **Ölçüm:** Gömülü yazı tipi 1 GB'a açılan 1 MB'lık bir PDF belleği yaklaşık 2 GB'a çıkardı.
    İçerik akışı bombası (4 GB'a açılan) ise 600 MB'ta kaldı.
  - **Bekçi:** Belge okunurken uygulamanın belleği izleniyor. Bilgisayar belleğinin %40'ını
    (1,5–3 GB arası) aşınca güncelleme durduruluyor ve belge "işlenemeyen" olarak kaydediliyor.
  - **Sınama:** Windows CI'da sınır 700 MB'a düşürülerek 1 GB'a açılan bir yazı tipi
    bombasıyla denendi.
    - Uygulama ayakta kaldı ve uygulamanın günlüğünde bekçinin satırı göründü.
    - Bomba "işlenemeyen" olarak kaydedildi.
    - Klasördeki diğer belge dizinlendi.
- **O5. Kapsam dışı belgeler:**
  - Kaldırılan arama alanının ya da kapsam değişikliğinin belgeleri metinleriyle siliniyor.
  - Bağlı olmayan bir diskteki belgeler, disk geri gelene kadar korunuyor. Windows diskleri
    listeleyemezse hiçbir şey silinmiyor.
  - Ayarlar › İndeks'te "Dizini sil ve yeniden oluştur" var; dosya da küçülüyor.
- **O6. Kaldırıcı** (`build/installer.nsh`, güncellemede çalışmaz):
  - Bu MetinBul'u başlatan bütün Run değerleri, adı ne olursa olsun, siliniyor.
  - Arama dizininin de silinip silinmeyeceği soruluyor. Sessiz kaldırmada dizin korunuyor.
  - Windows CI bunları kurup kaldırarak denetliyor.
- **O7. Dolaşan profil:**
  - Dizin ve anahtarı `%LOCALAPPDATA%\MetinBul`'a bir kez taşınıyor.
  - Taşıma başarısız olursa her şey yerine dönüyor.
  - Windows CI, 0.4.4 düzenindeki bir dizinin taşındığını denetliyor.
- **O8. Güncelleme sırasında alan değişikliği:** Süren güncelleme belgeler arasında durduruluyor ve
  yeni ayarlarla yeniden başlıyor.
- **O9. Arama:**
  - Kapsam koşulu SQL'de, 1.000 aday sınırından önce uygulanıyor. Eski kodda başarısız olan bir
    testle doğrulandı.
  - "Her sonuçta metnin birkaç kez kopyalanması" bu sürümde değişmedi.

## Bellek (B)

1. **Donanım hızlandırması:** Windows'ta kapatıldı.
2. **Arama işçisi:** 3 dakika boşta kalınca kapanıyor; bir sonraki arama yenisini açıyor.
3. **Metnin ikinci kopyası:** Dizin tablosu artık metnin ikinci bir kopyasını tutmuyor
   (içeriksiz FTS5, `contentless_delete`). Ölçüm: 3.000 belgelik sentetik dizinde %28 küçük.
   - Yükseltilen dizinlerde boşalan yer dosyanın içinde yeniden kullanılıyor; dosya hemen
     küçülmüyor. "Dizini sil ve yeniden oluştur" onu da küçültür.
   - Doldurma artık sayfa sayfa yapılıyor (`.all()` yok).
4. **Otomatik güncellemede metin okunmuyor:** O1 ile aynı.
5. **OCR betiği:** Her sayfadan sonra bitmap, akış ve sayfa nesnelerini bırakıyor.
6. **Hızlı Arama penceresini ilk basışta kurmak:** Ertelendi. Kazanç ~25 MB, bedeli ilk açılışta
   gecikme; kısayolun anında yanıt vermesi tercih edildi.

## Düşük önem

| Bulgu | Durum |
|---|---|
| Hızlı Arama Windows'ta odak kaybedince kapanmıyor | Düzeltildi |
| Pencereler ekran paylaşımı/kayıt/Recall'a açık | Ayarlar › Genel › Gizlilik: "Ekran paylaşımında ve kayıtlarda MetinBul'u gizle" (varsayılan kapalı) |
| Hızlı Arama hep ilk açıldığı ekranda | İmlecin bulunduğu ekranda açılıyor (aynı ekrandaysa kullanıcının yeri korunuyor) |
| Windows'ta Electron sigortaları açık | **Ertelendi.** Windows CI'ın paket denemeleri uygulamayı `--inspect` ile sürüyor; ayrıca Windows'ta anahtarı koruyan DPAPI, aynı kullanıcıyla çalışan her programa zaten açık. Sigortalar ayrı bir test derlemesiyle birlikte ele alınmalı. |
| Sayfadan gelen UNC yolları | Ağ yolları yalnızca klasör seçicinin döndürdüğüyse kabul ediliyor |
| Kısıtlı Dil Kipi'nde OCR sessizce kayboluyor | Ayarlar › İndeks'te söyleniyor. Betikleri imzalamak ve kurucuyu imzalamak **ertelendi** (kod imzalama sertifikası gerekir). |
| powershell.exe adıyla başlatılıyor | Tam yolla başlatılıyor |
| Öznitelik okuyucusu zaman aşımında hepsi "bulutta" | "Denetlenemedi" ayrı sayılıyor, okunmuyor, kayıtları korunuyor |
| OCR bütçesi belge içinde bölünmüyor | **Ertelendi.** Kısmi tanıma sonuçlarını belgeler arası saklamak dizin biçiminde değişiklik gerektiriyor. |
| Anahtar kaybında eski anahtar eziliyor | Eski anahtar, kenara taşınan dizinin yanında aynı damgayla saklanıyor |
| Windows'a "Anahtar Zinciri" iletisi | Windows için ayrı metin |
| Güncelleme denetiminde zaman aşımı/proxy yok | 10 sn zaman aşımı, Electron `net.fetch` (sistem proxy'si) |
| Windows'ta `icon.icns` | Windows'ta `icon.ico` |

## Testler ve geliştirme

- `windows_real_fs.test.ts`: 1.200 dosyalık denemeye 30 sn.
- `rc_smoke.test.ts`: artık kendine ait geçici bir ev klasöründe çalışıyor. Gerçek Masaüstü ve
  Belgeler'e dokunmuyor.
- npm 11: `package.json`'daki `allowScripts` esbuild'in kurulum betiğini onaylıyor. README nasıl
  yapılacağını anlatıyor.

## Sonuçlar

- **macOS:** 615 test geçti, 20'si (Windows'a özgü) atlandı. Tür denetimi temiz.
- **Başsız uygulama denetimi:** 21/21.
- **Windows CI (düzeltme dalı,**
  [çalışma 43424251137](https://github.com/raciyuksekbas-hub/metinbul/actions/runs/43424251137)**):**
  - 611 test geçti, 24'ü (macOS'a özgü) atlandı.
  - Bildirim alanı ve arama denemesi geçti.
  - Taranmış PDF ve bellek bombası denemesi geçti.
  - Kurulum ve kaldırma denemesi geçti:
    - 0.4.4 düzenindeki dizin `%LOCALAPPDATA%\MetinBul`'a taşındı.
    - Kaldırıcı MetinBul'un iki Run kaydını sildi, başka programınkine dokunmadı.
    - Sessiz kaldırmada dizin korundu.
  - Kurulum dosyası 135 MB (0.4.4: 144 MB).
- **Windows CI (0.4.4 tanı,**
  [çalışma 43421058668](https://github.com/raciyuksekbas-hub/metinbul/actions/runs/43421058668)**):**
  çökme yeniden üretildi (yukarıda).

Denenmeyenler:

- Gerçek bir Google Drive kurulumu.
- Ctrl+Alt+Space'in bir ofis bilgisayarındaki programlarla çakışmaması.
- Gerçek bir dolaşan profil ya da etki alanı.
- Kısıtlı Dil Kipi'nde metin tanıma uyarısı.
- Kaldırıcıdaki "dizin de silinsin mi?" sorusunun ekranda görünüşü. CI yalnızca sessiz kaldırmayı
  denedi.
