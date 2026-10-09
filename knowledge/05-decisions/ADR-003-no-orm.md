# ADR-003: Không Sử Dụng ORM — Sử Dụng `pg` Raw SQL / Kysely Siêu Nhẹ

## Trạng thái: ĐÃ PHÊ DUYỆT (ACCEPTED)

## Bối cảnh
Các thư viện ORM phổ biến (đặc biệt là Prisma với Query Engine viết bằng C++/Rust) tiêu tốn từ 100MB–200MB RAM chỉ cho runtime engine và tiến trình con. Trên VPS 3GB RAM, chi phí này là quá đắt đỏ và không kiểm soát trực tiếp được các truy vấn nguyên tử phức tạp.

## Quyết định
Sử dụng thư viện **`pg` (node-postgres)** kết hợp truy vấn Parameterized Raw SQL hoặc query builder TypeScript thuần **Kysely** (zero runtime binary, zero memory overhead).

## Hệ quả & Lợi ích
- **Tiết kiệm RAM:** Tiết kiệm hơn 150MB RAM cho container API.
- **Kiểm soát tuyệt đối:** Dễ dàng viết các câu lệnh `UPDATE ... WHERE ... RETURNING ...` phức tạp để đảm bảo tính nguyên tử chống Race Condition.
- **Tốc độ:** Tốc độ thực thi truy vấn đạt mức tối đa của kết nối socket Postgres.
