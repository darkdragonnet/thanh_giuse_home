# Implementation Plan: [Tên Hệ Thống / Tính Năng]

## 1. Architectural Context & Constraints
- Hardware/VPS Limits: VPS 3 vCPU, 3.0 GB RAM, 20 GB SSD, 2.0 GB Swap (Docker RAM Limit tối đa 2.1 GB).
- Worker Constraint: BullMQ Concurrency = 1, Sharp resize 1280x736 tuần tự.
- Rate Limit: 5 req / 5 min / IP (Bypass qua teacher PIN hoặc admin session).
- Affected Files: (Danh sách các file cần tạo hoặc sửa đổi)

## 2. Technical Decisions (From Clarification)
- Database Layer: [Ví dụ: Kysely / Drizzle / PostgreSQL 16 Native Pool]
- API Framework: [Ví dụ: Fastify / Express]
- Queue Engine: BullMQ + Redis 7 AOF
- Image Pipeline: Sharp (1280x736, JPEG)
- Test Strategy: Mock server HANET Cloud API

## 3. Phased Execution Checklist

### Phase 1: [Tên giai đoạn, ví dụ: Docker & Hạ tầng Cơ sở]
- [ ] Task 1.1: Tạo file `docker/docker-compose.yml` với ma trận RAM Limit theo ARCHITECTURE.md
- [ ] Task 1.2: Tạo script `docker/postgres/init.sql` và cấu hình Redis AOF
*Checkpoint Verification:* Chạy `docker compose up -d` và xác nhận `docker stats` đạt RAM < 1GB.

### Phase 2: [Tên giai đoạn tiếp theo]
- [ ] Task 2.1: ...
*Checkpoint Verification:* ...

## 4. Handoff Trigger
- Khi người dùng phản hồi **"Proceed"**, Agent chuyển sang Code Mode và thực thi tuần tự từ Phase 1.
