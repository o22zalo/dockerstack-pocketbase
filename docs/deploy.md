# deploy.md

Tài liệu triển khai chuẩn theo **codebase hiện tại**.

## 1) Luồng triển khai chuẩn

1. Chuẩn bị `.env` (không dựa mù quáng vào `.env.example`).
2. Cấu hình Cloudflare Tunnel (`cloudflared/config.yml` + `credentials.json`).
3. Validate môi trường bằng script `docker-compose/scripts/validate-env.js`.
4. Deploy bằng `dc.sh` (qua npm scripts).
5. Kiểm tra health, logs, route công khai và route nội bộ.

## 2) Compose layers

### Core
- `docker-compose/compose.core.yml`
- Chứa `caddy` + `cloudflared`.
- Luôn được nạp.

### Ops
- `docker-compose/compose.ops.yml`
- `dozzle`, `filebrowser`, `webssh`, `webssh-windows`.
- Bật/tắt qua `ENABLE_DOZZLE`, `ENABLE_FILEBROWSER`, `ENABLE_WEBSSH`.

### Access
- `docker-compose/compose.access.yml`
- `tailscale-linux`, `tailscale-windows`, keep-ip prepare/backup loops.
- Bật/tắt qua `ENABLE_TAILSCALE`.

### Apps
- `compose.apps.yml`
- Service `app` mặc định build từ `services/app`.

## 3) Các env bắt buộc (hard-stop)

Các biến dưới đây nếu thiếu/sai sẽ **dừng deploy** ở bước validate:

- `PROJECT_NAME`
- `DOMAIN`
- `CADDY_EMAIL`
- `CADDY_AUTH_USER`
- `CADDY_AUTH_HASH` (bcrypt)
- `APP_PORT`

Thêm nữa, do mount bắt buộc trong `cloudflared`:

- `cloudflared/config.yml` phải tồn tại.
- `cloudflared/credentials.json` phải tồn tại.

Nếu `ENABLE_TAILSCALE=true`, bắt buộc thêm:

- `TAILSCALE_AUTHKEY`
- `TAILSCALE_TAILNET_DOMAIN`

Nếu `TAILSCALE_KEEP_IP_ENABLE=true`, bắt buộc thêm:

- `TAILSCALE_KEEP_IP_FIREBASE_URL` (https + kết thúc `.json`).

Nếu `TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE=true`, bắt buộc thêm:

- `TAILSCALE_CLIENTID`
- `TAILSCALE_AUTHKEY` theo format `tskey-client-...`

## 4) Các env optional nhưng nên cấu hình

- `APP_HOST_PORT`: mở truy cập localhost trực tiếp.
- `NODE_ENV`: mặc định `production`.
- `PB_VERSION`: mặc định `0.28.2`.
- `LITESTREAM_INIT_MODE`: `true` cho lần chạy đầu (khởi tạo DB mới), sau đó trả về `false`.
- `LITESTREAM_S3_PATH`: mặc định `pocketbase/data.db`.
- `DOCKER_SOCK`: đường dẫn docker socket nếu khác mặc định.
- `TAILSCALE_TAGS`: mặc định `tag:container`.
- `TAILSCALE_KEEP_IP_INTERVAL_SEC`: mặc định `30`.
- `CUR_WHOAMI`, `CUR_WORK_DIR`, `SHELL`: hỗ trợ webssh Linux thân thiện hơn.
- `DOZZLE_HOST_PORT` (default `18080`): cổng localhost cho Dozzle.
- `FILEBROWSER_HOST_PORT` (default `18081`): cổng localhost cho Filebrowser.
- `WEBSSH_HOST_PORT` (default `17681`): cổng localhost cho WebSSH.

## 5) Cấu hình Cloudflare Tunnel (chi tiết kỹ thuật)

1. Tạo tunnel trên Cloudflare Zero Trust.
2. Tải `credentials.json` đặt tại `cloudflared/credentials.json`.
3. Cập nhật `cloudflared/config.yml`:
   - `tunnel`: tunnel id
   - `credentials-file`: `/etc/cloudflared/credentials.json`
   - `ingress`: route hostname -> `http://caddy:80`
4. Trên DNS Cloudflare, các record hostname phải trỏ đúng tunnel.

Mọi request public đi theo chuỗi:

`Internet -> Cloudflare Edge -> cloudflared -> caddy -> app/ops service`

## 6) Caddy labels và routing

Routing dựa labels trong compose:

- App: `${PROJECT_NAME}.${DOMAIN}` (+ alias `main.${DOMAIN}`, `${DOMAIN}`)
- Dozzle: `logs.${PROJECT_NAME}.${DOMAIN}`
- Filebrowser: `files.${PROJECT_NAME}.${DOMAIN}`
- WebSSH: `ttyd.${PROJECT_NAME}.${DOMAIN}`

Auth cơ bản dùng:

- User: `CADDY_AUTH_USER`
- Hash: `CADDY_AUTH_HASH`

## 7) Lệnh deploy đề xuất

```bash
npm run dockerapp-validate:env
npm run dockerapp-validate:compose
npm run dockerapp-exec:up
npm run dockerapp-exec:ps
npm run dockerapp-exec:logs
```

## Truy cập dịch vụ qua Tailscale hostname + port

Khi `ENABLE_TAILSCALE=true`, bạn có thể dùng hostname tailnet của node:

- `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${DOZZLE_HOST_PORT:-18080}` → Dozzle
- `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${FILEBROWSER_HOST_PORT:-18081}` → Filebrowser
- `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${WEBSSH_HOST_PORT:-17681}` → WebSSH

Ghi chú:
- Các cổng này bind `127.0.0.1` trên host; truy cập qua tailnet phụ thuộc cách bạn chạy Tailscale (container host-network Linux hay host-level trên Windows/WSL).
- Nếu không truy cập được qua tailnet, kiểm tra firewall host và trạng thái route/Tailscale.

## 8) Kiểm tra sau deploy

- `docker compose ps` tất cả service expected đều `running`/`healthy`.
- Truy cập `http(s)://<project>.<domain>` qua tunnel.
- Kiểm tra endpoint health: `/api/health`.
- Nếu bật Tailscale: truy cập `https://<PROJECT_NAME>.<TAILSCALE_TAILNET_DOMAIN>`.

## 9) Tài liệu từng dịch vụ

- `docs/services/caddy.md`
- `docs/services/cloudflared.md`
- `docs/services/app.md`
- `docs/services/dozzle.md`
- `docs/services/filebrowser.md`
- `docs/services/webssh.md`
- `docs/services/tailscale.md`
- `docs/services/consul.md`
