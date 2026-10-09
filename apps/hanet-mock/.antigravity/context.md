# CONTEXT — HANET MOCK SERVER

## Mục đích
Giả lập HANET Cloud API để test hệ thống đăng ký khuôn mặt học sinh mà KHÔNG cần gọi HANET thật (tiết kiệm quota, tránh rate limit).

## Vai trò trong hệ thống
- Worker (apps/worker) gọi mock server thay vì partner.hanet.ai
- Đổi base URL qua biến môi trường HANET_BASE_URL
- Mock chạy trong Docker network nội bộ, KHÔNG expose internet

## Stack bắt buộc
- Node.js 20 Alpine
- Fastify 4 (KHÔNG dùng Express)
- TypeScript strict mode
- In-memory state (không database)
- Vitest cho unit test

## Ràng buộc tài nguyên
- RAM limit: 128 MB
- CPU limit: 0.5 vCPU
- Không gọi ra internet
- Không dùng quá 100MB disk

## Đầu mối tích hợp
- HANET_BASE_URL=http://hanet-mock:4000 (trong Docker network)
- HANET_BASE_URL=http://localhost:4000 (khi dev local)
