# Consul Gateway + Firebase Lease — Bảng đối chiếu log thực tế

Tài liệu này dùng để **đối chiếu nhanh** giữa hành vi kỳ vọng và log runtime khi chạy `consul-gateway`.

> Prefix log chuẩn: `[consul] ...`

---

## 1) Khi node khởi động (start)

### 1.1. Gateway start thành công
Ví dụ log:

```txt
[consul] gateway listening on :18090, upstream=http://app:8090, enabled=true
[consul] startup mode=standby-read-only, ownerId=node-a, readonly_api=true
```

Ý nghĩa:
- Process đã listen cổng thành công.
- Mode startup có thể là `standby-read-only` hoặc `leader-writer` tùy kết quả lease ban đầu.

### 1.2. Lease negotiation bắt đầu
Ví dụ log:

```txt
[consul] [lease][state][start] role=standby, self=node-a, lease={empty}, begin lease negotiation
```

Ý nghĩa:
- Lease manager bắt đầu đọc/ghi lease để tranh quyền writer.

### 1.3. Start thất bại, rơi về standby và retry
Ví dụ log:

```txt
[consul] [lease][start] HTTP 400 khi ghi lease: {...}. tạm chạy standby và retry theo chu kỳ.
[consul] [lease][state][start-failed] role=standby, self=node-a, lease={...}, fallback standby + periodic retry
```

Ý nghĩa:
- Không lấy được lease ở pha start.
- Node chuyển sang standby/read-only và sẽ retry theo timer renew/poll.

---

## 2) Khi node đang là leader (writer)

Ví dụ log:

```txt
[consul] [lease][renew-tick] lease write success -> writer, lease={owner=node-a, expiresAt=..., renewedAt=...}
[consul] [lease][state][role-change] role=writer, self=node-a, lease={owner=node-a, ...}, reason=renew-tick: lease renewed
[consul] role changed: standby -> writer. reason=renew-tick: lease renewed
```

Ý nghĩa:
- Renew thành công và node đang giữ lease hợp lệ.
- `role changed` giúp nhìn thấy transition rõ ràng.

---

## 3) Khi có node mới join / node hiện tại mất quyền leader

Trường hợp poll/SSE phát hiện owner khác còn hạn:

```txt
[consul] [lease][poll] detected active leader owner=node-b (self=node-a) -> standby/read-only
[consul] [lease][state][role-change] role=standby, self=node-a, lease={owner=node-b, ...}, reason=poll: owner active khác
[consul] role changed: writer -> standby. reason=poll: owner active khác
```

Hoặc khi conditional write thua race:

```txt
[consul] [lease][renew-tick] optimistic write failed (412), another node won lease -> standby/read-only
```

Ý nghĩa:
- Có leader khác đang active, node local phải về standby/read-only.
- Đây là dấu hiệu quan trọng để chứng minh “node mới join làm node cũ mất quyền ghi”.

---

## 4) Chứng minh read-only đang được enforce

Khi node ở standby mà request ghi đi vào gateway:

```txt
[consul] [readonly-enforce] mode=standby-read-only, blocking method=POST, path=/api/collections/users/records
```

Response trả về:
- HTTP `503`
- JSON `error=standby_readonly`

Ý nghĩa:
- Gateway đang chặn write đúng thiết kế.

---

## 5) Chứng minh trạng thái hiện tại qua endpoint status

Gọi:

```bash
curl -s http://127.0.0.1:18090/__consul/status | jq
```

Log tương ứng:

```txt
[consul] [status] mode=leader-writer, method=GET, path=/__consul/status
```

Ý nghĩa:
- Có thể đối chiếu mode theo log với JSON trả về (`role`, `lease`).

---

## 6) Khi dừng tiến trình (stop)

Khi nhận signal:

```txt
[consul] received SIGTERM, shutting down.
```

Ý nghĩa:
- Gateway đóng server và gọi `leaseManager.stop()` để clear timer + abort SSE.
- Nếu stop do orchestrator (Docker/K8s) thì thường thấy `SIGTERM`; stop thủ công có thể là `SIGINT`.

---

## 7) Checklist đối chiếu nhanh

1. **Start**: có `[lease][state][start]` và `gateway listening`.
2. **Leader**: có `lease write success -> writer` + `role changed: standby -> writer`.
3. **Mất leader**: có `detected active leader owner=... -> standby/read-only` hoặc `optimistic write failed (412)`.
4. **Read-only enforce**: có `[readonly-enforce] ... blocking ...`.
5. **Status check**: có `[status] mode=...` và JSON `/__consul/status` khớp role.
6. **Stop**: có `received SIGTERM|SIGINT, shutting down.`

