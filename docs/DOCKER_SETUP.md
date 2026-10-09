# HƯỚNG DẪN KHỞI CHẠY & KIỂM THỬ HẠ TẦNG DOCKER

Tài liệu này hướng dẫn cách thiết lập, khởi động và kiểm thử cụm hạ tầng container (PostgreSQL, Redis, Nginx Proxy) trên máy tính macOS cục bộ và trên VPS Ubuntu production.

---

## 1. Cài đặt Docker trên macOS

Bạn có thể chọn 1 trong 2 giải pháp sau:

### Lựa chọn 1: OrbStack (Khuyên dùng - Siêu nhẹ & Nhanh)
* **Ưu điểm:** Khởi động trong 2 giây, ngốn ít CPU/RAM hơn Docker Desktop gấp 4–5 lần, hoàn toàn tương thích với các lệnh `docker` và `docker compose`.
* **Cài đặt:**
  1. Tải tại: [https://orbstack.dev/](https://orbstack.dev/) (hoặc cài qua Homebrew: `brew install orbstack`).
  2. Mở ứng dụng OrbStack và cấp quyền một lần duy nhất.

### Lựa chọn 2: Docker Desktop
* **Cài đặt:** Tải tại [https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/) (chọn bản Apple Silicon hoặc Intel tương ứng với chip máy Mac).

---

## 2. Các Bước Khởi Động Kiểm Thử

### Bước 1: Chuẩn bị tệp cấu hình `.env`
Tại thư mục gốc dự án:
```bash
cp .env.example .env
```
*(Bạn có thể giữ nguyên mật khẩu mặc định khi kiểm thử tại local).*

### Bước 2: Khởi động các dịch vụ hạ tầng cốt lõi
Khởi chạy 3 dịch vụ cơ sở (Database, Redis Cache, Nginx Proxy):
```bash
docker compose -f docker/docker-compose.yml up -d app_postgres app_redis app_proxy
```

### Bước 3: Kiểm tra trạng thái các container
```bash
docker compose -f docker/docker-compose.yml ps
```
Cả 3 container `thanh_giuse_postgres`, `thanh_giuse_redis`, và `thanh_giuse_proxy` phải ở trạng thái `Up` hoặc `running`.

---

## 3. Các Lệnh Kiểm Tra Xác Thực (Verification Commands)

### 3.1. Kiểm tra Cơ sở dữ liệu PostgreSQL 16 & Dữ liệu Seed mẫu
Truy vấn trực tiếp danh sách lớp học và học sinh mẫu đã nạp từ `init.sql`:
```bash
docker exec -it thanh_giuse_postgres psql -U postgres_user -d thanh_giuse_db -c "SELECT * FROM classes;"
```
Kết quả hiển thị: 2 lớp `10A1` và `10A2`.

Truy vấn danh sách học sinh:
```bash
docker exec -it thanh_giuse_postgres psql -U postgres_user -d thanh_giuse_db -c "SELECT id, name, alias_id, status FROM students;"
```
Kết quả hiển thị: 5 học sinh ở trạng thái `empty`.

### 3.2. Kiểm tra Redis 7 & Tính năng AOF
Gửi lệnh kiểm tra PING và xác thực mật khẩu:
```bash
docker exec -it thanh_giuse_redis redis-cli -a super_secure_redis_password_change_me ping
```
Kết quả trả về: `PONG`.

Kiểm tra trạng thái AOF:
```bash
docker exec -it thanh_giuse_redis redis-cli -a super_secure_redis_password_change_me info persistence | grep aof_enabled
```
Kết quả trả về: `aof_enabled:1`.

### 3.3. Kiểm tra Nginx Web Proxy & Giới hạn tải lên
Mở trình duyệt hoặc dùng `curl`:
```bash
curl -I http://localhost
```
Kết quả trả về: `HTTP/1.1 200 OK`, `Server: nginx`.

### 3.4. Kiểm tra Ma trận Bộ nhớ (Docker Stats)
Theo dõi mức độ sử dụng RAM thực tế của cụm container:
```bash
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.MemLimit}}"
```
*Đảm bảo tổng RAM tiêu thụ của cả cụm thấp hơn 500MB khi chạy nền.*

---

## 4. Các Lệnh Quản Trị Hữu Ích

* **Xem log thời gian thực:**
  ```bash
  docker compose -f docker/docker-compose.yml logs -f app_postgres
  ```
* **Dừng cụm container:**
  ```bash
  docker compose -f docker/docker-compose.yml stop
  ```
* **Khởi động lại và xóa sạch dữ liệu để nạp lại từ đầu:**
  ```bash
  docker compose -f docker/docker-compose.yml down -v
  docker compose -f docker/docker-compose.yml up -d app_postgres app_redis app_proxy
  ```
