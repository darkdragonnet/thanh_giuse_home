---
name: hanet-preserve-department
description: Bảo toàn liên kết phòng ban (departmentID) khi cập nhật aliasID trên HANET Cloud, ngăn chặn lỗi reset về 0 hoặc bị tách khỏi phòng ban.
---

# SKILL: Bảo Toàn Phòng Ban Khi Đổi AliasID HANET (Preserve Department on Alias Update)

## 1. Mục đích
Khi gọi `POST /person/updateAliasID` trên HANET Cloud, endpoint này chỉ cập nhật chỉ mục mã nhân sự tùy chỉnh, dẫn đến việc liên kết phòng ban (`departmentID`) bị giải phóng (detach/reset về 0).
Skill này quy định phương pháp kỹ thuật chuẩn để bảo toàn 100% thông tin phòng ban.

## 2. Các Giải Pháp Triển Khai (TypeScript / Node.js)

### Phương án 1 (Khuyên dùng): Quy trình 2 bước an toàn (`updateAliasID` + `add-person`)

```typescript
import axios from 'axios';
import qs from 'qs';

const BASE_URL = process.env.HANET_API_BASE_URL || 'https://partner.hanet.ai';

export async function updateAliasAndPreserveDepartment(
  token: string,
  personID: string,
  newAliasID: string,
  departmentID: number | string
): Promise<boolean> {
  try {
    // Bước 1: Đổi AliasID
    const aliasRes = await axios.post(
      `${BASE_URL}/person/updateAliasID`,
      qs.stringify({ token, personID, aliasID: newAliasID }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    if (aliasRes.data?.returnCode !== 1) {
      throw new Error(`Đổi AliasID thất bại: ${aliasRes.data?.returnMessage}`);
    }

    // Bước 2: Khóa lại nhân sự vào đúng departmentID ngay lập tức
    const deptRes = await axios.post(
      `${BASE_URL}/department/add-person`,
      qs.stringify({ token, departmentID, personIDs: personID }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    return deptRes.data?.returnCode === 1;
  } catch (error: any) {
    console.error('Lỗi quy trình updateAlias & gán phòng ban:', error.response?.data || error.message);
    throw error;
  }
}
```

### Phương án 2: Cập nhật nguyên khối qua `POST /person/updateInfo`

```typescript
export async function updatePersonInfoAtomic(
  token: string,
  placeID: string | number,
  personInfo: {
    personID: string;
    newAliasID: string;
    name: string;
    title?: string;
    departmentID: number | string;
  }
): Promise<boolean> {
  const payload = qs.stringify({
    token,
    placeID,
    personID: personInfo.personID,
    aliasID: personInfo.newAliasID,
    name: personInfo.name,
    title: personInfo.title || '',
    departmentID: personInfo.departmentID
  });

  const res = await axios.post(
    `${BASE_URL}/person/updateInfo`,
    payload,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return res.data?.returnCode === 1;
}
```

## 3. Checklist Kiểm chứng
- [ ] Tuyệt đối **KHÔNG** chỉ gọi `POST /person/updateAliasID` đơn lẻ mà không có bước gán lại phòng ban.
- [ ] Luôn kiểm tra `returnCode === 1` ở cả Bước 1 và Bước 2.
- [ ] Đối với cập nhật hàng loạt (batch update), delay tối thiểu 200ms giữa các request để tuân thủ Rate Limit (30 req/phút).
- [ ] Đồng bộ lại `class_id` / `departmentID` trong cơ sở dữ liệu nội bộ sau khi hoàn tất.
