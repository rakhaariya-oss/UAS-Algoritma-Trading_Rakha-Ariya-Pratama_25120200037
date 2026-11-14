# Indodax Dry Run Bot

Bot trading kripto dry run yang dirancang untuk UAS Algorithmic Trading. Proyek ini dibuat untuk dideploy di Vercel dan memanfaatkan data publik Indodax tanpa API key.

## Fitur utama

- Data live dan dry-run runtime dari API publik Indodax
- Backtest historis native IDR dari Indodax history_v2
- Validasi candle untuk menghindari look-ahead bias
- Order book validation dan execution simulasi dry run
- Risk management: daily loss limit, kill switch, max positions
- Idempotency per candle
- Cron endpoint dengan CRON_SECRET
- Backtest historis dan script hitung ulang
- Dashboard paper-trading dengan status risiko, posisi, trade, dan activity log
- Perbandingan metrik backtest dan forward test dari file laporan JSON
- HTML offline mandiri di `index.html`

## Struktur proyek

- `lib/indodax.ts` — data fetching dan validasi
- `lib/strategy.ts` — sinyal strategi trend breakout
- `lib/execution.ts` — simulasi execution dan fee
- `lib/risk.ts` — manajemen risiko dan state portfolio
- `lib/storage.ts` — penyimpanan state memori lokal atau Upstash/Vercel KV REST
- `lib/dashboard-metrics.ts` — kalkulasi metrik dan validasi report
- `app/api/tick/route.ts` — endpoint cron Vercel
- `app/api/dashboard/route.ts` — snapshot portfolio, sinyal universe, dan log bot
- `app/dashboard.tsx` — dashboard operasi paper-trading
- `public/dashboard.html` — viewer report HTML mandiri/offline
- `scripts/backtest.ts` — backtest 3 tahun, buat JSON report, dan bundle seed HTML offline
- `scripts/freeze_offline_dataset.ts` — downloader historis Indodax; memerlukan akses endpoint Indodax
- `scripts/hitung_ulang.ts` — hitung ulang dan verifikasi arsip replay historis dari candle mentah
- `app/page.tsx` — entry point dashboard

## Setup cepat

1. Salin file `.env.example` ke `.env.local`.
2. Isi `CRON_SECRET` dengan secret yang aman. Untuk state lintas invocation, isi `KV_REST_API_URL` dan `KV_REST_API_TOKEN` dari Vercel KV/Upstash.
3. Jalankan:

```bash
npm install
npm run dev
```

4. Untuk testing endpoint:

```bash
curl -X POST http://localhost:3000/api/tick \
  -H "x-cron-secret: dev-secret" \
  -H "Content-Type: application/json" \
  -d '{"pair":"BTC/IDR"}'
```

Dashboard tersedia di `/`, sedangkan `/api/dashboard` menyajikan state, sinyal terakhir 7 pair, dan 100 log terbaru. Tanpa env KV, pengembangan lokal memakai memori proses dan deployment Vercel menampilkan peringatan bahwa state belum persisten. Viewer offline ada di `/dashboard.html` atau `public/dashboard.html`; file HTML lama mengarah ke viewer ini.

Jalankan `npm run backtest` untuk mengambil candle Indodax native IDR 1 jam selama tiga tahun hingga candle tertutup terakhir, menghitung report, lalu menyematkan agregat harian dan report ke `public/dashboard.html`. Output backtest tersedia di `public/data/backtest.json`.

## Konfigurasi freeze UAS

Bagian ini mencatat baseline aturan, parameter, universe, dan waktu. Waktu disimpan dalam UTC; WIB = UTC+7.

- Sumber data: candle publik Indodax `history_v2`, pasangan native IDR, interval 1 jam.
- Periode backtest: mulai `2023-11-04T05:00:00.000Z` (4 Nov 2023, 12.00 WIB) sampai freeze `2026-11-04T05:00:00.000Z` (4 Nov 2026, 12.00 WIB).
- Periode forward replay yang diminta: mulai pada waktu freeze sampai `2026-11-14T05:00:00.000Z` (14 Nov 2026, 12.00 WIB).
- Universe tetap: `BTC/IDR`, `ETH/IDR`, `SOL/IDR`, `BNB/IDR`, `XRP/IDR`, `ADA/IDR`, dan `DOGE/IDR`.
- Sinyal dihitung dari candle tertutup dengan minimum 200 candle; eksekusi simulasi dilakukan pada harga open candle berikutnya.
- BUY: close di atas EMA 200; EMA 20 > EMA 50 > EMA 200; close menembus high tertinggi 40 candle sebelumnya; ROC 10 candle positif; dan volume candle terakhir di atas EMA 20 dari 20 candle volume sebelumnya.
- SELL/keluar dari posisi long: close di bawah EMA 20, close di bawah low terendah 40 candle sebelumnya, close mencapai trailing stop (highest close 40 candle sebelumnya dikurangi 2,2 × ATR 14), atau ROC 10 candle kurang dari -5%. Strategi tidak membuka posisi short.
- Modal simulasi Rp100.000.000; maksimum 3 posisi; nilai maksimum tiap posisi Rp20.000.000; batas rugi harian Rp12.000.000.
- Biaya simulasi: fee 0,15% dan slippage 0,05% per sisi. Spread historis tidak tersedia, sehingga `spreadCost` dicatat 0 dan slippage dimodelkan terpisah.
- Batas minimum order dry-run live: Rp25.000; ini batas eksekusi runtime, bukan asumsi fill backtest.

Saat dijalankan sebelum target akhir, replay dibatasi pada candle 1 jam yang sudah tertutup dan tersedia dari Indodax. `public/data/forward-test.json` menyimpan report retrospektif; `public/data/forward-replay.json` menyimpan candle historis mentah, keputusan sinyal per candle, cakupan waktu, dan provenance untuk dihitung ulang. Replay ini bukan log bot live, snapshot order book, atau bukti tick terjadwal. Dashboard menandai jika periode belum lengkap.

Jalankan `npm run hitung_ulang` untuk menghitung ulang keputusan, trade, equity curve, dan metrik forward replay dari arsip candle, lalu membandingkan hasilnya dengan report tersimpan. Perintah ini tidak membuat atau mengklaim log live.

Sumber Indodax serta asumsi simulasi ditampilkan di dashboard. Perubahan terhadap baseline ini harus tercatat sebagai perubahan Git baru; jangan mengubah konfigurasi freeze tanpa jejak commit.

## Laporan dashboard

Tab Performa menerima laporan JSON untuk backtest dan forward test. Format minimal:

- `mode`: `backtest` atau `forward_test`
- `initialCapital`: modal awal IDR
- `startAt` dan `endAt`: tanggal ISO atau timestamp
- `trades`: daftar trade tertutup dengan `pair`, `entryAt`, `exitAt`, `grossPnl`, `fee`, `spreadCost`, `slippageCost`, dan `netPnl`
- `equityCurve`: daftar `{ "timestamp": "...", "equity": 100000000 }`
- `benchmarkReturnPercent`: return buy-and-hold BTC/IDR pada periode yang sama

`netPnl` dihitung langsung bila tersedia; bila tidak, dihitung sebagai laba kotor dikurangi fee, spread, dan slippage. `index.html` menggunakan format yang sama dan tidak membutuhkan koneksi internet.

## Strategi yang dipakai

Strategi yang digunakan adalah robust trend breakout dengan:
- EMA 200 / 50 / 20
- breakout highest high 40 candle
- konfirmasi volume dan momentum
- trailing stop berbasis ATR

## Catatan penting

- Bot tetap bersifat dry run. Tidak ada order live yang dikirim ke exchange.
- Data candle terakhir yang masih berjalan dibuang untuk mencegah look-ahead bias.
- Semua validasi error atau warning dicatat ke log.

## Deploy Vercel

1. Push project ke GitHub.
2. Import ke Vercel.
3. Set environment variable `CRON_SECRET`.
4. Atur cron job sesuai kebutuhan, misalnya setiap 1 jam.
