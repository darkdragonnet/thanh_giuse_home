# RÀNG BUỘC KIẾN TRÚC & HẠ TẦNG

## 1. Ma trận Container (BẤT BIẾN)
Tổng bộ nhớ RAM của toàn bộ 5 container không được vượt quá **2.112 MB** nhằm dự trữ ít nhất 500 MB cho OS Cache và Buffer:

| Container | Image | CPU Limit | RAM Reserve | RAM Limit | Ghi chú cấu hình |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `app_proxy` | `nginx:alpine` | 0.5 vCPU | 32 MB | **128 MB** | Client max body 5MB, serve static SPA & `/tmp-faces/` |
| `app_postgres` | `postgres:16-alpine` | 1.0 vCPU | 256 MB | **512 MB** | `shared_buffers=128MB`, `max_connections=40` |
| `app_redis` | `redis:7-alpine` | 0.5 vCPU | 64 MB | **192 MB** | `maxmemory 128mb`, `noeviction`, AOF enabled |
| `app_api` | `node:20-alpine` | 1.0 vCPU | 128 MB | **512 MB** | Fastify 4, `--max-old-space-size=384` |
| `app_worker` | `node:20-alpine` | 1.5 vCPU | 256 MB | **768 MB** | BullMQ Concurrency=1, `stop_grace_period: 150s` |

## 2. Nguyên tắc An toàn Mạng (Network Isolation)
* Chỉ có duy nhất `app_proxy` được mở cổng ra ngoài Internet (`80` / `443` / `8080`).
* Toàn bộ các dịch vụ cơ sở dữ liệu (`app_postgres`), hàng đợi (`app_redis`), và ứng dụng nội bộ (`app_api`, `app_worker`) chỉ kết nối qua mạng nội bộ Docker `thanh_giuse_net`.
* Tuyệt đối không map cổng `5432` hoặc `6379` trực tiếp ra IP công khai của VPS.

## 3. Luồng Dữ liệu (Data Flow Rules)
* **API KHÔNG BAO GIỜ gọi HANET trực tiếp:** API chỉ nhận ảnh, kiểm tra mã PIN/Rate Limit, thực hiện Atomic Update trạng thái `pending`, ghi nhận Job vào Redis BullMQ và phản hồi HTTP 200 (Biên nhận Asynchronous) trong vòng dưới 50ms.
* **Worker là nơi duy nhất tương tác với HANET Cloud:** Xử lý tuần tự từng job, resize chuẩn 1280x736, gọi HANET và cập nhật kết quả cuối cùng.
* **Tự động dọn dẹp file ảnh tạm:** File ảnh tạm trong volume sau khi nạp thành công lên HANET CDN phải được giải phóng định kỳ.
* **Bảo toàn phòng ban khi đổi AliasID:** Khi cập nhật `aliasID` trên HANET Cloud, BẮT BUỘC áp dụng quy trình 2 bước an toàn (`POST /person/updateAliasID` kết hợp `POST /department/add-person`) hoặc nguyên khối (`POST /person/updateInfo` kèm `departmentID`) để bảo toàn chỉ mục phòng ban, tránh lỗi bị detach hoặc reset về 0 (tham khảo skill `hanet-preserve-department`).
