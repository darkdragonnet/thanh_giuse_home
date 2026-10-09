# ADR-001: Sử dụng Fastify thay vì Express

## Trạng thái: ĐÃ PHÊ DUYỆT (ACCEPTED)

## Bối cảnh
Hệ thống triển khai trên VPS có cấu hình giới hạn (3 vCPU, 3.0 GB RAM), trong đó container API chỉ được phân bổ tối đa 512 MB RAM. Cần một framework web hiệu năng cao, ngốn ít tài nguyên và có sẵn cơ chế schema validation.

## Quyết định
Chọn **Fastify 4+** làm framework chính cho tầng REST API thay vì Express.

## Hệ quả & Lợi ích
- **Hiệu năng:** Xử lý nhanh hơn 2–3 lần so với Express.
- **Tiêu thụ RAM:** Khởi động chiếm chỉ khoảng 30–50 MB RAM (so với 80–120 MB của Express khi kèm nhiều middleware phụ trợ).
- **JSON Schema:** Tích hợp sẵn `Ajv`, tự động kiểm tra tính hợp lệ của request payload và serialize response nhanh gấp 2 lần.
