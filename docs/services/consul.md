# Consul Firebase lease + Read-only standby (`compose.apps.yml`)

## Mục tiêu

- Đảm bảo chỉ có **1 writer** tại một thời điểm khi chạy nhiều node.
- Node không giữ lease chạy ở chế độ **standby read-only** để phục vụ GET/HEAD cho API.
- Có thể tái sử dụng cho app khác vì logic được tách module NodeJS.

## Thành phần

- Module lease: `modules/consul-firebase/lease-manager.js`
- Gateway reverse proxy: `services/consul-gateway/server.js`
- Service runtime: `consul-gateway` trong `compose.apps.yml`

Luồng request:

`Client -> cloudflared -> caddy -> consul-gateway -> app(PocketBase)`

## Env chính

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `CONSUL_FIREBASE_ENABLE` | `false` | Bật chế độ lease/fencing |
| `CONSUL_FIREBASE_URL` | (rỗng) | URL Firebase RTDB endpoint dạng `https://.../path.json?...` |
| `CONSUL_GATEWAY_PORT` | `18090` | Port gateway trong network nội bộ |
| `CONSUL_NODE_ID` | `<project>-<hostname>` | Định danh owner lease |
| `CONSUL_LEASE_TTL_MS` | `70000` | Lease TTL |
| `CONSUL_LEASE_RENEW_MS` | `15000` | Chu kỳ renew lease |
| `CONSUL_LEASE_POLL_MS` | `10000` | Chu kỳ poll fallback |
| `CONSUL_FIREBASE_SSE_ENABLE` | `true` | Bật realtime listener SSE |
| `CONSUL_LOST_LEASE_EXIT` | `false` | Mất lease thì exit process (hard fencing) |
| `CONSUL_STANDBY_ALLOW_API_READONLY` | `true` | Cho standby phục vụ GET/HEAD `/api/*` |
| `CONSUL_TAKEOVER_ON_JOIN` | `false` | Node mới join sẽ preempt lease ngay khi start |

## Quy tắc hoạt động

### 1) Khi `CONSUL_FIREBASE_ENABLE=false`

- Gateway chạy pass-through, không lease.
- Tất cả method đều được proxy sang app.

### 2) Khi `CONSUL_FIREBASE_ENABLE=true`

- Gateway cố acquire/renew lease tại Firebase.
- Nếu giữ lease: role = `writer` -> cho phép toàn bộ request.
- Nếu không giữ lease: role = `standby`.
  - Chỉ cho phép `GET`, `HEAD` với path `/api` hoặc `/api/*`.
  - Các request còn lại trả `503` với mã `standby_readonly`.

### 2.1) Node mới join có tự làm leader không?

- Mặc định (`CONSUL_TAKEOVER_ON_JOIN=false`): **không**. Node mới sẽ chỉ thành writer khi lease hiện tại hết hạn hoặc lease rỗng.
- Nếu bật `CONSUL_TAKEOVER_ON_JOIN=true`: node mới sẽ cố preempt lease ngay lúc start. Node cũ sẽ mất lease và chuyển standby (hoặc thoát process nếu bật `CONSUL_LOST_LEASE_EXIT=true`).

### 3) Lost lease

- Mặc định: role chuyển về standby, tiếp tục phục vụ read-only.
- Nếu `CONSUL_LOST_LEASE_EXIT=true`: process gateway thoát để fencing cứng.

## Quy tắc vận hành đề xuất

1. Tất cả node cùng bật `CONSUL_FIREBASE_ENABLE=true`.
2. Dùng chung `CONSUL_FIREBASE_URL` lease path.
3. Mỗi node phải có `CONSUL_NODE_ID` khác nhau.
4. Khuyến nghị bật SSE (`CONSUL_FIREBASE_SSE_ENABLE=true`) để chuyển role nhanh.
5. Nếu workload write nhạy cảm, bật thêm `CONSUL_LOST_LEASE_EXIT=true`.

## Quy trình kiểm tra nhanh

### A. Kiểm tra role hiện tại

```bash
curl -s http://127.0.0.1:${CONSUL_GATEWAY_PORT:-18090}/__consul/status | jq .
```

Kỳ vọng:
- `role: writer` trên 1 node.
- node còn lại `role: standby`.

### B. Kiểm tra chặn write trên standby

```bash
curl -i -X POST https://<domain>/api/collections/example/records
```

Kỳ vọng: `503` + body `standby_readonly` khi request rơi vào standby.

### C. Kiểm tra read vẫn chạy ở standby

```bash
curl -i https://<domain>/api/health
```

Kỳ vọng: `200` (GET /api/* vẫn phục vụ được).

### D. Test switchover

1. Dừng node writer hiện tại.
2. Đợi lease hết TTL + 1 chu kỳ renew/poll.
3. Node còn lại trở thành `writer`.

## Quy trình xử lý lỗi

### Lỗi 1: Không acquire được lease

Triệu chứng:
- status luôn `standby`
- log `[lease][renew]` hoặc `[lease][poll]`

Checklist:
- `CONSUL_FIREBASE_URL` đúng dạng HTTPS + `.json`.
- Secret/token trong URL còn hiệu lực.
- Node clock không lệch quá nhiều.

### Lỗi 1.1: `HTTP 400 khi ghi lease`

Nguyên nhân hay gặp:
- URL bị ghép sai do dùng biến base đã chứa sẵn `...json?auth=...` rồi lại nối thêm path.

Ví dụ sai:
- `https://.../env.json?auth=xxx/demo-consul-lease.json?auth=xxx`

Ví dụ đúng:
- `https://...-default-rtdb.asia-southeast1.firebasedatabase.app/demo-consul-lease.json?auth=xxx`

Khuyến nghị:
- Dùng biến base chỉ gồm domain (`DOTENVRTDB_BASE_URL`) rồi nối path `.json` sau cùng.

### Lỗi 2: Role nhảy liên tục writer/standby

Checklist:
- Tăng `CONSUL_LEASE_TTL_MS` (vd 90s).
- Giảm `CONSUL_LEASE_RENEW_MS` (vd 10-15s).
- Kiểm tra network đến Firebase.

### Lỗi 3: GET vẫn bị chặn ở standby

Checklist:
- `CONSUL_STANDBY_ALLOW_API_READONLY=true`.
- Endpoint có path bắt đầu bằng `/api`.
- Method phải là GET/HEAD.

## Mở rộng cho app khác

- Chỉ cần đổi `CONSUL_UPSTREAM_URL` để trỏ upstream mới.
- Có thể tái dùng nguyên module `modules/consul-firebase/lease-manager.js`.
- Có thể thêm policy path/method khác trong `services/consul-gateway/server.js`.
