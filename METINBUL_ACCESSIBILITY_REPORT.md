# MetinBul — Erişilebilirlik Raporu

**Kapsam:** macOS VoiceOver, Windows Narrator, Windows NVDA, Windows JAWS
**Sürüm:** 0.3.0 (yayınlanmamış erişilebilirlik turu)
**Tarih:** 2026-09-03

---

## Status

**CONDITIONAL GO**

Uygulamanın erişilebilirlik mimarisi standarda dayalı hâle getirildi ve tanım gereği
tamamlanması gereken senaryo teknik olarak mümkün: sonuç listesi artık gerçek bir
liste/düğme koleksiyonu, eşleşme bağlamı metin olarak sunuluyor, tüm duyurular tek bir
Türkçe kanaldan geçiyor ve modallar odak yönetimi uyguluyor.

Koşul: **hiçbir ekran okuyucuda gerçek cihaz doğrulaması yapılmadı.** Bu turda çalışan
ortamda VoiceOver, Narrator, NVDA veya JAWS bulunmuyordu. Doğrulama, tarayıcı
erişilebilirlik ağacının doğrudan incelenmesi ve otomatik kapılarla yapıldı. Dört ekran
okuyucunun tamamı manuel sürüm kapısı olarak açık bırakıldı.

---

## Implemented

### Kritik düzeltmeler

| # | Sorun | Durum |
|---|---|---|
| 1 | Sonuç satırları `<div onclick>` idi: role, accessible name ve tab durağı yoktu — klavyeyle ulaşılamıyordu | Düzeltildi |
| 2 | Hiçbir live region yoktu; sonuç sayısı hiç duyurulmuyordu | Düzeltildi |
| 3 | Eşleşme bağlamı yalnızca görsel `<mark>` ile taşınıyordu | Düzeltildi |
| 4 | `outline: none` (style.css:275, :540) odak göstergesini yok ediyordu | Düzeltildi |
| 5 | Dialoglarda `aria-modal` vardı ama accessible name, focus trap, focus restore yoktu | Düzeltildi |
| 6 | Arama kutusunun etiketi yalnızca placeholder idi | Düzeltildi |
| 7 | Hızlı Arama'da ok tuşları yalnızca görsel bir sınıf değiştiriyordu; seçim ekran okuyucuya hiç bildirilmiyordu | Düzeltildi |
| 8 | Dekoratif SVG ikonlar ve `✕` glifleri accessibility tree'de açıkta kalıyordu | Düzeltildi |
| 9 | Pencere arka plandan öne geldiğinde renderer haberdar olmuyordu: odak ve duyuru yoktu | Düzeltildi |
| 10 | Aynı isimli ("Kaldır") düğmeler hangi klasöre ait olduklarını söylemiyordu | Düzeltildi |

### Yeni modüller

| Dosya | Sorumluluk |
|---|---|
| `src/shared/a11y-text.ts` | Saf Türkçe accessible-text katmanı. DOM/Electron/arama motoru bağımlılığı yok, doğrudan unit test edilir. |
| `src/renderer/announcer.ts` | Merkezî `announce(message, priority)`. Kalıcı polite/assertive bölgeler, tekrar bastırma. |
| `src/renderer/focus-trap.ts` | Modal focus trap, Escape, focus restore, kardeş düğümlerin `aria-hidden` ile gizlenmesi. |
| `src/renderer/a11y-prefs.ts` | Erişilebilirlik tercihleri (§24). Tamamen yerel, saf çözümleme fonksiyonları. |

### Değiştirilen yüzeyler

- `index.html` — landmark'lar (`banner`/`search`/`main`/`contentinfo`/`navigation`), kalıcı live
  region çifti, skip link, dialog başlıkları, `type="search"`, gerçek `<label>`'lar.
- `quick-search.html` — combobox + listbox yapısı, gerçek etiket, live region'lar.
- `result-card.ts` — list/listitem + gerçek `<button>`; Hızlı Arama için `role="option"` modu.
- `renderer.ts` — duyurular, odak yönetimi, Erişilebilirlik ayarları bölümü, hata durumları.
- `quick-search.ts` — `aria-activedescendant` ile seçim, odak metin alanında kalır.
- `style.css` — `.visually-hidden`, `:focus-visible`, forced-colors, reduced-motion, metin ölçekleme.
- `quick-search-shortcut.ts` / `main.ts` — ekran okuyucu modifier tuşlarının kısayol olarak
  atanmasını engelleyen guard.

---

## Turkish Accessibility Locale

- `<html lang="tr">` her iki sayfada mevcut; hiçbir yerde `lang="en"` yok.
- Tüm accessible name, description, status, error, live announcement, dialog title,
  result summary, filter state ve loading state Türkçe.
- macOS menüleri (Dosya, Düzen, Görünüm, Pencere, Yardım, MetinBul Hakkında,
  MetinBul'dan Çık, Pencereyi Kapat, MetinBul'u Gizle) **zaten Türkçeydi** — bu turda
  değiştirilmedi, yalnızca doğrulandı. Native dosya seçici işletim sistemi dilini takip
  etmeye devam ediyor.
- Sayılar `tr-TR` ayracıyla biçimlendiriliyor (`1.234`), böylece Türkçe ses doğru okuyor.

Örnek çıktılar (unit test ile doğrulanmıştır):

```
Sonuç 1 / 12. Merve.udf. 4 eşleşme.
Sonuç 3 / 18. Merve Işık İstinaf.udf. 4 eşleşme. Belgeler klasörü.
Eşleşme 2 / 4. Aranan ifade: tahliye. Bağlam: Davacının kiralanana olan ihtiyacı gerçek, samimi ve zorunludur.
Aranıyor.
18 sonuç bulundu.
Sonuç bulunamadı.
Arama tamamlanamadı.
UDF, seçili.
Ayarlar, iletişim kutusu.
```

---

## Keyboard Navigation

- Tab / Shift+Tab / Enter / Space / Escape her durumda çalışır.
- Pozitif `tabindex` yok; keyboard trap yalnızca açık modallarda ve kasıtlı.
- Sayfa başında "Arama alanına geç" skip link'i.
- Sonuç satırının birincil eylemi gerçek bir `<button>`; ayrıca "Aç" ve "Klasörde Göster"
  düğmeleri korundu.
- Eşleşme pasajları **odak durağı değil**: ekran okuyucunun kendi öğe navigasyonuyla
  gezilen düz liste metni. Browse mode'u bozacak özel klavye ele geçirme yok.
- Hızlı Arama'da ok tuşları odağı taşımaz; `aria-activedescendant` ile aktif seçenek
  bildirilir, odak metin alanında kalır.
- Kısayol kaydetme modu global keydown yakalar; bu durum artık duyuruluyor ve Escape ile
  iptal edilebiliyor.

---

## Search / Results Accessibility

- Arama alanı `type="search"`, accessible name **"Belgelerde ara"**, açıklaması
  "Aramak istediğiniz kelime veya ifadeyi yazın. Sonuçlar siz yazdıkça listelenir."
- Placeholder tek başına etiket olarak kullanılmıyor.
- Temizleme düğmesi gerçek `<button>`, accessible name **"Aramayı temizle"**; ikon glifi
  `aria-hidden`. Temizlemeden sonra odak arama alanına döner.
- Sonuç listesi `role="list"`, adı sayıyı taşır: "Arama sonuçları, 18 belge".
- Her satır tek anlamlı birim olarak duyurulur; rozet/dosya adı/eşleşme sayısı görselleri
  `aria-hidden` olduğu için ikinci kez okunmaz.
- Arama tamamlandığında odak **zorla sonuçlara atılmaz**; yalnızca sayı duyurulur (§18).
- Sıralama `<select>`'i gerçek `<label>` ile etiketlendi.

---

## Match Context Accessibility

En kritik alan, spec §12–§13.

- Her eşleşme pasajı için görsel `<mark>` **`aria-hidden`**; aynı bilgi metin olarak
  yeniden ifade edilir: `Eşleşme 2 / 4. Aranan ifade: tahliye. Bağlam: …`
- Böylece aranan kelime bağlamdan kopuk şekilde ikinci kez okunmaz.
- Satırın `aria-describedby`'ı listedeki **ilk pasajın kendisini** işaret eder; ayrı bir
  kopya üretilmez. (Bu, doğrulama sırasında bulunan gerçek bir hataydı: ilk sürümde
  açıklama düğümü ilk pasajı birebir tekrarlıyordu ve NVDA/JAWS satırı gezerken aynı
  bağlamı iki kez okurdu. Tarayıcı erişilebilirlik ağacında tespit edilip düzeltildi ve
  regresyon testi eklendi.)
- Belgede gösterilenden fazla eşleşme varsa: "Bu belgede 2 eşleşme daha var."
- Görsel highlight hiçbir zaman tek bilgi taşıyıcısı değil.

---

## macOS VoiceOver

**MANUAL REQUIRED**

Gerçek VoiceOver ile test edilmedi. Semantik yapı VoiceOver'ın beklediği standart
list/listitem, button, combobox/listbox ve dialog kalıplarını kullanıyor; macOS menüleri
Türkçe. §32'deki 13 adımlık plan çalıştırılmalıdır.

## Windows Narrator

**MANUAL REQUIRED**

Windows ortamı bu turda mevcut değildi. §33 planı çalıştırılmalıdır.

## Windows NVDA

**MANUAL REQUIRED**

§34 planı çalıştırılmalıdır. Özellikle kontrol edilecekler: browse/focus mode geçişleri,
aynı metnin iki kez okunması (bu tur bir vaka bulundu ve düzeltildi — regresyon açısından
en riskli alan burası), live region tekrarları, sonuç listesinin atlanması.

## Windows JAWS

**MANUAL REQUIRED**

§35 planı çalıştırılmalıdır. Özellikle: virtual cursor DOM sırasını mantıklı algılıyor mu,
modal açıldığında arka plan içeriğinde kalıyor mu (kardeş düğümler `aria-hidden`
yapılıyor, ancak gerçek doğrulama gerekir), forms/focus mode'da arama kutusu davranışı.

---

## Cross-Screen-Reader Matrix

Gerçekte çalıştırılmamış hiçbir test PASS olarak işaretlenmemiştir.

| Senaryo | VoiceOver | Narrator | NVDA | JAWS |
|---|---|---|---|---|
| Uygulama açılışı | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED |
| Arama alanı | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED |
| Arama başlatma | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED |
| Sonuç duyurusu | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED |
| Sonuç navigasyonu | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED |
| Match context | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED |
| Filtreler | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED |
| Dialoglar | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED |
| Focus restore | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED |
| Belge açma | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED | MANUAL REQUIRED |

---

## Automated Gates

`npm test` — 288 test geçti, 11 atlandı (erişilebilirlik turu öncesi: 220 geçti).
68 yeni test eklendi: `tests/a11y_text.test.ts`, `tests/a11y_markup.test.ts`,
`tests/a11y_prefs.test.ts`.

| Gate | Kapsam | Sonuç |
|---|---|---|
| A11Y-A | Keyboard-only navigation (skip link, pozitif tabindex yok, activedescendant) | PASS |
| A11Y-B | Searchbox semantics (gerçek label, `type="search"`, combobox) | PASS |
| A11Y-C | Search result semantics (list/listitem, gerçek button, aria-selected) | PASS |
| A11Y-D | Match context accessible (metin karşılığı, çift okuma yok) | PASS |
| A11Y-E | Modal/focus management (role+modal+name, trap, Escape, restore) | PASS |
| A11Y-F | Turkish accessibility locale | PASS |
| A11Y-G | 200% text scaling | PASS |
| A11Y-H | Reduced motion | PASS |
| A11Y-I | Windows forced colors | PASS (yalnızca statik/CSS düzeyinde — aşağıya bakınız) |
| A11Y-J | No color-only information | PASS |
| A11Y-K | Live announcements (tek kanal, assertive yalnızca hata) | PASS |
| A11Y-L | Screen-reader-safe keyboard shortcuts | PASS |

### Doğrulama yöntemi

Otomatik testlerin ötesinde, **gerçek erişilebilirlik ağacı** Chromium'da doğrudan
incelendi (`src/renderer/*` kaynaklarından derlenen bir harness ile):

- Ana pencere ağacı: `search "Belge arama"` → `textbox` → `list "Arama sonuçları, 2 belge"`
  → `listitem` → `button "Sonuç 1 / 2. Merve Işık İstinaf.udf. 4 eşleşme. Belgeler klasörü."`
- Hızlı Arama ağacı: `combobox` → `listbox "Arama sonuçları"` → `option "Sonuç 1 / 2. …"`
  (option içinde interaktif alt öğe yok — listbox kalıbı için doğru).
- 200% ölçekte: yatay taşma yok, metin kırpılmıyor, footer satır kaydırıyor.
- `aria-hidden` ve `aria-describedby` bağlantıları DOM üzerinde doğrudan doğrulandı.

**Bu, gerçek ekran okuyucu doğrulaması değildir.** Erişilebilirlik ağacının doğru olması
gerekli koşuldur, yeterli koşul değildir.

---

## Known Limitations

1. **Hiçbir ekran okuyucuda gerçek cihaz testi yapılmadı.** Dördü de manuel sürüm kapısı.
2. **Forced colors yalnızca statik olarak doğrulandı.** `@media (forced-colors: active)`
   bloğu yazıldı ve testlerle korunuyor, ancak Windows High Contrast altında görsel
   doğrulama yapılmadı. Gerçek Windows makinesi gerekiyor.
3. **Metin ölçekleme `zoom` ile uygulanıyor.** Düzen baştan sona `px` ile boyutlandığı için
   `font-size` çarpanı yeterli olmazdı; `zoom` tüm belgeyi yeniden akıtır. Chromium'da
   doğrulandı (MetinBul yalnızca Electron'da çalışır), ancak bu Chromium'a özgü bir
   davranıştır.
4. **Tray/menu bar ikonu yok.** §16'nın tray bölümü uygulanamaz; arka plan davranışı
   pencere geri yükleme yolu üzerinden ele alındı.
5. **Sonuç pasajlarındaki çift üç nokta (`……`) görsel bir kusurdur** ve bu turdan öncesine
   aittir (`search.ts` zaten `…` ekliyor, `result-card.ts` bir daha ekliyor). Ekran
   okuyucu metninde temizleniyor; görsel düzeltme kapsam dışı bırakıldı.
6. **macOS varsayılan global kısayolu `Alt+Space`** hiçbir ekran okuyucuyla çakışmıyor,
   ancak macOS'ta metin alanlarında kırılmaz boşluk girişini gölgeler. Değiştirilebilir ve
   Ayarlar'da görünür; ürün kararı olarak korundu.

---

## Remaining Manual Tests

Sürüm öncesi kapatılması gereken kapılar:

- [ ] **VOICEOVER MANUAL — REQUIRED** (§32, 13 adım, macOS)
- [ ] **NARRATOR MANUAL — REQUIRED** (§33, Windows)
- [ ] **NVDA MANUAL — REQUIRED** (§34, 16 adım, Windows) — çift okuma ve live region
      tekrarına özel dikkat
- [ ] **JAWS MANUAL — REQUIRED** (§35, 17 adım, Windows) — virtual cursor ve modal
      sınırlarına özel dikkat
- [ ] Windows High Contrast altında görsel doğrulama (§21)
- [ ] Windows'ta %200 metin ölçekleme + ekran okuyucu birlikte

---

## Kapsam Dışı Bırakılanlar

Spec §39 uyarınca bu turda yapılmadı, yalnızca kaydedildi:

- Arama algoritması, indexer, extractor'lar ve veritabanı katmanına dokunulmadı.
- Ürün görsel tasarımı korundu; tek görünür değişiklik dosya adının artık bir düğme
  olması (görsel olarak aynı) ve odak göstergelerinin görünür hâle gelmesi.
- `……` çift üç nokta kusuru (yukarıda kayıtlı).
- Telemetri, bulut TTS, uzak accessibility SDK veya ekran okuyucu tespiti **eklenmedi**;
  yerel-öncelikli mimari korundu (§38). Erişilebilirlik tercihleri yalnızca
  `localStorage`'da tutuluyor.
- Ürün kodunda hiçbir ekran okuyucu tespiti veya reader'a özel dallanma yok (§37).
