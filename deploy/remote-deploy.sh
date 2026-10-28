#!/usr/bin/env bash
# Chạy TRÊN máy chủ — do scripts/release.mjs gọi qua ssh. Tham số: <phiên bản>. Thư mục: DEPLOY_DIR (mặc định /opt/reachat)
# chứa .env (cấu hình máy chủ), data/ (volume dữ liệu), reachat-bundle.tgz (gói do release.mjs chép lên).
# Sao lưu CSDL -> giải nén gói -> build ảnh Docker -> chạy container mới -> chờ /health.
# /health không lên trong 60 giây -> tự quay lại ảnh trước (reachat:prev).
set -euo pipefail
VER="${1:?thiếu phiên bản}"
DIR="${DEPLOY_DIR:-/opt/reachat}"
cd "$DIR"
RUN_ARGS=(-d --name reachat --restart unless-stopped --env-file "$DIR/.env" -p 127.0.0.1:4000:4000
  -p 3478:3478/udp -p 49160-49200:49160-49200/udp -v "$DIR/data:/data" --memory 1g)

echo "== Sao lưu CSDL"
docker exec reachat node scripts/backup-db.js 2>/dev/null | tail -1 || echo "(container cũ không chạy — bỏ qua sao lưu)"

echo "== Giải nén gói $VER"
rm -rf src && mkdir src && tar -xzf reachat-bundle.tgz -C src
chown -R 1000:1000 "$DIR/data"

echo "== Build ảnh reachat:$VER"
docker image inspect reachat:latest >/dev/null 2>&1 && docker tag reachat:latest reachat:prev
# Build lỗi thì DỪNG — không chạy tiếp với ảnh cũ mà báo thành công (lỗi của lần phát hành 0.9.0 đầu tiên).
# Lỗi mạng tạm thời (tải header Node khi biên dịch better-sqlite3) -> thử lại tối đa 3 lần.
ok=0
for try in 1 2 3; do
  if docker build -t "reachat:$VER" -t reachat:latest src > /tmp/reachat-build.log 2>&1; then ok=1; break; fi
  echo "!! build lần $try lỗi:"; grep -iE 'ERR!|error' /tmp/reachat-build.log | tail -4 || true
  sleep 10
done
if [ "$ok" != 1 ]; then echo "!! KHÔNG build được ảnh mới — giữ nguyên bản đang chạy"; tail -30 /tmp/reachat-build.log; exit 1; fi
NEW_ID=$(docker image inspect -f '{{.Id}}' "reachat:$VER")

echo "== Chạy container mới"
docker rm -f reachat >/dev/null 2>&1 || true
docker run "${RUN_ARGS[@]}" reachat:latest >/dev/null
if [ "$(docker inspect -f '{{.Image}}' reachat)" != "$NEW_ID" ]; then echo "!! container không chạy ảnh vừa build"; exit 1; fi

for i in $(seq 1 30); do
  if curl -fs localhost:4000/health >/dev/null 2>&1; then
    echo "== OK: $(curl -s localhost:4000/health)"
    # Mô hình nhận dạng giọng nói (tải một lần, ~77 MB; đã có thì bỏ qua) — lỗi mạng không làm hỏng bản triển khai
    docker exec reachat node scripts/fetch-stt-model.js 2>&1 | tail -1 || echo "(chưa tải được mô hình giọng nói — thử lại lần triển khai sau)"
    exit 0
  fi
  sleep 2
done

echo "!! /health không lên — quay lại bản trước (reachat:prev)"
docker logs --tail 30 reachat || true
docker rm -f reachat >/dev/null 2>&1 || true
docker run "${RUN_ARGS[@]}" reachat:prev >/dev/null
sleep 5; curl -s localhost:4000/health || true
exit 1
