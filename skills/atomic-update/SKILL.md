---
name: atomic-update
description: Thực hiện truy vấn cập nhật nguyên tử có điều kiện trong PostgreSQL để triệt tiêu Race Condition.
---

# SKILL: Cập Nhật Dữ Liệu Nguyên Tử (Atomic Conditional Update)

## 1. Mục đích
Ngăn chặn triệt để tình trạng 2 học sinh cùng chọn 1 tên hoặc người dùng bấm nút nộp liên tục gây trùng lặp job trong hàng đợi.

## 2. Mã Truy Vấn SQL & Xử lý (TypeScript)

```typescript
import { Pool } from 'pg';

export async function lockStudentForRegistration(
  db: Pool,
  studentId: number,
  imagePath: string
): Promise<{ id: number; alias_id: string; person_id: string | null }> {
  const query = `
    UPDATE students 
    SET 
      status = 'pending',
      local_image_path = $1,
      retry_count = 0,
      updated_at = NOW()
    WHERE id = $2 
      AND status IN ('empty', 'error', 'manual_review')
    RETURNING id, alias_id, person_id;
  `;

  const result = await db.query(query, [imagePath, studentId]);

  if (result.rowCount === 0) {
    // Không có bản ghi nào thỏa mãn điều kiện WHERE -> Đã có người nộp hoặc đang pending
    const error: any = new Error('Hồ sơ học sinh này đang được xử lý hoặc đã đăng ký thành công');
    error.statusCode = 409;
    error.code = 'RECORD_LOCKED';
    throw error;
  }

  return result.rows[0];
}
```

## 3. Checklist Kiểm chứng
- [ ] Mệnh đề `WHERE` có kiểm tra điều kiện trạng thái hiện tại (`empty`, `error`, `manual_review`).
- [ ] Dùng mệnh đề `RETURNING` để nhận kết quả trong 1 lượt round-trip duy nhất (không SELECT trước rồi UPDATE sau).
- [ ] Bắt trường hợp `rowCount === 0` và trả về `HTTP 409 Conflict`.
