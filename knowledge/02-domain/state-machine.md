# MÁY TRẠNG THÁI HỌC SINH (STUDENT STATE MACHINE)

## 1. Sơ đồ Chuyển dịch Trạng thái

```
               ┌──────────┐
               │  empty   │  (Ban đầu: Chưa nộp ảnh)
               └────┬─────┘
                    │
                    │ [HS bấm nộp ảnh]
                    ▼
               ┌──────────┐
               │ pending  │  (Đã nhận ảnh, đang xếp hàng trong BullMQ)
               └────┬─────┘
                    │
         ┌──────────┴──────────┐
         │ [Worker gọi HANET]  │
         ▼                     ▼
   ┌───────────┐         ┌───────────┐
   │  success  │         │   error   │ (Lỗi tạm thời: retry_count < 3)
   └───────────┘         └─────┬─────┘
                               │
            ┌──────────────────┴──────────────────┐
            │ [Thử lại thành công]                │ [retry_count >= 3 HOẶC lỗi mặt]
            ▼                                     ▼
      ┌───────────┐                        ┌───────────────┐
      │  success  │                        │ manual_review │ (Cần can thiệp thủ công)
      └───────────┘                        └───────────────┘
```

## 2. Câu lệnh Cập nhật Nguyên tử (Atomic Conditional Update)

Để tránh tình trạng 2 học sinh cùng chọn 1 hồ sơ hoặc bấm nộp 2 lần liên tiếp:

```sql
UPDATE students 
SET 
  status = 'pending',
  local_image_path = $1,
  retry_count = 0,
  updated_at = NOW()
WHERE id = $2 
  AND status IN ('empty', 'error', 'manual_review')
RETURNING id, alias_id, person_id, status;
```

* **Nếu `rowCount > 0`:** Cập nhật thành công $\rightarrow$ Đẩy job vào BullMQ $\rightarrow$ Trả về `HTTP 200 { success: true, message: "Đang xử lý ảnh" }`.
* **Nếu `rowCount === 0`:** Bản ghi đã ở trạng thái `pending` hoặc `success` $\rightarrow$ Trả về ngay `HTTP 409 Conflict: Hồ sơ này đang được xử lý hoặc đã hoàn tất`.
