import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { Redis } from 'ioredis';
import {
  RawCloudFace,
  parseAndClassifyAlias,
  FIXED_9CHAR_ALIAS_REGEX,
} from '@thanh-giuse/shared-types';

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

const { Pool } = pg;

// 1. Cấu hình biến môi trường HANET Cloud & Database
const token = process.env.HANET_ACCESS_TOKEN || process.env.HANET_TOKEN || '';
const rawPlaceId = process.env.HANET_PLACE_ID || '998577';
const primaryUrl = (process.env.HANET_API_BASE_URL || 'https://partner.hanet.ai').replace(/\/$/, '');

if (!token) {
  console.error('❌ LỖI: Thiếu cấu hình HANET_ACCESS_TOKEN trong môi trường (.env)');
  process.exit(1);
}

let dbUrl =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';

// Nếu chạy ngoài host (không nằm trong Docker network), tự động fallback @app_postgres -> @localhost
const isInsideDocker = process.env.RUNNING_IN_DOCKER === 'true' || process.cwd() === '/app';
if (!isInsideDocker && dbUrl.includes('@app_postgres:')) {
  dbUrl = dbUrl.replace('@app_postgres:', '@localhost:');
}

const pool = new Pool({
  connectionString: dbUrl,
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tự động kiểm tra và sửa Place ID nếu cấu hình nhầm Device ID (VD: C21242M187)
 */
async function resolveValidPlaceID(
  placeIdInput: string,
  accessToken: string,
  baseUrl: string
): Promise<{ resolvedPlaceID: string; placeName?: string }> {
  const trimmed = placeIdInput.trim();
  if (/^\d+$/.test(trimmed)) {
    return { resolvedPlaceID: trimmed };
  }

  let foundPlaceId = '998577';
  let placeName = 'Giáo xứ Thánh Giuse';

  if (accessToken && baseUrl.includes('partner.hanet.ai')) {
    try {
      const res = await fetch(`${baseUrl}/place/getPlaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: accessToken }).toString(),
      });
      if (res.ok) {
        const json = (await res.json()) as any;
        if (json?.returnCode === 1 && Array.isArray(json?.data) && json.data.length > 0) {
          foundPlaceId = String(json.data[0].id);
          placeName = json.data[0].name || placeName;
        }
      }
    } catch {
      // Fallback an toàn về 998577
    }
  }

  console.warn(
    `⚠️  Cảnh báo: HANET_PLACE_ID='${trimmed}' là mã thiết bị. Tự động định tuyến về Place ID: ${foundPlaceId} (${placeName}).`
  );
  return { resolvedPlaceID: foundPlaceId, placeName };
}

/**
 * Quét toàn bộ danh sách nhân sự trên HANET Cloud (Auto-Pagination)
 */
async function fetchAllCloudFaces(
  accessToken: string,
  placeID: string,
  baseUrl: string
): Promise<{ faces: RawCloudFace[]; connectedUrl: string }> {
  const isCloudPrimary = baseUrl.includes('partner.hanet.ai');
  const candidateUrls = isCloudPrimary
    ? [baseUrl]
    : [baseUrl, 'http://app_mock:4000', 'http://localhost:4000', 'http://127.0.0.1:4000'];

  let lastError: any = null;

  for (const url of candidateUrls) {
    try {
      let page = 1;
      const size = 50;
      const maxPages = 35;
      const collected: RawCloudFace[] = [];
      let prevFirstPersonID: string | null = null;
      let encounteredError = false;

      while (page <= maxPages) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const postData = new URLSearchParams({
          token: accessToken,
          placeID,
          page: String(page),
          size: String(size),
          type: '0',
        });

        const res = await fetch(`${url.replace(/\/$/, '')}/person/getListByPlace`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: postData.toString(),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
          encounteredError = true;
          break;
        }

        const json = (await res.json()) as any;
        if (json?.returnCode === -103) {
          throw new Error('HANET_TOKEN_EXPIRED (-103): Access Token đã hết hạn!');
        }

        if (json?.returnCode !== 1 || !Array.isArray(json?.data) || json.data.length === 0) {
          if (page === 1 && json?.returnCode !== 1) {
            lastError = new Error(
              `HANET trả về lỗi [${json?.returnCode}]: ${json?.returnMessage || 'Thất bại'}`
            );
          }
          break;
        }

        const currentFirstPersonID = json.data[0]?.personID;
        if (currentFirstPersonID && currentFirstPersonID === prevFirstPersonID) {
          break;
        }
        prevFirstPersonID = currentFirstPersonID;

        collected.push(...json.data);

        if (json.data.length < size) {
          break;
        }

        page++;
        await sleep(200);
      }

      if (!encounteredError && collected.length > 0) {
        return { faces: collected, connectedUrl: url.replace(/\/$/, '') };
      }
    } catch (err: any) {
      if (err.message?.includes('HANET_TOKEN_EXPIRED')) {
        throw err;
      }
      lastError = err;
    }
  }

  if (lastError) {
    throw lastError;
  }
  return { faces: [], connectedUrl: baseUrl };
}

/**
 * Gọi API HANET POST x-www-form-urlencoded
 */
async function callHanetPost(
  baseUrl: string,
  endpoint: string,
  params: Record<string, string>
): Promise<{ returnCode: number; returnMessage: string; data?: any }> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    form.append(k, v);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as { returnCode: number; returnMessage: string; data?: any };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  // Hỗ trợ truyền tham số --dry-run hoặc lọc theo personID nếu cần
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const filterArg = args.find((a) => a.startsWith('--person-ids='));
  const selectedIds = filterArg
    ? new Set(
        filterArg
          .replace('--person-ids=', '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      )
    : null;

  console.log('========================================================================');
  console.log('🚀 ONE-OFF CLI MIGRATION: CHUẨN HÓA ALIASID 9 KÝ TỰ TRÊN HANET CLOUD');
  console.log('   Công thức: finalAliasId = Prefix4_Suffix4(personID) (FNV-1a Base36)');
  console.log('   Chế độ chạy: Trực tiếp qua CLI (Bypass 100% Nginx Timeout 60s)');
  if (isDryRun) {
    console.log('   ⚠️  CHẾ ĐỘ DRY-RUN: Chỉ tính toán và in log, KHÔNG ghi lên Cloud/DB');
  }
  console.log('========================================================================\n');

  // 1. Giải quyết PlaceID hợp lệ & Quét danh sách khuôn mặt từ HANET Cloud
  const { resolvedPlaceID } = await resolveValidPlaceID(rawPlaceId, token, primaryUrl);
  console.log(`📡 Đang tải danh sách khuôn mặt từ HANET Cloud (PlaceID: ${resolvedPlaceID})...`);

  const { faces: rawFaces, connectedUrl } = await fetchAllCloudFaces(
    token,
    resolvedPlaceID,
    primaryUrl
  );

  console.log(`✅ Đã kết nối tới: ${connectedUrl}`);
  console.log(`📊 Tổng số khuôn mặt tải về từ Cloud: ${rawFaces.length}\n`);

  if (rawFaces.length === 0) {
    console.log('⚠️  Không tìm thấy khuôn mặt nào trên Cloud để đồng bộ.');
    await pool.end();
    return;
  }

  // 2. Tải danh sách lớp học (classes) từ PostgreSQL để ánh xạ class_id
  const classesRes = await pool.query<{ id: number; code: string }>(
    'SELECT id, code FROM classes'
  );
  const classByCode = new Map<string, number>();
  for (const c of classesRes.rows) {
    classByCode.set(c.code.toUpperCase(), c.id);
  }
  const defaultClassId = classesRes.rows[0]?.id ?? null;

  // 3. Phân tích và lọc danh sách cần xử lý
  const parsedList = rawFaces.map((face) => ({
    raw: face,
    parsed: parseAndClassifyAlias(face),
  }));

  const targetList = selectedIds
    ? parsedList.filter((item) => selectedIds.has(item.raw.personID))
    : parsedList;

  const total = targetList.length;
  let successCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  console.log(`🔄 Bắt đầu xử lý tuần tự ${total} hồ sơ (Nghỉ 3.000ms giữa mỗi lần gọi Cloud)...\n`);

  for (let i = 0; i < total; i++) {
    const idx = i + 1;
    const { raw, parsed } = targetList[i]!;
    const personID = String(raw.personID).trim();
    const oldAlias = (raw.aliasID || '').trim();
    const studentName = (raw.name || '').trim();

    if (parsed.isError || !parsed.aliasChuanHoaDuKien) {
      failedCount++;
      console.error(
        `[${idx}/${total}] ⚠️  Bỏ qua (Dị biệt): ${studentName} (personID: ${personID}, rawAlias: "${oldAlias}") -> Lỗi: ${parsed.errorReason || parsed.errorCode}`
      );
      continue;
    }

    const finalAliasId = parsed.aliasChuanHoaDuKien;

    // Kiểm tra chốt chặn chuẩn 9 ký tự
    if (!FIXED_9CHAR_ALIAS_REGEX.test(finalAliasId)) {
      failedCount++;
      console.error(
        `[${idx}/${total}] ❌ Lỗi định dạng: ${finalAliasId} không khớp chuẩn 9 ký tự (${studentName})`
      );
      continue;
    }

    // Xác định class_id trong PostgreSQL (Hỗ trợ fallback GLV0 -> GLV, LM01 -> LM)
    const normalizedCode = (parsed.maLopChuanHoa || '').toUpperCase();
    let classId = classByCode.get(normalizedCode) ?? null;
    if (!classId && normalizedCode === 'GLV0') {
      classId = classByCode.get('GLV') ?? null;
    }
    if (!classId && normalizedCode === 'LM01') {
      classId = classByCode.get('LM') ?? null;
    }
    if (!classId) {
      classId = defaultClassId;
    }

    // Xác định departmentID an toàn để khóa lại phòng ban trên HANET
    const finalDeptId =
      raw.departmentID && String(raw.departmentID) !== '0'
        ? String(raw.departmentID)
        : parsed.nhom1_nganh === 'LM'
        ? '990730'
        : '990653';

    if (isDryRun) {
      successCount++;
      console.log(
        `[${idx}/${total}] [DRY-RUN] Sẽ đồng bộ: ${finalAliasId} (Cũ: ${oldAlias}) - ${studentName} [PersonID: ${personID}, Class: ${normalizedCode}, Dept: ${finalDeptId}]`
      );
      continue;
    }

    try {
      // BƯỚC A: Gọi API Cloud cập nhật aliasID + khóa lại departmentID
      const isAlreadyMatchedOnCloud = oldAlias === finalAliasId;

      if (!isAlreadyMatchedOnCloud) {
        const step1 = await callHanetPost(connectedUrl, '/person/updateAliasID', {
          token,
          personID,
          aliasID: finalAliasId,
        });

        if (step1.returnCode === -103) {
          console.error(
            `\n🚨 LỖI NGHIÊM TRỌNG [-103]: HANET Access Token đã hết hạn! Dừng tiến trình ngay lập tức.`
          );
          break;
        }

        if (step1.returnCode !== 1 && step1.returnCode !== -9005) {
          failedCount++;
          console.error(
            `[${idx}/${total}] ❌ Lỗi Cloud (${step1.returnCode}): ${finalAliasId} (${studentName}) -> ${step1.returnMessage}`
          );
          await sleep(3000);
          continue;
        }

        // Nghỉ 120ms giữa 2 bước gọi HANET
        await sleep(120);

        // Bước khóa lại phòng ban (bảo toàn departmentID trên HANET Cloud)
        if (finalDeptId && finalDeptId !== '0') {
          const step2 = await callHanetPost(connectedUrl, '/department/add-person', {
            token,
            departmentID: finalDeptId,
            personIDs: personID,
          });
          if (step2.returnCode !== 1) {
            console.warn(
              `   ⚠️  Cảnh báo gán lại phòng ban (${finalDeptId}) cho ${finalAliasId}: ${step2.returnMessage}`
            );
          }
        }
      } else {
        skippedCount++;
      }

      // BƯỚC B: Cập nhật vào PostgreSQL bảng students & ghi Audit Log
      const faceUrl = raw.file || raw.avatar || null;
      const existingRes = await pool.query<{ id: number }>(
        'SELECT id FROM students WHERE person_id = $1 OR alias_id = $2 OR alias_id = $3 LIMIT 1',
        [personID, finalAliasId, oldAlias]
      );

      let studentId: number;
      if (existingRes.rows.length > 0) {
        studentId = existingRes.rows[0]!.id;
        await pool.query(
          `UPDATE students
           SET alias_id = $1,
               person_id = $2,
               name = COALESCE(NULLIF($3, ''), name),
               class_id = COALESCE($4, class_id),
               face_url = COALESCE($5, face_url),
               status = 'success',
               last_error_code = NULL,
               last_error_message = NULL,
               updated_at = NOW()
           WHERE id = $6`,
          [finalAliasId, personID, studentName, classId, faceUrl, studentId]
        );
      } else {
        const insRes = await pool.query<{ id: number }>(
          `INSERT INTO students (class_id, name, alias_id, status, person_id, face_url, created_at, updated_at)
           VALUES ($1, $2, $3, 'success', $4, $5, NOW(), NOW())
           ON CONFLICT (alias_id) DO UPDATE
           SET person_id = EXCLUDED.person_id,
               name = EXCLUDED.name,
               class_id = COALESCE(EXCLUDED.class_id, students.class_id),
               status = 'success',
               updated_at = NOW()
           RETURNING id`,
          [classId, studentName, finalAliasId, personID, faceUrl]
        );
        studentId = insRes.rows[0]!.id;
      }

      // Ghi log audit vào bảng logs
      await pool.query(
        `INSERT INTO logs (alias_id, class_id, action, result_code, result_message, created_at)
         VALUES ($1, $2, 'CLI_MIGRATE_ALIAS', '1', $3, NOW())`,
        [
          finalAliasId,
          classId,
          `[CLI Migration] Đồng bộ chuẩn 9 ký tự: ${oldAlias} -> ${finalAliasId} (personID: ${personID})`,
        ]
      );

      successCount++;
      console.log(
        `[${idx}/${total}] Đồng bộ thành công: ${finalAliasId} (${studentName}${isAlreadyMatchedOnCloud ? ' - Đã chuẩn trên Cloud, cập nhật DB' : ` <- ${oldAlias}`})`
      );

      // BƯỚC C: Nghỉ 3 giây (3.000ms) giữa mỗi bạn nếu có gọi API Cloud đổi mã và chưa phải người cuối cùng
      if (!isAlreadyMatchedOnCloud && i < total - 1) {
        await sleep(3000);
      }
    } catch (err: any) {
      failedCount++;
      console.error(
        `[${idx}/${total}] ❌ Ngoại lệ khi xử lý ${finalAliasId} (${studentName}): ${err.message}`
      );
      if (i < total - 1) {
        await sleep(3000);
      }
    }
  }

  // 4. Xóa cache Redis để giao diện Admin Web cập nhật ngay lập tức
  if (!isDryRun && process.env.REDIS_URL) {
    try {
      let redisUrl = process.env.REDIS_URL;
      if (!isInsideDocker && redisUrl.includes('@app_redis:')) {
        redisUrl = redisUrl.replace('@app_redis:', '@localhost:');
      }
      const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
      await redis.del('cache:hanet:real_cloud_faces');
      await redis.quit();
      console.log('\n🧹 Đã xóa cache Redis (cache:hanet:real_cloud_faces) để làm mới giao diện Admin.');
    } catch {
      // Bỏ qua nếu không kết nối được Redis
    }
  }

  console.log('\n========================================================================');
  console.log('🏁 KẾT QUẢ TỔNG KẾT MIGRATION:');
  console.log(`   - Tổng số hồ sơ xử lý : ${total}`);
  console.log(`   - Thành công          : ${successCount} (Trong đó đã chuẩn sẵn trên Cloud: ${skippedCount})`);
  console.log(`   - Thất bại / Bỏ qua   : ${failedCount}`);
  console.log('========================================================================');

  await pool.end();
}

main().catch((err) => {
  console.error('🚨 Lỗi thực thi script migrate-cloud-aliases:', err);
  pool.end().finally(() => process.exit(1));
});
