# ANTIGRAVITY WORKSPACE RULES & PLAN PROTOCOL

## I. TỔNG QUAN DỰ ÁN & RÀNG BUỘC KỸ THUẬT
* **Dự án:** Hệ thống Onboarding Đăng ký Khuôn mặt Học sinh tích hợp HANET Cloud (1.200 học sinh).
* **Ràng buộc hạ tầng:** VPS Ubuntu 3 vCPU, 3.0 GB RAM, 20 GB SSD, 2.0 GB Swap.
* **Tài liệu tham chiếu chuẩn:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) và [README.md](README.md).
* **Nguyên tắc an toàn:** Không bao giờ triển khai giải pháp làm tăng RAM vượt ngưỡng giới hạn container (Docker RAM Limit tối đa 2.1 GB).

---

## II. QUY CHUẨN NGHIÊM NGẶT CHO CHẾ ĐỘ LẬP KẾ HOẠCH (/plan MODE)

Khi người dùng kích hoạt lệnh `/plan`, yêu cầu lập kế hoạch hoặc bắt đầu một tính năng/giai đoạn mới, Agent **BẮT BUỘC** tuân thủ 3 trụ cột và quy trình 4 bước dưới đây:

### 1. Phân quyền công cụ (Tool Permissions & Sandbox Control)
* **Công cụ ĐƯỢC PHÉP dùng:** `view_file`, `run_command` (chỉ các lệnh read-only như `ls`, `git status`, `cat`, kiểm tra thông số), `search_web`, `read_url_content`, `ask_question`.
* **Công cụ BỊ CẤM trong Plan Mode:** `write_to_file` (ngoại trừ ghi vào `implementation_plan.md`), `replace_file_content`, các lệnh terminal gây biến đổi mã nguồn, migrate DB, hoặc `git push`.
* **Nguyên tắc Cốt lõi:** **TUYỆT ĐỐI KHÔNG TỰ Ý VIẾT CODE SẢN PHẨM HOẶC SỬA MÃ NGUỒN KHI CHƯA ĐƯỢC PHÊ DUYỆT.**

### 2. Giao thức Thực thi 4 Bước (4-Stage Execution Protocol)

#### Bước 1: Khảo sát & Phân tích (Analysis & Discovery)
* Khảo sát kỹ mã nguồn hiện có, cấu trúc thư mục, tệp cấu hình và tài liệu kiến trúc tại `docs/ARCHITECTURE.md`.
* Xác định chính xác các component, module, database table hoặc API bị ảnh hưởng.

#### Bước 2: Phỏng vấn & Làm rõ (Clarification & Interviewing)
* Nếu có bất kỳ quyết định kiến trúc nào có nhiều phương án đánh đổi (trade-offs) (ví dụ: Fastify vs Express, Kysely vs Prisma, cấu trúc thư mục, chiến lược mock HANET API):
* **BẮT BUỘC** dừng lại và dùng câu hỏi trắc nghiệm hoặc lựa chọn rõ ràng (Option A vs Option B kèm ưu/nhược điểm) để người dùng xác nhận, **KHÔNG ĐƯỢC TỰ SUY DIỄN**.

#### Bước 3: Xuất bản Kế hoạch Chuẩn hóa (Structured Plan Artifact)
* Ghi kết quả kế hoạch ra tệp `implementation_plan.md` (hoặc tạo Artifact markdown) theo đúng cấu trúc chuẩn:
  - Bối cảnh & Ràng buộc phần cứng.
  - Các quyết định kỹ thuật đã thống nhất.
  - Danh sách công việc chia theo từng Phase tuần tự (Phase 1: Infra -> Phase 2: Core DB -> Phase 3: Business Logic & API -> Phase 4: Worker/Queues -> Phase 5: Test & CI/CD).
  - Mỗi Phase **BẮT BUỘC** có tiêu chí kiểm chứng cụ thể (*Checkpoint / Verification Step*).

#### Bước 4: Chờ Phê duyệt (User Review & Handoff Trigger)
* Tóm tắt ngắn gọn kế hoạch cho người dùng và yêu cầu người dùng xem xét `implementation_plan.md`.
* **DỪNG LẠI HOÀN TOÀN** và chờ người dùng phản hồi rõ ràng như `"Proceed"`, `"Approved"`, hoặc `"Đồng ý"`.
* Chỉ khi nhận được sự đồng thuận mới được chuyển sang chế độ viết code (Execution/Code Mode).

---

## III. ĐỊNH DẠNG CHUẨN CỦA FILE ARTIFACT `implementation_plan.md`

Mọi bản kế hoạch tạo ra phải tuân theo cấu trúc sau:

```markdown
# Implementation Plan: [Tên Hệ Thống / Tính Năng]

## 1. Architectural Context & Constraints
- Hardware/VPS Limits: (Ví dụ: VPS 3GB RAM, BullMQ Concurrency=1, Nginx 5MB limit)
- Affected Files: (Danh sách đường dẫn file cần tạo hoặc sửa đổi)

## 2. Technical Decisions (From Clarification)
- Database Layer: [Ví dụ: Kysely / Drizzle / Raw SQL + PostgreSQL 16]
- API Framework: [Ví dụ: Fastify / Express]
- Queue Engine: BullMQ + Redis 7 AOF
- Test Strategy: Mock server HANET Cloud API

## 3. Phased Execution Checklist

### Phase 1: [Tên giai đoạn, ví dụ: Docker & Hạ tầng Cơ sở]
- [ ] Task 1.1: Tạo file `docker-compose.yml` với ma trận RAM Limit theo ARCHITECTURE.md
- [ ] Task 1.2: Cấu hình `docker/postgres/init.sql` và Redis AOF
*Checkpoint Verification:* Chạy `docker compose up -d` và xác nhận lệnh `docker stats` đạt RAM < 1GB.

### Phase 2: [Tên giai đoạn tiếp theo]
- [ ] Task 2.1: ...
*Checkpoint Verification:* ...

## 4. Handoff Trigger
- Khi người dùng phản hồi **"Proceed"**, Agent chuyển sang Code Mode và thực thi tuần tự từ Phase 1.
```
