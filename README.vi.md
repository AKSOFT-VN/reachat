# ReaChat

🇬🇧 [English](README.md) · 🇻🇳 Tiếng Việt

Ứng dụng nhắn tin desktop **độc lập**: server + client của riêng bạn,
mã hóa đầu-cuối mặc định.

- **`server/`** — Node.js (ESM): REST (đăng ký/đăng nhập JWT + bcrypt, tệp, kết bạn, story) + WebSocket
  (chuyển tin thời gian thực, đồng bộ, tín hiệu cuộc gọi), SQLite (`better-sqlite3`), TURN tích hợp (`node-turn`).
- **`desktop/`** — Electron + React (Vite):
  - *renderer* (React) chỉ lo giao diện, mọi mã hóa/giải mã chạy ở đây;
  - *main process* giữ **cache SQLite cục bộ** (sql.js/WASM), mạng LAN ngoại tuyến, ghim chứng chỉ, tự cập nhật;
  - *preload* mở API an toàn qua `contextBridge` (`contextIsolation` bật, không `nodeIntegration`).
  - Cũng chạy được trên trình duyệt (`src/webshim.js` thay preload bằng localStorage).

## Chạy thử

```bash
cd reachat
npm install            # cài cho cả server + desktop (workspaces)
npm run seed           # tạo tài khoản demo nam / binh (mật khẩu 123456)

npm run dev:server     # cửa sổ 1 — http://localhost:4000
npm run dev:desktop    # cửa sổ 2 — mở app Electron
```

Mở thêm cửa sổ độc lập (tài khoản khác): `npx electron . --user-data-dir=<thư mục riêng>` trong `desktop/`.

## Kiểm thử

```bash
npm test               # ở thư mục gốc: test server + unit test app
```

- `server/test/run-all.mjs` tự dựng server thử (DB tạm, cổng 4100, không đụng `data.db`/cổng 4000) rồi chạy 19 bộ (+ unit test app: mã hóa, ratchet, gộp tài liệu đồng bộ…):
  đồng bộ/phân trang/tự hủy/gửi có điều kiện/ICE (`test-new`), lịch sử + định tuyến cuộc gọi (`test-calls`),
  gọi nhóm (`test-gcall`), quyền xem story (`test-story`), 2 bước/chống dò/mã khôi phục/đổi mật khẩu
  (`test-security`), link mời (`test-invite`), báo cáo + quản trị (`test-admin`), Bot API + webhook (`test-bots`),
  kênh công khai (`test-channels`), thông báo đẩy với push service giả (`test-push`), chống spam + hạn mức dung lượng
  (`test-limits`), tải lên theo khúc + P2P (`test-files`), thiết bị / email-SMS / quên mật khẩu / xóa tài khoản (`test-account`),
  TURN Cloudflare chỉ cho cuộc gọi thật với Cloudflare giả (`test-turn`), captcha + giới hạn IP + đăng nhập Google với Google giả
  + cảnh báo (`test-captcha`), tìm bạn bè (`test-search`), quyền nhóm / quyền riêng tư / hồ sơ / xem trước liên kết (`test-group2`), kho GIF (`test-gifs`). Các bộ `test-limits`, `test-turn`, `test-captcha` tự dựng server riêng.
- `desktop/test/unit.mjs`: box/khóa nhóm, mã an toàn, Double Ratchet (sai thứ tự, forward secrecy, chống sửa),
  cảnh báo lừa đảo, tóm tắt, mạng LAN.

## Tính năng

**Nhắn tin** — chat 1-1 và nhóm; ảnh, tệp, tin thoại, sticker, emoji, danh thiếp; trả lời/trích dẫn, chuyển tiếp,
cảm xúc, ghim tin, sửa, thu hồi, xóa phía tôi (có hoàn tác), @nhắc tên; đã gửi / đã nhận / đã xem; đang soạn;
tìm kiếm cục bộ (cả tin mã hóa); bình chọn; tin nhắn nhanh `/từ-khóa`; phân trang lịch sử từ cache rồi từ server.

**Khác biệt** — tin tự hủy *có xác nhận đã xóa trên từng máy*; ảnh xem một lần; hẹn giờ gửi và **gửi có điều kiện**
(khi họ online / khi họ đã xem / nếu chưa trả lời); nhắc hẹn trên tin; giao việc trên tin; ghi chú soạn chung
(CRDT Yjs, mã hóa); tóm tắt hội thoại chạy trên máy; cảnh báo lừa đảo (OTP, chuyển tiền, link giả mạo) và
cảnh báo người lạ; giờ yên lặng (chặn thông báo/cuộc gọi trừ người ưu tiên); nhắn tin qua **mạng LAN khi mất
server**; Ghi chú riêng (ghi chú riêng, mã hóa).

**Cuộc gọi** — thoại/video 1-1 và **nhóm** (mesh, tối đa `GCALL_MAX`=6). TURN tích hợp cho NAT; tự ICE restart khi
rớt mạng; tự lấy lại mic/camera nếu thiết bị bị đóng ngang; gọi nhóm tự vào lại phòng khi mất kết nối server.
Lịch sử cuộc gọi trong hội thoại (đã nghe + thời lượng / nhỡ / từ chối / hủy / bận) với nút “Gọi lại”.
Gọi người offline báo ngay; nhiều thiết bị cùng đổ chuông, một máy bắt thì máy khác dừng; người bị chặn không gọi được.

**Mạng xã hội** — kết bạn (lời mời, QR, quét QR bằng camera), danh bạ, chặn; story 24 giờ (chữ/ảnh, lượt xem,
trả lời bằng tin riêng) với **“Ai xem được”** (ẩn với người cụ thể); hồ sơ, ảnh đại diện; trạng thái online.

**Cuộc gọi (nâng cao)** — **chia sẻ màn hình** (chọn màn hình/cửa sổ; cả gọi thoại lẫn gọi nhóm, không cần đàm phán lại);
**ghi cuộc gọi** ngay trên máy ra tệp `.webm` (ghép hình + trộn tiếng mọi người; ai trong cuộc gọi cũng được báo “đang ghi”).

**Tệp không giới hạn kích thước** — tệp trên 8 MB tải lên **theo khúc** 4 MB (mỗi khúc mã hóa riêng, 3 khúc song song, tự thử lại,
có thanh tiến độ); tải xuống đọc theo Range và ghi thẳng ra đĩa. **Gửi trực tiếp (P2P)** trong chat 1-1 (menu ＋): tệp đi
thẳng giữa hai máy qua WebRTC (DTLS), tín hiệu niêm phong bằng khóa danh tính, **máy chủ không lưu gì** — cần cả hai online.
Tin nhắn không giới hạn số lượng; tin trên 20.000 ký tự tự gửi thành tệp .txt. Không hạn mức dung lượng mỗi người
(`USER_QUOTA_MB` để bật); máy chủ từ chối tải lên khi ổ đĩa còn dưới `MIN_FREE_GB` (mặc định 2 GB).

**Phòng họp** — nút 📹 ở thanh bên: tạo phòng, nhận link `reachat://meet/<mã>` (hết hạn 7 ngày); ai có link bấm là vào thẳng
cuộc gọi (tối đa 6 người), chat của phòng mã hóa đầu-cuối, link hiện ngay trong cuộc gọi để sao chép.

**Nhóm & cộng đồng** — **link mời vào nhóm** `reachat://join/<mã>` (QR, hết hạn 7 ngày, thu hồi được; trưởng nhóm tự chia
khóa cho người mới nên đọc được lịch sử mã hóa); **kênh công khai** `reachat://c/<mã>` (chỉ chủ kênh đăng, ai cũng tìm và
theo dõi được, không lộ danh sách người theo dõi; nội dung công khai — không mã hóa đầu-cuối). Nhóm tạo từ trước khi
có mã hóa nhóm tự được nâng cấp.

**Bot API** — tạo bot trong Cài đặt → Bot (token chỉ hiện một lần). Gọi `GET /bot/v1/updates` (long-poll) hoặc nhận
**webhook** ký `X-ReaChat-Signature` = HMAC-SHA256; gửi tin `POST /bot/v1/send`. Bot mẫu: `server/scripts/echo-bot.mjs`.
Tin nhắn với bot **không** mã hóa đầu-cuối (app ghi rõ); bot không đọc được tin nhóm mã hóa.

**Tài khoản & an toàn** — **xác thực 2 bước** (TOTP: Google/Microsoft Authenticator…); **mã khôi phục** (quên mật khẩu
vẫn giữ lịch sử mã hóa vì khóa được bọc bằng chính mã đó); đổi mật khẩu đăng xuất mọi thiết bị khác; chống dò mật khẩu
(khóa tạm sau nhiều lần sai); **báo cáo vi phạm** (người báo cáo tự gửi kèm nội dung — server không đọc được tin);
**chống chụp màn hình** khi xem ảnh xem-một-lần / hội thoại có tin tự hủy (Windows: ảnh chụp/quay ra khung đen).

**Tài khoản (0.7)** — **đăng nhập bằng Google** (liên kết/gỡ trong Cài đặt; máy mới vẫn cần mật khẩu ReaChat để mở khóa
tin mã hóa); **thiết bị đăng nhập** (xem, đăng xuất từng máy hoặc mọi máy khác; máy không hoạt động 30 ngày tự đăng xuất);
**email / số điện thoại khôi phục** đã xác minh và **quên mật khẩu qua mã email/SMS** (mã 6 số, 10 phút, 5 lần thử, trả lời giống
nhau dù tài khoản có hay không; bật 2 bước thì vẫn cần mã 2 bước); **tự xóa tài khoản** (mật khẩu + mã 2 bước + gõ “XOA”);
**Điều khoản / Chính sách** (`/legal/`, phải đồng ý khi đăng ký).

**Chống spam** — **captcha** tự dựng (ảnh SVG vẽ bằng nét, dùng một lần, chạy cả trong app desktop) khi đăng ký, khi gửi mã
quên mật khẩu, và khi đăng nhập sai ≥ 3 lần; **giới hạn đăng ký theo IP** (`REG_PER_IP_HOUR`=3, `REG_PER_IP_DAY`=10 — tính
cả đăng ký qua Google). Tắt captcha: `CAPTCHA=0`.

**Hằng ngày (0.8)** — **âm thanh** (nhạc chuông cuộc gọi đến, chuông chờ khi gọi đi, âm báo tin nhắn — tạo bằng Web Audio, chỉnh/tắt
trong Cài đặt → Tùy chọn); **bản nháp** từng hội thoại (hiện “Nháp:” trong danh sách); **xóa cả cuộc trò chuyện** phía mình;
**xem trước liên kết** (máy chủ tải trang hộ, chặn địa chỉ nội bộ chống SSRF, tắt được); **tìm bạn bè** theo tên không dấu / username /
email / SĐT đã xác minh (khớp chính xác), có quyền riêng tư; **lưu trữ hội thoại** và **nhãn phân loại** + bộ lọc Tất cả / Chưa đọc / nhãn.

**Nhóm (0.8)** — **phó nhóm**, **chuyển quyền trưởng nhóm**, **ảnh nhóm**, **duyệt thành viên mới** (thêm bởi thành viên thường / vào bằng link),
**chỉ trưởng/phó nhóm được gửi tin**; phó nhóm mời được thành viên thường ra; trưởng nhóm rời thì quyền chuyển cho phó nhóm.

**Quyền riêng tư & hồ sơ (0.8)** — ẩn “đang hoạt động / truy cập lần cuối”; tắt “Đã xem” (có đi có lại); hồ sơ có **giới thiệu**, **sinh nhật**
(ẩn / ngày-tháng / đủ năm — nhắc sinh nhật bạn bè) và **ảnh bìa**; bấm tên để xem hồ sơ người khác.

**Kho GIF tự quản** — quản trị viên tải GIF lên ở `/admin` → **Kho GIF** (chọn nhiều tệp, gắn tên + từ khóa, sửa, xóa); người dùng
tìm theo từ khóa không dấu trong bảng GIF của app, gửi đi như ảnh mã hóa đầu-cuối. Miễn phí, không giới hạn lượt, không phụ thuộc dịch vụ ngoài.
Tệp lưu ở `GIF_DIR` (mặc định thư mục `gifs` cạnh tệp CSDL — chạy Docker là `/data/gifs`), được `backup-files` sao lưu.

**Tiện ích (0.8)** — **GIF** (Klipy/Giphy, gửi như ảnh mã hóa đầu-cuối; cần `KLIPY_API_KEY` hoặc `GIPHY_API_KEY` — Tenor API của Google đã đóng 30/6/2026); **tin nhắn video ngắn**
(quay ≤ 60 giây); **vị trí trực tiếp** 15 phút / 1 giờ / 8 giờ (tin vị trí tự cập nhật, mã hóa đầu-cuối, dừng được); **dịch tin nhắn**
(`TRANSLATE_PROVIDER` = mymemory mặc định | libre | google | off — hỏi người dùng đồng ý vì đoạn được dịch rời khỏi lớp mã hóa đầu-cuối);
**khóa ứng dụng bằng mã PIN** (khi mở app + sau N phút không thao tác; sai 5 lần thì đăng xuất).

**0.9** — **đồng bộ giữa các thiết bị** (ghim / tắt thông báo / lưu trữ / nhãn hội thoại, bản nháp, tin “xóa phía tôi”, hội thoại
đã xóa, tin đánh dấu sao — gói thành một tài liệu **mã hóa bằng khóa riêng**, máy chủ chỉ giữ bản mã; mỗi mục ai sửa sau thắng);
**trả lời theo luồng**; **kho sticker** tự quản theo gói; **chuyển tin thoại thành chữ ngay trên máy** (Whisper qua transformers.js /
WebAssembly, mô hình ~77 MB tải từ máy chủ ReaChat một lần — giọng nói không rời máy); **sự kiện / lịch hẹn nhóm** (Tham gia / Có thể /
Không, tự nhắc 15 phút trước); **ảnh gửi liền nhau gộp thành album**; **tin đánh dấu sao** + **tìm kiếm nâng cao** (loại tin, người gửi,
hội thoại, khoảng ngày); **trạng thái tự đặt** + **tự động trả lời** (máy chủ gửi thay — không mã hóa đầu-cuối, ghi rõ trong tin);
**kiểm duyệt** (từ cấm / tên miền bị chặn cho nội dung máy chủ đọc được: kênh công khai, tên nhóm, hồ sơ, trạng thái) + **nhật ký quản trị**.
Bản web lưu cache tin trong **IndexedDB** (trước đây localStorage ~5 MB).

**Quản trị** — trang `/admin` (thống kê, xử lý báo cáo, gỡ tin vi phạm, khóa/mở khóa tài khoản, cấp quyền).
Cấp quyền: `cd server && npm run make-admin -- <username>`.
Trang tổng quan có thêm: dung lượng TURN Cloudflare tháng này, số lỗi ứng dụng 24 giờ, cảnh báo gần đây, lỗi hay gặp.

**Ứng dụng** — giao diện sáng/tối, **tiếng Việt / English**, thông báo desktop, badge chưa đọc, ghim/tắt thông báo/đánh
dấu chưa đọc hội thoại; **chạy nền ở khay hệ thống** (đóng cửa sổ vẫn nhận tin/cuộc gọi, khởi động cùng Windows);
đa thiết bị (đồng bộ khóa qua bản sao lưu mã hóa bằng mật khẩu); **sao lưu/khôi phục toàn bộ lịch sử** ra tệp
`.reachat-backup` mã hóa bằng mật khẩu riêng; tự cập nhật; TLS + ghim chứng chỉ.

**Bản web / điện thoại (PWA)** — server phục vụ app tại `<máy chủ>/app`: cài ra màn hình chính điện thoại, chạy khi mất
mạng (khung app), giao diện một cột trên màn hình nhỏ, **thông báo đẩy** (Web Push/VAPID) khi đã đóng app — nội dung đẩy
chỉ là “tin nhắn mới từ @…” vì tin mã hóa đầu-cuối. Điện thoại cần máy chủ **https với chứng chỉ hợp lệ** (tên miền +
Let’s Encrypt) để service worker/thông báo đẩy hoạt động.

## Bảo mật — server thấy gì, không thấy gì

| | Server **không** đọc được | Server thấy |
|---|---|---|
| Tin 1-1 | nội dung (Double Ratchet, forward secrecy) | ai gửi ai, lúc nào, loại tin |
| Tin nhóm | nội dung (khóa nhóm secretbox; xoay khóa khi có người rời) | thành viên, thời điểm |
| Ảnh/tệp/tin thoại | byte nội dung **và** tên/loại/kích thước gốc (gói `x`) | kích thước bản mã, loại tin |
| Cuộc gọi | âm thanh/hình (DTLS-SRTP, P2P hoặc qua TURN); **SDP/ICE niêm phong bằng khóa danh tính** nên server không chen giữa được | ai gọi ai, lúc nào, bao lâu |
| Ghi chú chung, tiêu đề việc, Cloud | nội dung | thời điểm cập nhật |
| Khóa bí mật | — (chỉ ở máy; bản sao lưu bọc bằng PBKDF2 từ mật khẩu, và bằng mã khôi phục) | bản sao lưu đã mã hóa, dấu băm mã khôi phục |
| Tệp sao lưu lịch sử | toàn bộ (tệp nằm ở máy bạn, mã hóa bằng mật khẩu sao lưu) | — |
| Bản ghi cuộc gọi | toàn bộ (ghi và lưu ngay trên máy) | — |
| Thông báo đẩy | nội dung tin | ai nhắn cho ai (như metadata tin nhắn) |

Không mã hóa đầu-cuối (có chủ đích): story (phát cho nhiều bạn bè), bình chọn (server đếm phiếu),
tin hệ thống của nhóm, kênh công khai, tin nhắn với bot, nội dung báo cáo vi phạm (người báo cáo tự gửi). Mật khẩu băm **bcrypt**, phiên **JWT**.

**Mã an toàn**: mỗi chat 1-1 có 60 chữ số + QR để đối chiếu; khóa đối phương đổi -> cảnh báo. Khi đã xác minh,
cuộc gọi hiện “✅ đã xác minh mã an toàn” (tín hiệu gọi được niêm phong bằng đúng khóa đã xác minh).

## Triển khai thật

### Chạy bằng Docker

Xem chi tiết: [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md). Tóm tắt: build ảnh từ `deploy/Dockerfile` (máy chủ + bản web), tạo tệp
`.env` (cấu hình — [docs/CONFIGURATION.md](docs/CONFIGURATION.md)), chạy container với volume `/data` (CSDL, tệp, khóa VAPID, bản cập nhật):
`docker run -d --name reachat --restart unless-stopped --env-file .env -p 127.0.0.1:4000:4000 -p 3478:3478/udp
-p 49160-49200:49160-49200/udp -v $PWD/data:/data reachat:latest`, rồi đặt sau reverse proxy có TLS (nginx, Caddy, Cloudflare Tunnel…).
Cấp quản trị: `docker exec reachat node scripts/make-admin.js <username>`.

### TLS + ghim chứng chỉ

```bash
cd server
npm run gencert -- chat.congty.vn 192.168.1.10   # chứng chỉ tự ký (hoặc dùng TLS_CERT/TLS_KEY của CA thật)
npm run start:tls                                # in "Vân tay chứng chỉ SHA-256: AA:BB:…"
```

Trên app: màn đăng nhập → **Máy chủ** → nhập `https://chat.congty.vn:4000` → *Kiểm tra chứng chỉ* → so khớp vân tay
với dòng server in ra → *Ghim vân tay này* → *Lưu & kết nối lại* (app tự khởi động lại). Đã ghim thì app **chỉ**
chấp nhận đúng chứng chỉ đó. CSP của app chỉ cho kết nối tới đúng máy chủ đã cấu hình.
Biến môi trường thay thế: `REACHAT_SERVER`, `REACHAT_CERT_FP`.

### Cuộc gọi qua NAT (TURN)

**TURN Cloudflare (tùy chọn)** — `CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN` (Cloudflare → Realtime → TURN). Có UDP/TCP/TLS
cổng 443 nên đi xuyên hầu hết tường lửa. Miễn phí 1.000 GB/tháng, sau đó 0,05 USD/GB. Bảo vệ chi phí:
- Chỉ cấp cho **cuộc gọi thật**: người gọi gọi tới tài khoản đang trực tuyến, không chặn nhau; người nghe có cuộc gọi đang đổ
  chuông/đã nhận; thành viên vào cuộc gọi nhóm của nhóm mình. Gửi tệp P2P **không** dùng TURN Cloudflare.
- Mỗi (cuộc gọi, người) một mật khẩu riêng; tối đa `CF_GRANTS_PER_HOUR` (30) lần cấp/người/giờ; kết thúc cuộc gọi -> gửi lệnh thu hồi.
- **Hạn mức tự đo**: app (≥ 0.7.1) báo số byte nhận qua relay; tổng tháng ≥ `TURN_MONTHLY_GB` (900) hoặc mỗi người
  ≥ `TURN_USER_MONTHLY_GB` (50) -> ngừng cấp TURN Cloudflare tới hết tháng (cuộc gọi nối thẳng vẫn gọi được).
- Đã thử thực tế: lệnh thu hồi của Cloudflare **không có hiệu lực ngay**, và mật khẩu hết hạn thì cuộc gọi đang chạy **rớt**
  ở lần gia hạn TURN kế tiếp (~5 phút) -> thời hạn mật khẩu (`CF_TURN_TTL_S`, mặc định 6 giờ) phải dài hơn cuộc gọi dài nhất.
- Lớp bảo vệ cuối cùng: đặt **cảnh báo chi tiêu** trong Cloudflare Billing (số đo của app chỉ là ước tính).

Server tự chạy **TURN tích hợp** (UDP `TURN_PORT`, mặc định 3478) và cấp mật khẩu tạm thời qua `/api/ice`.
Máy chủ sau NAT: đặt `TURN_EXTERNAL_IP` (IP công khai) và `TURN_PUBLIC_HOST`, mở UDP 3478 + dải relay 49152–65535.
Dùng coturn riêng: `TURN_URLS=turn:turn.congty.vn:3478` + `TURN_SECRET=<static-auth-secret>`.
Dải cổng relay: `TURN_MIN_PORT`/`TURN_MAX_PORT` (mặc định 49160–49200). Có cấu hình Cloudflare thì TURN tích hợp là dự phòng miễn phí
sau khi hết hạn mức Cloudflare — cần mở UDP 3478 + dải cổng relay trên tường lửa (cả của nhà cung cấp hosting).
Tham số khác: `RING_TIMEOUT_MS` (mặc định 45000), `GCALL_MAX` (mặc định 6).

### Phát hành + triển khai bằng một lệnh

```bash
npm run release -- 0.9.0      # hoặc --patch / --minor; --no-installer: chỉ máy chủ + web; --no-deploy: chỉ build
```
Các bước: test máy chủ + app → build giao diện → **kiểm tra giao diện tự động trên bản build** (`scripts/smoke-ui.mjs`: đăng nhập,
**tải lại 2 lần không bị đăng xuất**, mở mọi tab Cài đặt, gửi tin, bảng ＋, không lỗi JS) → bộ cài Windows + bản cập nhật → đóng gói →
chép lên máy chủ của bạn (`deploy/deploy.env`) và chạy `deploy/remote-deploy.sh` (sao lưu CSDL, build Docker, chạy, chờ `/health`; **hỏng thì tự quay lại bản trước**;
tải mô hình giọng nói nếu chưa có) → kiểm tra sau triển khai qua tên miền thật. Cấu hình: `DEPLOY_HOST`, `DEPLOY_URL`.

### CSDL

Máy chủ: **SQLite** (better-sqlite3, WAL) — giai đoạn 1 của lộ trình. `src/dbtune.js`: `synchronous=NORMAL`, bộ đệm 64 MB, mmap,
chỉ mục cho các truy vấn nóng, nhớ đệm câu lệnh, ghi lại **truy vấn chậm** (> `SLOW_QUERY_MS`, mặc định 50 ms — xem ở `/admin`),
`PRAGMA optimize` định kỳ. Đo trên 300.000 tin: quét tin tự hủy 37 ms → 0,002 ms; tin theo người gửi 37 ms → 0,07 ms.
Giai đoạn 2 (khi cần nhiều máy chủ / rất đông người dùng): chuyển sang **PostgreSQL** như Matrix, Mattermost.

### Email / SMS, Google, cảnh báo, sao lưu

| Biến | Dùng cho |
|---|---|
| `SMTP_URL` (vd. `smtps://user:matkhau@smtp.gmail.com:465`), `MAIL_FROM` | gửi mã xác minh / quên mật khẩu qua email; gửi cảnh báo qua email |
| `SMS_HTTP_URL` (có thể chứa `{to}` `{text}`), `SMS_HTTP_METHOD`, `SMS_HTTP_BODY`, `SMS_HTTP_HEADERS` | cổng SMS HTTP bất kỳ (eSMS, SpeedSMS, Twilio…) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL` | đăng nhập Google (OAuth client loại **Web application**, URI chuyển hướng `<PUBLIC_URL>/auth/google/callback`) |
| `ALERT_WEBHOOK_URL` (+ `ALERT_WEBHOOK_BODY` mẫu có `{text}`), `ALERT_EMAIL` | máy chủ tự báo: khởi động lại / sập, ≥ 10 lỗi 5xx trong 5 phút, đĩa sắp đầy, CSDL lỗi, lỗi ứng dụng tăng đột biến, TURN gần hết hạn mức |
| `KLIPY_API_KEY` / `GIPHY_API_KEY` | tìm và gửi GIF (Klipy: klipy.com/developers; Giphy: khóa beta 100 lượt/giờ) |
| `TRANSLATE_PROVIDER` (+ `MYMEMORY_EMAIL` / `LIBRETRANSLATE_URL`, `LIBRETRANSLATE_KEY` / `GOOGLE_TRANSLATE_KEY`) | dịch tin nhắn |
| `GROUP_MAX_MEMBERS` (mặc định 0 = không giới hạn), `GCALL_MAX` (mặc định 6) | số thành viên tối đa mỗi nhóm / mỗi cuộc gọi nhóm |
| `MODELS_DIR` (mặc định `models` cạnh CSDL) | mô hình chuyển giọng nói thành chữ — `npm run fetch-stt-model` (bước triển khai tự chạy) |
| `AUTO_REPLY_HOURS` (mặc định 6) | mỗi người nhận tối đa 1 tin tự động trả lời / N giờ |
| `SLOW_QUERY_MS` (mặc định 50) | ngưỡng ghi lại truy vấn CSDL chậm |
| `BACKUP_DIR`, `BACKUP_KEEP` | `npm run backup` = sao lưu CSDL (`backup-db`) + gương tệp đính kèm (`backup-files`) |

Telegram: `ALERT_WEBHOOK_URL=https://api.telegram.org/bot<TOKEN>/sendMessage`, `ALERT_WEBHOOK_BODY={"chat_id":"<ID>","text":"{text}"}`.
Máy chủ **chết hẳn** thì không tự báo được: thêm một dịch vụ theo dõi bên ngoài (UptimeRobot, Cloudflare Health Checks…)
gọi `https://<máy chủ của bạn>/health` mỗi vài phút (trả 503 khi CSDL lỗi hoặc đĩa còn dưới 1 GB).
App gửi lỗi JS không bắt được về `/api/client-errors` (chỉ thông báo lỗi + vị trí trong mã, không kèm nội dung tin).

### Ký số bộ cài

Có chứng thư code-signing (tệp .pfx) thì chỉ cần đặt biến môi trường trước khi `npm run release`:
`CSC_LINK=<đường dẫn .pfx>`, `CSC_KEY_PASSWORD=<mật khẩu>` — electron-builder tự ký bộ cài và app.
Chứng thư EV trên thiết bị phần cứng / Azure Trusted Signing: cấu hình `build.win.signtoolOptions` / `azureSignOptions`.

### Cập nhật tự động

```bash
cd desktop
# tăng "version" trong package.json, rồi:
npm run release      # build bộ cài NSIS + chép latest.yml/.exe/.blockmap vào server/updates
```

App **cài bằng bộ cài** kiểm tra `<máy chủ>/updates/latest.yml` lúc mở và mỗi 4 giờ, tải **vi sai**, kiểm SHA-512,
rồi hiện “Khởi động lại để cập nhật” (cài im lặng, tự mở lại). Bản chạy thẳng (`release/win-unpacked`) không tự cập nhật.

### Nâng cấp dữ liệu

Server và cache trên máy tự thêm cột/bảng khi khởi động (không xóa dữ liệu). Nhóm tạo từ trước khi có mã hóa nhóm
tự được nâng cấp: người gửi đầu tiên sinh khóa; nếu hai người cùng sinh khóa hoặc một máy thiếu khóa, mọi máy giữ
cả hai khóa và trưởng nhóm chia khóa chung để cả nhóm hội tụ — người chỉ đọc cũng tự xin được khóa.

## Đóng góp, bảo mật, giấy phép

- Đóng góp: [CONTRIBUTING.md](CONTRIBUTING.md) · Quy tắc ứng xử: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- Báo lỗ hổng bảo mật (KHÔNG mở issue công khai): [SECURITY.md](SECURITY.md) · Mô hình bảo mật: [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md)
- Giấy phép: [Apache-2.0](LICENSE) — © 2026 aksoft.vn. Xem [NOTICE](NOTICE).

## Giới hạn còn lại (trung thực)

Không làm được bằng mã nguồn (cần tiền / pháp lý / hạ tầng bên ngoài):
- **Ký số bộ cài** — cần mua chứng thư code-signing; chưa có thì Windows SmartScreen cảnh báo khi cài.
- **Kiểm định mật mã độc lập** — mật mã tự hiện thực theo đặc tả Signal (TweetNaCl/WebCrypto), chưa qua kiểm định.
  Bản thương mại nên dùng libsignal + thuê đơn vị kiểm định.
- **Thanh toán / ví / chuyển tiền** — cần giấy phép trung gian thanh toán và đối tác ngân hàng/ví.
- **Gửi email / SMS thật** — mã nguồn đã có (quên mật khẩu qua email/SMS), cần tài khoản SMTP và hợp đồng cổng SMS.
- **App native iOS/Android** — hiện dùng bản PWA (cài ra màn hình chính). App store cần tài khoản nhà phát triển + dự án native.
- **Gọi nhóm đông người (> 6)** — mesh tốn băng thông; cần máy chủ SFU (mediasoup/LiveKit) là hạ tầng riêng.
- **Chứng chỉ hợp lệ cho điện thoại** — chứng chỉ tự ký dùng được trên desktop (ghim vân tay) nhưng điện thoại cần
  tên miền + chứng chỉ CA (Let’s Encrypt) để cài PWA và nhận thông báo đẩy.

Giới hạn bản chất:
- Tin tự hủy / chống chụp màn hình: không chống được chụp bằng máy ảnh khác hay app bị sửa; xác nhận “đã xóa” do app gửi.
- Tin 1-1 rất cũ chỉ khôi phục được nếu còn thiết bị giữ bản đọc được **hoặc** có tệp sao lưu lịch sử.
- Metadata (ai nói chuyện với ai, khi nào) server vẫn thấy — như mọi hệ thống có máy chủ trung gian.
- Giao diện tiếng Anh dịch menu, nút, hướng dẫn, thông báo nổi, lỗi từ máy chủ và tiêu đề thông báo desktop; vài chuỗi hiếm có thể còn tiếng Việt.
