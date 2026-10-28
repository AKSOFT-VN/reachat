# ReaChat server + bản web (PWA). Dữ liệu (DB, tệp, khóa VAPID, bản cập nhật) nằm ở volume /data.
FROM node:24.14-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app/server
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:24.14-alpine
ENV NODE_ENV=production PORT=4000 DB_PATH=/data/reachat.db UPDATES_DIR=/data/updates VAPID_FILE=/data/vapid.json WEB_DIR=/app/web
WORKDIR /app/server
COPY --from=build /app/server/node_modules ./node_modules
COPY server/ ./
COPY web/ /app/web/
# Tệp đính kèm lưu ở server/uploads -> trỏ vào volume
RUN rm -rf uploads && ln -s /data/uploads uploads \
 && mkdir -p /data/uploads && chown -R node:node /data   # chạy được cả khi không gắn volume (vd. CI)
USER node
EXPOSE 4000
CMD ["node", "src/index.js"]
