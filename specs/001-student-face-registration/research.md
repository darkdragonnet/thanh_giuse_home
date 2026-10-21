# Phase 0 Research & Technical Decisions: Student Face Registration

Feature: `001-student-face-registration`  
Date: 2026-10-21  

---

## 1. Paced Background Sync (Nhịp điều tiết 1 request/phút)

### Quyết định
Sử dụng cấu hình Rate Limiting của BullMQ kết hợp tham số hệ thống `hanet_sync_rate_limit` (mặc định: 1 tác vụ / 60.000 ms) trên Queue Worker (`concurrency: 1`).

### Lý do lựa chọn
- **Bảo vệ phần cứng VPS**: RAM 3.0 GB không cho phép xử lý ảnh song song nhiều tiến trình. Sharp chạy với `concurrency: 1` và giải phóng RAM buffer ngay sau mỗi ảnh.
- **Tuân thủ đối tác HANET**: Ngăn ngừa triệt để lỗi nghẽn `-503 (Overloaded)` và cạn kiệt hạn ngạch `-9008`.
- **Dự báo chính xác**: Với quy mô 1.200 học sinh toàn trường, thời gian đồng bộ nền được dự báo ổn định trong ~20 giờ (1.200 phút).

### Các phương án thay thế đã đánh giá
- *Phương án A: Xử lý tức thì (Burst / Concurrency > 1)*: Bị loại bỏ vì sẽ làm tăng đột biến RAM của Worker vượt quá 768 MB và dễ bị HANET ngắt kết nối.
- *Phương án B: Cronjob định kỳ*: Bị loại bỏ vì khó theo dõi vị trí hàng đợi (Queue Position) và không tận dụng được cơ chế retry tinh vi của BullMQ.

---

## 2. Chuẩn hóa & Tiền nén ảnh tại Client (Canvas Pre-compression)

### Quyết định
Trình duyệt học sinh dùng HTML5 Canvas để tự động rescale ảnh về cạnh lớn nhất tối đa 1920px và nén chất lượng JPEG 0.85 trước khi gửi multipart/form-data.
- **Mục tiêu nén client**: < 800 KB (theo Principle V).
- **Trần tiếp nhận cứng kỹ thuật**: < 1 MB.
- **Reverse Proxy guard**: Chặn tuyệt đối payload > 5 MB (`client_max_body_size 5M`).

### Lý do lựa chọn
- Giảm tải 90% băng thông mạng (ảnh từ camera 12MP thường nặng 5MB-10MB giảm còn 400KB-700KB).
- Giảm thiểu thời gian tải lên (upload time < 1 giây trên mạng 4G thông thường), giúp phản hồi biên nhận đạt < 1.500 ms.
- Giữ nguyên các điểm mốc sinh trắc khuôn mặt (Facial Landmarks) cần thiết cho AI nhận diện.

### Các phương án thay thế đã đánh giá
- *Chỉ nén trên Server bằng Sharp*: Bị loại bỏ vì Nginx và Node.js API phải nhận file dung lượng lớn 10MB từ hàng chục học sinh cùng lúc, dễ dẫn đến tràn buffer và nghẽn CPU.

---

## 3. Kiến trúc Thăm dò Tiến độ (Short Polling 3s vs WebSocket)

### Quyết định
Sử dụng HTTP Short Polling mỗi 3 giây (`GET /api/students/:id/status`) kèm phản hồi vị trí số thứ tự trong hàng đợi (*Queue Position Feedback*). Trạng thái `pending` duy trì liên tục và KHÔNG bao giờ bị hết hạn.

### Lý do lựa chọn
- **Tiết kiệm RAM tuyệt đối**: Không duy trì kết nối Socket thường trực (Persistent Connection), loại bỏ chi phí quản lý file descriptor và socket state trên Nginx và Node.js.
- **Độ tin cậy cao trên Mobile**: Mạng di động 4G thường xuyên chập chờn hoặc đổi IP; HTTP Polling khôi phục tự nhiên mà không cần cơ chế reconnect phức tạp của WebSocket.
- **Tối ưu tra cứu**: Vị trí hàng đợi được tính toán nhanh từ BullMQ/Redis (`waitingCount` hoặc `job.getState()`) và cache ngắn hạn trong Redis để phản hồi siêu tốc.

### Các phương án thay thế đã đánh giá
- *WebSocket / SSE (Server-Sent Events)*: Bị loại bỏ theo Principle V / ADR-004 vì gây tốn RAM không cần thiết trên hạ tầng VPS 3GB.

---

## 4. Khóa Nguyên tử và Phân quyền Trạng thái (Atomic Conditional Lock)

### Quyết định
Áp dụng câu lệnh SQL điều kiện nguyên tử cập nhật trực tiếp tại PostgreSQL:
- Cổng học sinh nộp ảnh chỉ tiếp nhận khi trạng thái học sinh thuộc `('empty', 'error')`.
- Trạng thái `manual_review` chỉ được mở khóa bởi Quản trị viên (Admin).
- Trả về `HTTP 409 Conflict` nếu không có bản ghi nào được cập nhật.

### Lý do lựa chọn
- Triệt tiêu 100% Race Condition kể cả khi có 2 tab trình duyệt hoặc học sinh và phụ huynh cùng bấm gửi đồng thời.
- Rõ ràng vai trò nghiệp vụ: Học sinh không thể tự nộp lại khi hồ sơ đang bị giữ để rà soát kỹ thuật.

---

## 5. Phân tầng Rate Limiting (Infrastructure Ceiling vs Student Identity vs Teacher PIN)

### Quyết định
Áp dụng cơ chế bảo vệ 3 lớp:
1. **Trần hạ tầng cho các Endpoint Ghi (Infrastructure IP Ceiling for WRITE)**: Nginx/Fastify áp dụng trần 60 req/phút/IP CHỈ trên các endpoint ghi (`POST /api/students/:id/photo` và xác thực PIN) để chống công cụ quét / brute-force thô. Toàn bộ các thao tác đọc (`GET /status` polling 3 giây = 20 req/phút/em, danh sách lớp, học sinh) được miễn trừ trần này, cho phép 30–40 em cùng lớp thoải mái polling và duyệt danh sách trên cùng 1 mạng Wi-Fi/NAT mà không bị gián đoạn.
2. **Hạn mức định danh Học sinh**: Tối đa 3 lần nộp trong 15 phút cho 1 mã học sinh.
3. **Miễn trừ Giáo viên (Teacher PIN Bypass)**: Khi yêu cầu có mã xác thực lớp hợp lệ, hệ thống miễn trừ giới hạn nộp liên tục, cho phép giáo viên chụp 30-40 em trong tiết học.
