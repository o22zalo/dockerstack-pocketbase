# App service (`compose.apps.yml`) — PocketBase + Litestream

## Vai trò
- Chạy **PocketBase** (BaaS, SQLite) kèm **Litestream** để replicate `data.db` liên tục lên S3.
- Không có single-point-of-failure: mỗi lần khởi động tự restore từ S3 → không mất data khi runner bị reclaim.

## Startup modes

| `LITESTREAM_INIT_MODE` | Hành vi |
|---|---|
| `false` (default) | Bắt buộc restore `data.db` từ S3. Exit 1 nếu không có backup — bảo vệ khỏi ghi đè accidental. |
| `true` | Bỏ qua restore. PocketBase tạo DB mới. Dùng cho lần deploy đầu tiên. |

## Luồng khởi động (INIT_MODE=false)

```
entrypoint.sh
  └─ litestream restore → /pb/pb_data/data.db
  └─ litestream replicate -exec "./pocketbase serve"
       └─ PocketBase process (WAL sync → S3 mỗi 5s)
```

## URLs sau khi deploy

| URL | Mô tả |
|---|---|
| `https://<domain>/_/` | Admin UI |
| `https://<domain>/api/` | REST API |
| `https://<domain>/api/health` | Health check |

## Cấu hình chính

- Image: build local từ `services/app/Dockerfile`
- Build arg: `PB_VERSION` (default `0.28.2`)
- Port: `APP_PORT` (default `8090`)
- Data volume: `${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/app/pb_data:/pb/pb_data`
- Litestream DB target: `/pb/pb_data/data.db`
- Stop grace period: `40s` (Litestream flush WAL cuối)

## ENV bắt buộc

| Biến | Mô tả |
|---|---|
| `APP_PORT` | Port PocketBase lắng nghe (default `8090`) |
| `PROJECT_NAME`, `DOMAIN` | Hostname public |
| `LITESTREAM_S3_ENDPOINT` | S3-compatible endpoint (Supabase, AWS, R2...) |
| `LITESTREAM_S3_BUCKET` | Tên bucket |
| `LITESTREAM_S3_ACCESS_KEY_ID` | Access key |
| `LITESTREAM_S3_SECRET_ACCESS_KEY` | Secret key |

## ENV optional

| Biến | Default | Mô tả |
|---|---|---|
| `LITESTREAM_INIT_MODE` | `false` | Bật khi deploy lần đầu |
| `LITESTREAM_S3_PATH` | `pocketbase/data.db` | Prefix path trong bucket |
| `PB_VERSION` | `0.28.2` | Phiên bản PocketBase |
| `APP_HOST_PORT` | `8090` | Port publish ra localhost |
| `DOCKER_VOLUMES_ROOT` | `./.docker-volumes` | Root bind-mount |
| `TAILSCALE_TAILNET_DOMAIN` | — | Route HTTPS nội bộ qua `caddy_1` |

## Hướng dẫn deploy lần đầu (Init flow)

```bash
# 1. Set LITESTREAM_INIT_MODE=true trong .env
# 2. Deploy
npm run dockerapp-exec:up

# 3. Truy cập http(s)://<domain>/_/ để tạo admin account
# 4. Dừng container
npm run dockerapp-exec:down

# 5. Tắt LITESTREAM_INIT_MODE (về false hoặc xóa)
# 6. Deploy lại — từ đây dùng mode restore bình thường
npm run dockerapp-exec:up
```

## Routing

- Public: `${PROJECT_NAME}.${DOMAIN}` (+ alias `main.${DOMAIN}`, `${DOMAIN}`)
- Internal HTTPS: `${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}` với `tls internal`

## Lưu ý về `pb_data`

PocketBase lưu tất cả vào `pb_data/`:
- `data.db` — database chính (được Litestream replicate)
- `logs.db` — log requests (không replicate, tự xoay vòng)
- `storage/` — file uploads (không replicate, cần backup riêng nếu cần)

Nếu cần backup `storage/`, có thể dùng rclone hoặc mount S3 bucket trực tiếp cho thư mục uploads.

## Consul Firebase lease + standby read-only

- Khi `CONSUL_FIREBASE_ENABLE=true`, traffic public/internal được route vào `consul-gateway` trước khi tới app.
- `consul-gateway` dùng lease Firebase để xác định role:
  - `writer`: cho phép đủ method.
  - `standby`: chỉ cho phép `GET`/`HEAD` cho `/api/*`.
- Tham khảo chi tiết vận hành ở `docs/services/consul.md`.
