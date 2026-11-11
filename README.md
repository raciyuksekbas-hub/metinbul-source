# MetinBul — kaynak kodu

MetinBul, Windows ve macOS'ta DOC, DOCX, PDF ve UDF belgelerinin içinde arama
yapan bir masaüstü uygulamasıdır. Belgeler bilgisayarda işlenir, hiçbir yere
gönderilmez.

Uygulamayı indirmek için:
https://github.com/raciyuksekbas-hub/metinbul-releases

## Lisans

MIT. Ayrıntılar `LICENSE` dosyasında.

## Geliştirme

Node.js 22 veya üzeri gerekir. macOS'ta metin tanıma yardımcısını derlemek için
Xcode komut satırı araçları da gerekir.

```bash
npm ci
npm test
npm run dev          # uygulamayı geliştirme modunda açar
npm run package:mac  # macOS paketi (imzalama: docs/macos-signing.md)
npm run package:win  # Windows kurulum dosyası
```

Gerçek belgelerden oluşan birkaç test örneği, gizlilik nedeniyle yayınlanan
kaynak paketinde yer almaz.
