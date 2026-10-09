# CONTEXT — HANET MOCK SERVER

## 1. Mục đích
Giả lập dịch vụ đám mây HANET Cloud Open API (https://partner.hanet.ai) nhằm phục vụ phát triển, kiểm thử luồng đăng ký khuôn mặt học sinh, kiểm thử tải và kiểm thử độ chịu lỗi (Chaos testing) mà **KHÔNG** cần gọi tới dịch vụ HANET thật (tiết kiệm hạn ngạch nhận diện, tránh bị khóa do rate limit, và không làm rác dữ liệu thực tế).

## 2. Vai trò trong Hệ thống
* Container Worker (`app_worker`) và các script kiểm thử sẽ kết nối đến Mock Server này thông qua biến môi trường `HANET_BASE_URL=http://hanet-mock:4000`.
* Mock server chạy trong Docker network nội bộ (`thanh_giuse_net` / `hanet-mock-net`), hoàn toàn cách ly, **KHÔNG** expose cổng ra Internet công cộng.

## 3. Công nghệ Bắt buộc
* **Runtime:** Node.js 20 Alpine.
* **Web Framework:** **Fastify 4+** (nhẹ, tối ưu RAM, tích hợp sẵn JSON Schema validation, không dùng Express).
* **Parser:** `@fastify/formbody` (x-www-form-urlencoded) và `@fastify/multipart` (multipart/form-data).
* **Ngôn ngữ:** TypeScript strict mode, target ES2022, module NodeNext.
* **Testing:** Vitest cho unit test và script cURL bash cho integration test.
* **Lưu trữ:** Hoàn toàn **in-memory state** (không dùng cơ sở dữ liệu để đạt tốc độ phản hồi tức thì và không tốn đĩa).

## 4. Ràng buộc Tài nguyên
* **RAM Limit:** 128 MB.
* **CPU Limit:** 0.5 vCPU.
* Phải chạy đồng thời, nhẹ nhàng trên VPS 3GB RAM cùng với 5 container dịch vụ khác.
