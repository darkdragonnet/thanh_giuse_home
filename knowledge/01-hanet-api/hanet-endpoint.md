# HANET Endpoint Integration & Queue Architecture

Tài liệu này định nghĩa kiến trúc và chuẩn tích hợp các endpoint HANET thông qua hàng đợi tập trung **BullMQ v5** trên môi trường Node 20+ (ESM & TypeScript).

---

## 1. Nguyên Tắc Cốt Lõi

1. **Bất Đồng Bộ Tuyệt Đối**: 
   - 100% request từ client hoặc webhook liên quan đến HANET API chỉ ghi nhận dữ liệu local, tạo Job vào `registration_queue` và trả về phản hồi ngay lập tức (`202 Accepted` hoặc trạng thái `pending_sync`).
   - Không được thực hiện các cuộc gọi HTTP đồng bộ tới HANET API trong request-response cycle của `apps/api` (ngoại trừ các endpoint đọc dữ liệu đối soát của Admin Dashboard như `/admin/cloud-inspector`).
2. **Hạ Tầng Queue Thống Nhất**:
   - Sử dụng thư viện **BullMQ v5** chạy trên Node 20 (ESM).
   - Sử dụng duy nhất hàng đợi `registration_queue` kết nối qua `REDIS_URL` tập trung (không hardcode `DB 4` hay cổng riêng lẻ).
   - Phân biệt các hành vi bằng tên Job (`job.name`).

---

## 2. Cấu Trình Hàng Đợi (Queue Setup)

### 2.1. Kết nối Redis & Khởi tạo Queue (`apps/api` & `apps/worker`)

```typescript
// shared/queue.ts
import { Queue, QueueOptions } from 'bullmq';
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/0';

export const redisConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null, // Yêu cầu bắt buộc của BullMQ
  enableReadyCheck: false,
});

const defaultQueueOptions: QueueOptions = {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 2000, // Thử lại sau 2s, 4s, 8s...
    },
    removeOnComplete: {
      age: 24 * 3600, // Giữ log 24 giờ
      count: 1000,
    },
    removeOnFail: {
      age: 7 * 24 * 3600, // Giữ failed job 7 ngày phục vụ debug
      count: 5000,
    },
  },
};

export const registrationQueue = new Queue('registration_queue', defaultQueueOptions);
```

---

## 3. Các Loại Job & Payload Schema

Thay vì tách nhiều queue, hệ thống phân loại tác vụ thông qua **Job Name**:

| Job Name | Mô tả | Payload tối thiểu |
| :--- | :--- | :--- |
| **`register_face`** | Đăng ký khuôn mặt mới từ form học viên | `{ registrationId, aliasId, name, faceImageUrl }` |
| **`sync_hanet_2000`** | Đồng bộ dữ liệu lịch sử / nhập hàng loạt từ HANET | `{ batchId, offset, limit, triggerBy }` |
| **`update_alias`** | Cập nhật lại `alias_id` khi học viên đổi lớp / phòng ban | `{ memberId, oldAlias, newAlias, personId }` |

### 3.1. Đẩy Job vào Queue (Producer tại `apps/api`)

```typescript
// apps/api/src/services/hanet-sync.service.ts
import { registrationQueue } from '../queue.js';

export interface SyncHanetBatchPayload {
  batchId: string;
  offset: number;
  limit: number;
  triggerBy: string;
}

export async function dispatchHanetSyncJob(payload: SyncHanetBatchPayload) {
  const jobId = `sync_hanet_${payload.batchId}_${payload.offset}`;
  
  return await registrationQueue.add('sync_hanet_2000', payload, {
    jobId, // Tránh duplicate job khi trigger liên tục (Idempotency)
    priority: 2, // Ưu tiên thấp hơn đăng ký khuôn mặt trực tiếp (priority: 1)
  });
}
```

---

## 4. Worker Xử Lý Tác Vụ (Consumer tại `apps/worker`)

### 4.1. Cấu hình Worker & Router Job

```typescript
// apps/worker/src/index.ts
import { Worker, Job } from 'bullmq';
import { redisConnection } from './shared/queue.js';
import { handleFaceRegistration } from './processors/register-face.processor.js';
import { handleHanetSync2000 } from './processors/hanet-sync.processor.js';
import { handleUpdateAlias } from './processors/update-alias.processor.js';

export const registrationWorker = new Worker(
  'registration_queue',
  async (job: Job) => {
    switch (job.name) {
      case 'register_face':
        return await handleFaceRegistration(job.data);

      case 'sync_hanet_2000':
        return await handleHanetSync2000(job.data);

      case 'update_alias':
        return await handleUpdateAlias(job.data);

      default:
        throw new Error(`[Queue Worker] Unsupported job name: ${job.name}`);
    }
  },
  {
    connection: redisConnection,
    concurrency: 1, // Concurrency = 1 để đảm bảo an toàn VPS RAM và không vượt Rate Limit HANET (30 req/phút)
  }
);

// Worker Lifecycle Events
registrationWorker.on('completed', (job: Job) => {
  console.log(`[Job ${job.id}] ${job.name} completed successfully.`);
});

registrationWorker.on('failed', (job: Job | undefined, err: Error) => {
  console.error(`[Job ${job?.id}] ${job?.name} failed with error:`, err.message);
});
```

---

## 5. Xử Lý Lỗi HANET API (Error Matrix & Gotchas)

Bên trong các processor gọi HANET API, worker cần bắt và xử lý các mã lỗi theo đúng quy chuẩn:

```typescript
// apps/worker/src/processors/hanet-sync.processor.ts
import { redisConnection, registrationQueue } from '../shared/queue.js';

export async function handleHanetSync2000(data: any) {
  // 1. Phải lock Redis theo alias_id hoặc batch để đảm bảo Idempotency
  const lockKey = `lock:hanet_sync:${data.batchId || data.aliasId}`;
  const acquired = await redisConnection.set(lockKey, '1', 'PX', 10000, 'NX');
  if (!acquired) {
    console.warn(`[SyncHanet] Batch/Alias ${data.batchId || data.aliasId} đang được xử lý bởi worker khác.`);
    return;
  }

  try {
    const response = await callHanetApi(data);

    // 2. Kiểm tra mã phản hồi HANET
    if (response.returnCode === -103) {
      // Hết hạn token -> Kích hoạt Kill Switch và ném lỗi để BullMQ retry backoff
      await handleTokenExpiredEmergency();
      throw new Error('HANET token expired (-103). Emergency handler triggered, retrying job...');
    }

    if (response.returnCode === -9008) {
      // ══════════════════════════════════════════════════════════════════════════
      // MÃ -9008: HẾT QUOTA FACE ID (CRITICAL / BÁO ĐỎ)
      // ══════════════════════════════════════════════════════════════════════════
      // 1. Ngắt toàn bộ hàng đợi ngay lập tức
      await registrationQueue.pause();

      // 2. Bật cờ hệ thống trong Redis & PostgreSQL vô hiệu hóa tất cả link đăng ký
      await redisConnection.set('system:registration_disabled', '1');
      await redisConnection.set('setting:kill_switch', 'true');
      await redisConnection.set('setting:maintenance_message', 'Hệ thống đã hết quota Face ID trên HANET Cloud.');

      // 3. Phát cảnh báo khẩn cấp (Telegram / Zalo / Email / Log) mức độ CRITICAL / BÁO ĐỎ
      await notifyAdminEmergency({
        level: 'CRITICAL_RED_ALERT',
        code: -9008,
        message: 'BÁO ĐỎ: HANET Cloud đã hết quota Face ID (-9008)! Hàng đợi và link đăng ký đã tự động ngắt.',
      });

      // 4. Ném lỗi không retry (UnrecoverableError) để tránh tốn lượt thử vô nghĩa
      throw new UnrecoverableError('HANET Cloud đã hết quota Face ID (-9008). Hàng đợi đã tạm ngắt, không retry.');
    }

    if (response.returnCode === -9005) {
      // ══════════════════════════════════════════════════════════════════════════
      // MÃ -9005: KHUÔN MẶT HOẶC NGƯỜI DÙNG ĐÃ TỒN TẠI TRÊN HANET
      // ══════════════════════════════════════════════════════════════════════════
      // 1. Lấy thông tin người dùng hiện có từ payload hoặc truy vấn getListByPlace
      const existingPerson = response.data || (await findExistingPersonOnCloud(data.aliasId, data.name));
      const cloudAliasId = existingPerson?.aliasID || existingPerson?.alias_id;

      if (cloudAliasId && cloudAliasId.trim().toUpperCase() === data.aliasId.trim().toUpperCase()) {
        // TRƯỜNG HỢP 1: Trùng khớp alias_id hoàn toàn -> Idempotent Pass
        console.log(`✔ [Idempotent Pass] Học sinh ${data.aliasId} đã tồn tại trên Cloud. Đánh dấu synced.`);
        await updateLocalSyncStatus(data, {
          status: 'synced',
          personId: existingPerson.personID,
          faceUrl: existingPerson.avatar || existingPerson.face_url,
        });
        return;
      } else {
        // TRƯỜNG HỢP 2: Khác alias_id (Khuôn mặt trùng người khác) -> BÁO ĐỎ Xung đột
        console.error(`✖ [BÁO ĐỎ -9005] Xung đột khuôn mặt: ${data.aliasId} trùng với mã khác [${cloudAliasId || 'N/A'}]!`);
        
        // Ghi nhận vào bảng sync_conflicts
        await recordSyncConflict({
          studentId: data.studentId,
          aliasId: data.aliasId,
          cloudPersonId: existingPerson?.personID,
          cloudAliasId: cloudAliasId,
          cloudName: existingPerson?.name,
          conflictType: 'FACE_EXISTING_DIFFERENT_ALIAS',
        });

        // Chuyển trạng thái local sang conflict_pending_review
        await updateLocalSyncStatus(data, {
          status: 'conflict_pending_review',
          errorCode: '-9005',
          errorMessage: `Xung đột khuôn mặt: Đã tồn tại trên Cloud với mã [${cloudAliasId || 'khác'}].`,
        });

        // Phát cảnh báo đỏ cho Admin cần can thiệp thủ công
        await notifyAdminEmergency({
          level: 'CRITICAL_RED_ALERT',
          code: -9005,
          message: `BÁO ĐỎ: Phát hiện xung đột khuôn mặt cho học sinh ${data.name} (${data.aliasId})!`,
        });
        return;
      }
    }

    // Xử lý thành công thông thường
    await updateLocalSyncStatus(data, response);
  } finally {
    await redisConnection.del(lockKey);
  }
}
```

---

## 6. Hướng Dẫn Vượt Giới Hạn 50 Bản Ghi (2.000+ Face ID)

### 6.1. Nguyên nhân kỹ thuật
Endpoint `POST /department/list-person` được thiết kế riêng cho việc duyệt cây danh mục theo phòng ban, do đó HANET quy định cứng tham số `size` tối đa là **50 item/trang**.

### 6.2. Hai phương án xử lý
1. **Phương án 1 (Khuyên dùng - Nhanh nhất):** Sử dụng endpoint **`POST /person/getListByPlace`**. Endpoint này lấy trực tiếp toàn bộ danh sách Face ID trong một `placeID` duy nhất (2.000+ bản ghi) mà không bị giới hạn 50 item mỗi trang.
2. **Phương án 2 (Dành cho duyệt theo phòng ban):** Vòng lặp phân trang tự động `page = 1, 2, 3...` với `size = 50` kèm độ trễ 200ms giữa các request để bảo vệ Rate Limit (30 req/phút).

#### **Mã nguồn TypeScript lấy danh sách theo Place ID (`POST /person/getListByPlace`)**

```typescript
import axios from 'axios';
import qs from 'qs';

export async function getAllPersonsByPlace(token: string, placeID: string | number) {
  const url = 'https://partner.hanet.ai/person/getListByPlace';

  const payload = qs.stringify({ token, placeID });

  const response = await axios.post(url, payload, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000,
  });

  if (response.data?.returnCode === 1) {
    return response.data.data || [];
  }
  throw new Error(`HANET API Error [${response.data?.returnCode}]: ${response.data?.returnMessage}`);
}
```

### 6.3. Ánh Xạ Schema HANET Payload vào Cơ Sở Dữ Liệu Ứng Dụng (Mapping to students Table)

Trong các hướng dẫn mẫu chung của HANET, người ta thường dùng một bảng phẳng generic tên là `persons`. Tuy nhiên, trong ứng dụng quản lý học sinh theo lớp của dự án này, hệ thống chuẩn hóa theo quan hệ `classes` và `students`:

#### Bảng Đối Chiếu Trường Dữ Liệu (Field Mapping Matrix)

| Trường trên HANET Cloud | Kiểu dữ liệu | Trường trong DB Ứng dụng | Bảng tương ứng | Ghi chú xử lý |
| :--- | :--- | :--- | :--- | :--- |
| `personID` (hoặc `id`) | String | `person_id` | `students` | ID nhận diện duy nhất do AI HANET cấp (Source of Truth). |
| `aliasID` (hoặc `alias_id`) | String | `alias_id` | `students` | Mã học sinh định danh nội bộ (Unique index). |
| `name` | String | `name` | `students` | Họ và tên học sinh. |
| `avatar` (hoặc `file`) | String (URL) | `face_url` | `students` | Đường dẫn ảnh CDN do HANET lưu trữ. |
| `title` / `department` | String / Number | `class_id` | `students` $\rightarrow$ `classes(id)` | Ánh xạ tiền tố (VD: `GLV_` $\rightarrow$ Lớp GLV, `TS1A_` $\rightarrow$ Lớp TS1A). |
| — | — | `status` | `students` | Cập nhật thành `'success'` (hoặc `'synced'`) khi đồng bộ thành công. |

#### Câu Lệnh SQL Upsert Chuẩn (PostgreSQL)

```sql
INSERT INTO students (
    class_id,
    name,
    alias_id,
    person_id,
    face_url,
    status,
    retry_count,
    last_error_code,
    last_error_message,
    updated_at
) VALUES ($1, $2, $3, $4, $5, 'success', 0, NULL, NULL, NOW())
ON CONFLICT (alias_id) DO UPDATE SET
    person_id = EXCLUDED.person_id,
    face_url = EXCLUDED.face_url,
    status = 'success',
    last_error_code = NULL,
    last_error_message = NULL,
    updated_at = NOW();
```

#### Câu Lệnh SQL Upsert Chuẩn (Bảo Toàn Dữ Liệu Cục Bộ)

```sql
INSERT INTO students (
    class_id,
    name,
    alias_id,
    person_id,
    face_url,
    status,
    retry_count,
    last_error_code,
    last_error_message,
    updated_at
) VALUES ($1, $2, $3, $4, $5, 'success', 0, NULL, NULL, NOW())
ON CONFLICT (alias_id) DO UPDATE SET
    -- 1. Chỉ cập nhật các trường nhận diện từ Cloud
    person_id = EXCLUDED.person_id,
    face_url = EXCLUDED.face_url,
    status = 'success',
    last_error_code = NULL,
    last_error_message = NULL,
    updated_at = NOW(),
    -- 2. Bảo toàn 100% dữ liệu cục bộ (Không ghi đè lớp học nếu đã có, giữ nguyên tên chuẩn)
    class_id = COALESCE(students.class_id, EXCLUDED.class_id),
    name = COALESCE(students.name, EXCLUDED.name);
```

#### Xử Lý 3 Điểm Trọng Yếu Khi Vận Hành Thực Tế (Production Gotchas)

1. **Triệt tiêu Rủi ro Fallback `targetClassId = 1`:**
   - Tuyệt đối **không** gán cứng về `class_id = 1` khi không nhận diện được tiền tố `alias_id`.
   - Nếu học sinh đã có sẵn trong cơ sở dữ liệu: Giữ nguyên `class_id` hiện tại của họ.
   - Nếu là bản ghi mới từ Cloud nhưng không map được lớp: Gán `class_id = NULL`, chuyển trạng thái sang `conflict_pending_review` và ghi nhận vào bảng `sync_conflicts` (`conflict_type = 'UNMAPPED_CLASS_PREFIX'`) để Admin can thiệp phân loại.

2. **Bảo Toàn Dữ Liệu Cục Bộ:**
   - Dùng `COALESCE(students.name, EXCLUDED.name)` và `COALESCE(students.class_id, EXCLUDED.class_id)` trong mệnh đề `DO UPDATE` để không làm mất thông tin chuẩn hóa nội bộ.

3. **Tính Toàn Vẹn Transaction & Chunking (> 500 bản ghi):**
   - Thay vì mở 1 Transaction giữ hàng ngàn row-lock gây nghẽn RAM VPS, dữ liệu được chia nhỏ thành các **chunk 50–100 bản ghi**.
   - Mỗi chunk chạy 1 Transaction riêng biệt, áp dụng kỹ thuật Bulk Upsert qua `UNNEST` giúp giảm 99% round-trip I/O.

#### Mã Nguồn TypeScript Đồng Bộ Lô Lớn Sản Xuất (Batch Chunking & Bulk UNNEST)

```typescript
import { Pool } from 'pg';

export interface CloudPersonSyncItem {
  personID: string;
  aliasID: string;
  name: string;
  avatar?: string;
  title?: string;
}

/**
 * Chia nhỏ mảng thành các chunk (Lô 50-100 phần tử)
 */
function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Đồng bộ an toàn 2.000+ bản ghi từ HANET Cloud vào bảng students
 */
export async function syncCloudPersonsToStudentsBatch(
  pool: Pool,
  cloudPersons: CloudPersonSyncItem[],
  batchSize = 100
): Promise<{ totalSynced: number; conflictsCount: number }> {
  // 1. Tải bản đồ mã lớp [PREFIX -> ID] từ DB (VD: 'GLV' -> 1, 'TS1A' -> 2)
  const classRes = await pool.query('SELECT id, code FROM classes');
  const classMap = new Map<string, number>(
    classRes.rows.map((r: { id: number; code: string }) => [r.code.trim().toUpperCase(), r.id])
  );

  const chunks = chunkArray(cloudPersons, batchSize);
  let totalSynced = 0;
  let conflictsCount = 0;

  console.log(`[BatchSync] Bắt đầu đồng bộ ${cloudPersons.length} bản ghi qua ${chunks.length} lô...`);

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Chuẩn bị các mảng tham số cho UNNEST
      const classIds: (number | null)[] = [];
      const names: string[] = [];
      const aliasIds: string[] = [];
      const personIds: string[] = [];
      const faceUrls: string[] = [];
      const statuses: string[] = [];

      for (const p of chunk) {
        if (!p.aliasID) continue;

        // Tách tiền tố lớp từ alias_id (VD: GLV_0001 -> GLV)
        const prefix = p.aliasID.split('_')[0]?.trim().toUpperCase() || '';
        const mappedClassId = classMap.get(prefix) || null;

        // Nếu không map được tiền tố -> Đưa vào diện conflict_pending_review
        const initialStatus = mappedClassId ? 'success' : 'conflict_pending_review';

        classIds.push(mappedClassId);
        names.push(p.name || '');
        aliasIds.push(p.aliasID);
        personIds.push(p.personID || '');
        faceUrls.push(p.avatar || '');
        statuses.push(initialStatus);

        if (!mappedClassId) {
          conflictsCount++;
          // Ghi nhận cảnh báo xung đột tiền tố chưa rõ lớp
          await client.query(
            `INSERT INTO sync_conflicts (
              alias_id, cloud_person_id, cloud_alias_id, cloud_name, cloud_face_url, conflict_type, status
            ) VALUES ($1, $2, $3, $4, $5, 'UNMAPPED_CLASS_PREFIX', 'pending_review')
            ON CONFLICT DO NOTHING;`,
            [p.aliasID, p.personID, p.aliasID, p.name, p.avatar || '']
          );
        }
      }

      // Bulk Upsert qua UNNEST trong 1 round-trip duy nhất cho cả lô
      if (aliasIds.length > 0) {
        const bulkQuery = `
          INSERT INTO students (
            class_id, name, alias_id, person_id, face_url, status, retry_count, last_error_code, last_error_message, updated_at
          )
          SELECT 
            u.class_id,
            u.name,
            u.alias_id,
            u.person_id,
            u.face_url,
            u.status::student_status,
            0,
            NULL,
            NULL,
            NOW()
          FROM UNNEST(
            $1::int[],
            $2::text[],
            $3::text[],
            $4::text[],
            $5::text[],
            $6::text[]
          ) AS u(class_id, name, alias_id, person_id, face_url, status)
          ON CONFLICT (alias_id) DO UPDATE SET
            person_id = EXCLUDED.person_id,
            face_url = EXCLUDED.face_url,
            -- Giữ nguyên trạng thái nếu đang bị treo review
            status = CASE 
              WHEN students.status = 'conflict_pending_review' THEN students.status 
              ELSE EXCLUDED.status 
            END,
            -- Bảo toàn dữ liệu cục bộ đã có
            class_id = COALESCE(students.class_id, EXCLUDED.class_id),
            name = CASE 
              WHEN students.name IS NOT NULL AND TRIM(students.name) <> '' THEN students.name
              ELSE EXCLUDED.name 
            END,
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = NOW();
        `;

        await client.query(bulkQuery, [classIds, names, aliasIds, personIds, faceUrls, statuses]);
        totalSynced += aliasIds.length;
      }

      await client.query('COMMIT');
      console.log(` -> [Lô ${chunkIdx + 1}/${chunks.length}] Đồng bộ xong ${chunk.length} học sinh.`);
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error(`✖ [Lô ${chunkIdx + 1}] Thất bại, rollback lô này:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(`✔ [BatchSync Hoàn Tất] Đã đồng bộ: ${totalSynced} học sinh | Chưa phân lớp: ${conflictsCount}`);
  return { totalSynced, conflictsCount };
}
```

### 6.3.3. Quy Chuẩn Đồng Bộ Hàng Loạt (Bulk Sync Specs)
1. **Ràng buộc Khóa Ngoại:** `students.class_id` cho phép `NULL` để tiếp nhận các alias có tiền tố lạ mà không vi phạm ràng buộc DDL.
2. **Chiến Lược Bảo Toàn Tên:** Ưu tiên giữ nguyên tên đã chuẩn hóa tiếng Việt tại local qua toán tử kiểm tra:
   `CASE WHEN students.name IS NOT NULL AND TRIM(students.name) <> '' THEN students.name ELSE EXCLUDED.name END`.
3. **Hiệu Năng & I/O:** Sử dụng pattern `UNNEST` theo từng chunk 100 items trong Transaction độc lập, giảm round-trip tới PostgreSQL và ngăn ngừa table lock kéo dài.

---

## 7. Bảo Toàn Phòng Ban (`departmentID`) khi Cập Nhật `aliasID`

Nguyên nhân khiến nhân sự bị **mất phòng ban (`departmentID` bị reset về 0 hoặc bị gỡ khỏi phòng ban)** khi đổi `aliasID` là do endpoint `POST /person/updateAliasID` của HANET chỉ tác động lên chỉ mục mã nhân sự tùy chỉnh, dẫn đến việc liên kết phòng ban bị giải phóng (detach) khỏi `personID`.

### 7.1. Quy trình 2 bước an toàn (`updateAliasID` + `add-person`) — *Khuyên dùng*

```typescript
import axios from 'axios';
import qs from 'qs';

export async function updateAliasAndPreserveDepartment(
  token: string,
  personID: string,
  newAliasID: string,
  departmentID: number | string
): Promise<boolean> {
  const BASE_URL = 'https://partner.hanet.ai';

  // 1. Cập nhật mã AliasID mới
  const aliasRes = await axios.post(
    `${BASE_URL}/person/updateAliasID`,
    qs.stringify({ token, personID, aliasID: newAliasID }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  if (aliasRes.data?.returnCode !== 1) {
    throw new Error(`Lỗi đổi AliasID: ${aliasRes.data?.returnMessage}`);
  }

  // 2. Gán lại nhân sự vào phòng ban ngay lập tức
  const deptRes = await axios.post(
    `${BASE_URL}/department/add-person`,
    qs.stringify({ token, departmentID, personIDs: personID }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return deptRes.data?.returnCode === 1;
}
```

### 7.2. Cập nhật nguyên khối qua `POST /person/updateInfo`

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
    departmentID: personInfo.departmentID,
  });

  const res = await axios.post('https://partner.hanet.ai/person/updateInfo', payload, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return res.data?.returnCode === 1;
}
```

---

## 8. Checklist Chuyển Đổi (Migration Checklist)

- [x] Gỡ bỏ thư viện `bull` khỏi `package.json` (`npm uninstall bull`).
- [x] Cài đặt `bullmq` và `ioredis` (`npm install bullmq ioredis`).
- [x] Xóa bỏ cấu hình hardcode Redis DB 4, chuyển sang dùng `REDIS_URL` tập trung.
- [x] Đổi tất cả lời gọi đẩy job sang tên queue `registration_queue` với job name tương ứng (`sync_hanet_2000`, `register_face`, `update_alias`).
- [x] Đảm bảo cấu hình Redis client có cờ `maxRetriesPerRequest: null` theo chuẩn BullMQ.
- [x] Áp dụng Redis lock idempotency theo `alias_id` hoặc `batchId`.
- [x] Xử lý mã lỗi `-103` (token hết hạn) và `-9008` (hết quota, tự động pause queue).
