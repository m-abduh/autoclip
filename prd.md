# PRD — AutoClip (Instagram → Buffer Auto-Publisher)

## 1. Ringkasan
AutoClip adalah sebuah **service Node.js** yang memantau beberapa akun Instagram
(berbasis username), mengunduh **video baru** (apa adanya, tanpa re-encode),
lalu **otomatis mengirimkannya ke Buffer** untuk dipublikasikan ke
**YouTube, TikTok, dan Instagram**. Dilengkapi
**web management** (Express + templating engine) untuk mengelola daftar
username, melihat video, memicu unduhan manual, dan mengatur interval
penjadwalan (node-cron).

Tidak ada ffmpeg/transcoding. Setelah video terunduh, file langsung
diteruskan ke Buffer.

## 2. Tujuan
- Memantau **banyak username** Instagram sekaligus.
- Mengunduh video baru tanpa login (anonim), **apa adanya** (file mentah dari CDN IG).
- **Auto-publish ke Buffer** ke **YouTube, TikTok, dan Instagram** sekaligus.
- **Satu siklus, interval tunggal**: tiap interval (default 1 jam) — ambil **1 video
  terbaru**, unduh, lalu upload sekaligus. Tidak pernah banjir upload.
- **Tidak pernah meng-upload ulang** konten ke channel yang sudah pernah menerimanya.
- Web management page untuk mengelola username & video.
- Penjadwalan fetch dengan interval yang bisa dipilih: **1/2/4/5/6/7/8 jam**.

## 3. Non-Tujuan (Out of Scope v1)
- Login/cookies akun Instagram (tetap anonim untuk konten publik).
- Mengunduh gambar/foto (hanya **video**).
- Transcoding / merge / ffmpeg (dihapus total dari scope).
- Konten private, Stories, Highlights, DM.
- Komentar/analytics Buffer.
- Multi-user & autentikasi web (single operator, akses lokal/terlindungi).

## 4. Aktor & Alur Utama
```
Operator  →  Web management: tambah username + interval (channel auto dari Buffer)
              │
              ▼
node-cron (SATU siklus)  →  tiap `intervalHours` (default 1 jam): ROTASI username
              │      (mulai dari username setelah yang terakhir diproses;
              │       bila di satu username reel-nya sudah diupload → lanjut
              │       ke username berikutnya dalam run yang sama)
              ▼
1. Paginasi profil IG (anonim, Lite API) → post terbaru s/d `IG_MAX_PAGES` halaman,
   dengan `media_type`/`product_type` per post — klasifikasi reels GRATIS
   (fallback: 12 terbaru dari HTML profil bila Lite API di-throttle)
2. Temukan REEL TERAKHIR (post paling baru yang `product_type == "clips"`)
3. Sudah pernah diupload semua channel?
   ├─ YA   → skip username ini, lanjut ke username berikutnya
   └─ BELUM → unduh reel apa adanya → downloads/<owner>/<shortcode>.mp4
4. Upload SEKALIGUS ke semua channel Buffer:
   - Discover channel (getChannels) → semua channel IG/TikTok/YouTube
   - Skip channel yang sudah pernah upload video itu (anti-duplikat per channel)
   - Host file di URL publik (Express /media) + Buffer createPost per channel
   - Simpan status "uploaded" + bufferPostId per channel → cegah re-upload
5. Jika berhasil publish 1 reel: siklus selesai, rotasi pindah ke user berikutnya
              │
              ▼
Web management menampilkan hasil & status
```

## 5. Temuan Kunci (Hasil Riset & Uji)
| Kasus | Hasil | Keterangan |
|---|---|---|
| URL reel/post langsung | ✅ Berhasil tanpa login | Terunduh dari CDN IG |
| Halaman profil via username | ✅ Berhasil tanpa login | Metadata + 12 shortcode terbaru di HTML |
| Endpoint API `web_profile_info` | ❌ 401/429 tanpa login | Butuh auth |
| Kualitas tersedia | 360/540/720/1080p | v1 pakai file progressive apa adanya |
| Kunci akses anonim | Header `Sec-Fetch-*` + sesi | Tanpa ini → login-wall |
| Buffer API | GraphQL `createPost` | **Tanpa upload**, butuh URL media publik |

## 6. Stack Teknologi
| Komponen | Pilihan | Alasan |
|---|---|---|
| Runtime | **Node.js 20+ (disarankan 22 LTS)** | Dipilih pengguna |
| Web server | **Express** | Ringan, familiar |
| Templating | **EJS** | Server-side render sederhana |
| Scheduler | **node-cron** | Interval fetch tiap N jam |
| HTTP | `axios` | Sesi IG + unduh stream |
| Buffer client | `fetch`/`axios` ke GraphQL | `POST https://api.buffer.com` |
| Penyimpanan data | **SQLite** (`data/autoclip.db`) via `node:sqlite` bawaan Node | Tanpa dependency native |
| Static media | `express.static` | Host video di URL publik utk Buffer |
| Config | `dotenv` | Baca `.env` |
| Deploy | systemd / Docker | Server Linux + domain publik |

> Catatan: ffmpeg **tidak dipakai** di v1.

## 7. Arsitektur
```
┌───────────────────────────────────────────────────────────────┐
│  Express App (index.js)                                        │
│  ├─ Web UI (EJS): Dashboard, Usernames, Videos, Settings        │
│  ├─ REST API: /api/usernames, /api/videos, /api/run, /api/settings│
│  └─ Static: /media/<owner>/<shortcode>.mp4  (URL publik Buffer) │
├───────────────────────────────────────────────────────────────┤
│  Scheduler (node-cron)                                         │
│  └─ tiap INTERVAL_HOURS → pipeline()                           │
├───────────────────────────────────────────────────────────────┤
│  Core modules                                                  │
│  ├─ instagram.js  : sesi + fetch profil + ambil video + unduh   │
│  ├─ buffer.js     : getChannels (auto) + createPost GraphQL     │
│  ├─ store.js      : baca/tulis SQLite (users, videos, cfg)      │
│  └─ pipeline.js   : orkestrasi fetch→unduh→validasi→upload      │
└───────────────────────────────────────────────────────────────┘
```

Struktur file yang direncanakan:
- `index.js` — bootstrap Express + mulai cron.
- `src/instagram.js` — logika IG (dipindah dari `index.js` lama).
- `src/buffer.js` — klien Buffer GraphQL.
- `src/store.js` — datastore JSON.
- `src/pipeline.js` — alur utama per username.
- `src/scheduler.js` — konfigurasi node-cron.
- `views/` — template EJS.
- `public/` — aset web.
- `downloads/` — file video.
- `data/autoclip.db` — database SQLite (tabel `settings`, `usernames`, `videos`, `logs`).
- `seed.js` — `npm run seed` (isi default + tambah username dari argumen CLI).

## 8. Model Data (SQLite — `data/autoclip.db`)
```jsonc
{
  "settings": {
    "intervalHours": 1,          // siklus: salah satu: 1,2,4,5,6,7,8
    "fetchBatchSize": 1,         // jumlah video paling baru yang diambil per siklus
    "rotationIndex": 0,          // pointer rotasi username (bergilir)
    "captionTemplate": "Follow for more! {caption}", // universal, sama utk semua platform
    "autoUpload": true,
    "services": ["instagram", "tiktok", "youtube"], // platform tujuan (channel di-discover otomatis)
    "lastRunAt": "2026-10-10T12:00:00Z"
  },
  "usernames": [
    {
      "username": "zabdiel.soriton",
      "enabled": true,
      "seen": ["DcH96HWyXBo", "..."],   // shortcode yang sudah terlihat
      "createdAt": "..."
    }
  ],
  "videos": [
    {
      "shortcode": "DcH96HWyXBo",
      "owner": "zabdiel.soriton",
      "file": "downloads/zabdiel.soriton/DcH96HWyXBo.mp4",
      "mediaId": "1234...",
      "caption": "...",
      "status": "uploaded",       // downloaded | uploaded | partial | failed | skipped
      "uploads": [                // satu entri per channel (anti-duplikat per channel)
        { "service": "instagram", "channelId": "buf_ig_123", "status": "uploaded", "bufferPostId": "abc123", "uploadedAt": "..." },
        { "service": "tiktok",    "channelId": "buf_tt_456", "status": "uploaded", "bufferPostId": "def456", "uploadedAt": "..." },
        { "service": "youtube",   "channelId": "buf_yt_789", "status": "failed",   "error": "queue penuh" }
      ]
    }
  ]
}
```
**Kunci anti-duplikat:** `owner + shortcode + mediaId + channelId`.
Jika sebuah video sudah `uploaded` untuk suatu channel, channel itu **di-skip**
di siklus berikutnya (channel lain tetap diproses).

### Caption Template (universal)
Satu template dipakai untuk **semua platform**. Placeholder:
`{caption}` (caption IG asli), `{username}` (pemilik), `{shortcode}`.
Contoh: `"Follow for more! {caption}"`.

## 9. Integrasi Buffer
- Endpoint: `POST https://api.buffer.com`, header `Authorization: Bearer <BUFFER_API_KEY>`.
- **Tidak ada endpoint upload** → Buffer mengambil media dari **URL publik**
  yang wajib tetap hidup sampai post dipublikasikan (jangan pakai URL bertanda-tangan/expired).
- Mutation:
```graphql
mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    ... on PostActionSuccess { post { id dueAt } }
    ... on MutationError { message }
  }
}
```
- `input` (dipanggil **sekali per channel yang ter-discover** — IG, TikTok, YouTube):
```jsonc
{
  "text": "<caption IG / captionTemplate>",
  "channelId": "<channel buffer tujuan sesuai platform>",
  "schedulingType": "automatic",
  "mode": "addToQueue",           // atau "customScheduled" + dueAt
  "assets": [{ "video": { "url": "<PUBLIC_BASE_URL>/media/<owner>/<shortcode>.mp4" } }],
  "metadata": { "<service>": { /* opsi platform, mis. IG reel, YouTube title/privacy */ } }
}
```
- Media publik disediakan oleh Express: `PUBLIC_BASE_URL/media/...` (satu video dipakai ulang untuk 3 channel).
- **Channel di-discover otomatis** dari Buffer (tidak ada input manual):
  `query { account { organizations { id } } }` lalu
  `channels(input: { organizationId }) { id name service }` (mengembalikan array).
  Satu video diposting ke **semua** channel yang service-nya aktif di Settings.
- `mode` publikasi: **`shareNow`** (default, publikasi langsung), bisa diubah via
  `BUFFER_MODE` (`shareNow`/`addToQueue`/`customScheduled`).
- Metadata per platform (mengikuti integrasi yang terbukti bekerja):
  - **Instagram**: `{ instagram: { type: "post", shouldShareToFeed: true } }`
  - **YouTube**: `{ youtube: { title, privacy: "public", categoryId: "24" } }`
  - **TikTok**: default Buffer (tanpa metadata khusus)
- `thumbnailOffset` diset `0` untuk YouTube & TikTok.
- Jika satu channel gagal (mis. queue penuh), channel lain tetap diproses; status upload dicatat per channel.

## 10. Fungsional (FR)
### FR-1 Manajemen Username
Tambah/hapus/aktif-nonaktif username. Channel tujuan **tidak diisi manual** —
di-discover otomatis dari Buffer saat run (mengikuti pola `1section-post`).

### FR-2 Sesi anonim & fetch profil
Buka sesi IG (cookie) + header `Sec-Fetch-*`; ambil 12 shortcode terbaru dari HTML profil.

### FR-3 Deteksi konten baru (rotasi & cari reel terakhir)
Username diproses **bergilir** (`rotationIndex`). Tiap siklus, satu username:
ambil **tab Reels** (`/username/reels/` via web — anonim & anti-throttle;
fallback Lite API `clips/user`; fallback terakhir scan grid), cari **reel
terakhir** = reel paling baru. Bila reel itu **belum** pernah diupload penuh →
unduh + upload. Bila **sudah** diupload → skip ke username berikutnya. Reel yang
disembunyikan dari grid tetap tertangkap lewat tab Reels. `seen` hanya diisi reel
yang benar-benar diproses.

### FR-4 Unduh reel saja (apa adanya)
Hanya **reels** (`product_type == "clips"`) yang diproses. Foto, carousel,
feed video, dan IGTV **dilewati** (tidak diunduh, tidak diupload). File reel
disimpan mentah, **tanpa ffmpeg**.

### FR-5 Validasi anti-duplikat
Sebelum upload, cek `videos[].uploads[]` berdasarkan `owner+shortcode+mediaId+channelId`.
Jika channel itu sudah `uploaded` → **skip** channel tersebut (tidak diupload ulang).
Channel yang belum berhasil tetap diproses.

### FR-6 Upload ke Buffer (inline, 1 video per siklus)
Begitu 1 video terbaru terunduh, langsung upload **sekaligus** ke semua channel
ter-discover (IG/TikTok/YouTube). Untuk tiap channel panggil
`createPost` dengan URL media publik + caption + metadata platform. Simpan
`bufferPostId`, `status`, `uploadedAt` **per channel**. Status video global
jadi `uploaded` bila semua channel sukses, `partial` bila sebagian,
`failed` bila gagal (akan dicoba lagi di siklus berikutnya).

### FR-7 Penjadwalan (node-cron, SATU job)
Tiap `intervalHours` (1/2/4/5/6/7/8): siklus penuh fetch → unduh → upload.
Bisa diubah dari Settings; cron di-reload saat setting berubah.
Ada tombol "Jalankan siklus sekarang".

### FR-8 Web Management (EJS)
- **Dashboard**: ringkasan (jumlah username, video, status upload, run terakhir).
- **Usernames**: CRUD + enable toggle + preview channel Buffer.
- **Videos**: tabel video (owner, shortcode, status, bufferPostId, waktu) + aksi manual.
- **Settings**: interval, fetchBatchSize, captionTemplate, autoUpload.

### FR-9 API untuk UI
`GET/POST /api/usernames`, `GET /api/videos`, `POST /api/run`,
`GET/POST /api/settings`.

### FR-10 Logging
Log tiap tahap: fetch, deteksi, unduh, validasi, upload, error — tampil di UI & konsol.

## 11. Penjadwalan & Interval
- Opsi interval: **1, 2, 4, 5, 6, 7, 8 jam** (default 1).
- Implementasi: satu `node-cron` `0 */N * * *` (di-rebuild saat interval berubah).
- Tidak ada jam absolut tertentu (bukan "tiap jam 9 pagi") — murni interval.
- Satu siklus = 1 username (bergilir) → 1 video terbaru → unduh → upload.

## 12. Non-Fungsional
- **Idempoten:** menjalankan siklus berulang tidak menghasilkan duplikat upload.
- **Tahan error:** gagal di satu username/video tidak menghentikan yang lain.
- **Ringan:** tanpa dependency native (SQLite bawaan `node:sqlite`, tanpa ffmpeg).
- **Portable:** Windows/Linux, Node 20+.
- **No-login:** konten publik tanpa kredensial IG.

## 13. Risiko & Keterbatasan
- HTML/endpoint Instagram bisa berubah → ekstraksi bisa rusak.
- Akses anonim bisa kena rate-limit/blokir, terutama dari IP server.
- **Buffer butuh URL publik yang stabil**; jika server/media tidak publik, upload gagal.
- Video Instagram kadang butuh session cookie → mungkin gagal sebagian.
- ToS Instagram/Buffer berisiko; tanggung jawab pengguna.
- Mitigasi: input manual URL, tombol run-now, retry, log jelas.

## 14. Metrik Keberhasilan
- Username baru → video baru otomatis terunduh & masuk queue Buffer tanpa intervensi.
- 0 duplikat upload (validasi `owner+shortcode+mediaId`).
- Interval bisa diubah dari UI dan langsung berlaku.

## 15. Config (`.env`)
```
PORT=3000
DOWNLOAD_DIR=downloads
DATA_DIR=data
PUBLIC_BASE_URL=https://domain-kamu.com
BUFFER_API_KEY=xxxxxxxx
BUFFER_MODE=shareNow
YOUTUBE_PRIVACY=public
YOUTUBE_CATEGORY_ID=24
INTERVAL_HOURS=6
```
Referensi integrasi: mengikuti pola `services/buffer.js` dari project `1section-post`
(branch `multiaccount-playground`).

## 16. Roadmap
- **v1:** Express + EJS + node-cron + JSON store + IG fetch/download + Buffer upload + anti-duplikat.
- **v1.1:** retry & backoff upload, notifikasi (Telegram/Discord).
- **v1.2:** upload media ke storage eksternal (S3/R2) + signed/public URL.
- **v2:** caption builder lanjutan, statistik, dukungan multi akun Buffer (multi token).

## 17. Keputusan Terbuka (butuh konfirmasi)
1. **Hosting media publik:** pakai Express static di server berdomain, atau
   object storage (S3/R2)? (Buffer wajib URL publik yang stabil.)
2. **Buffer API key** (channel di-discover otomatis; tidak perlu channelId manual).
3. Caption: pakai caption IG asli apa adanya, atau beda per platform
   (mis. YouTube pakai judul, TikTok pakai caption pendek)?
4. Metadata YouTube: `title`, `privacy` (public/unlisted), `category` default?
5. Mode Buffer: `shareNow` (default) atau `addToQueue`/`customScheduled`?
6. Interval default: 6 jam (bisa diubah dari UI: 1/2/4/5/6/7/8).
