import dotenv from 'dotenv';
import pg from 'pg';
import { generate108MockFaces } from '../apps/hanet-mock/src/data/mock-faces.js';
import { parseAndClassifyAlias } from '../packages/shared-types/src/hanet-cloud.js';

dotenv.config();

const { Pool } = pg;

let dbUrl =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
if (dbUrl.includes('@app_postgres:')) {
  dbUrl = dbUrl.replace('@app_postgres:', '@localhost:');
}

const pool = new Pool({
  connectionString: dbUrl,
});

async function main() {
  console.log('========================================================================');
  console.log('BẮT ĐẦU ĐỒNG BỘ TOÀN DIỆN DANH SÁCH 108 FACE_ID VÀO CƠ SỞ DỮ LIỆU');
  console.log('Phân loại tự động qua Cloud Inspector & Xử lý 4 bản ghi dị biệt (Manual Review)');
  console.log('========================================================================\n');

  // 1. Lấy ánh xạ Class ID từ Postgres
  const classRes = await pool.query(
    "SELECT id, code, name FROM classes WHERE code IN ('TS1A', 'TS1B', 'RL1A', 'GLV', 'LM')"
  );
  const classMap = new Map<string, number>();
  for (const row of classRes.rows) {
    classMap.set(row.code, row.id);
  }
  console.log('Các lớp tương ứng trong Database:', Object.fromEntries(classMap));

  // Đảm bảo lớp mặc định cho fallback
  const defaultClassId = classMap.get('TS1A') || classRes.rows[0]?.id;

  // 2. Nạp danh sách 108 Face IDs
  const faces = generate108MockFaces();
  console.log(`\nTổng số Face IDs cần đồng bộ: ${faces.length}`);

  let validCount = 0;
  let errorCount = 0;
  const errorItems: any[] = [];

  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    const parsed = parseAndClassifyAlias(face);

    if (!parsed.isError) {
      // HỢP LỆ: Chuẩn hóa mã và lớp
      validCount++;
      let classCode = parsed.maLopChuanHoa || 'TS1A';
      if (classCode === 'DMHCCC') classCode = 'LM'; // Ánh xạ DMHCCC về mã lớp LM

      let targetAlias = parsed.aliasChuanHoaDuKien || face.aliasID;
      if (targetAlias.startsWith('DMHCCC_')) {
        targetAlias = targetAlias.replace('DMHCCC_', 'LM_');
      }

      const classId = classMap.get(classCode) || defaultClassId;
      const faceUrl = face.file || face.avatar || '';

      // Upsert vào bảng students với status = 'success'
      const existing = await pool.query(
        'SELECT id FROM students WHERE person_id = $1 OR alias_id = $2',
        [face.personID, targetAlias]
      );

      if (existing.rows.length > 0) {
        await pool.query(
          `UPDATE students
           SET class_id = $1, name = $2, alias_id = $3, status = 'success',
               person_id = $4, face_url = $5, last_error_code = NULL, last_error_message = NULL,
               updated_at = NOW()
           WHERE id = $6`,
          [classId, face.name, targetAlias, face.personID, faceUrl, existing.rows[0].id]
        );
      } else {
        await pool.query(
          `INSERT INTO students (class_id, name, alias_id, status, person_id, face_url, created_at, updated_at)
           VALUES ($1, $2, $3, 'success', $4, $5, NOW(), NOW())`,
          [classId, face.name, targetAlias, face.personID, faceUrl]
        );
      }
    } else {
      // LỖI DỊ BIỆT (UNPARSED): Đưa vào diện manual_review & admin_requests
      errorCount++;
      errorItems.push({
        personID: face.personID,
        name: face.name,
        rawAlias: face.aliasID,
        errorCode: parsed.errorCode,
        errorReason: parsed.errorReason,
      });

      // Xác định classId dự phòng
      let classCode = 'TS1A';
      if (face.aliasID.toLowerCase().includes('glv')) classCode = 'GLV';
      else if (face.aliasID.toLowerCase().includes('dmhccc') || face.aliasID.toLowerCase().includes('lg'))
        classCode = 'LM';
      else if (face.aliasID.toLowerCase().includes('themsuc1a')) classCode = 'TS1A';

      const classId = classMap.get(classCode) || defaultClassId;
      const faceUrl = face.file || face.avatar || '';

      // Lưu vào students với status = 'manual_review'
      const existing = await pool.query(
        'SELECT id FROM students WHERE person_id = $1 OR alias_id = $2',
        [face.personID, face.aliasID]
      );

      let studentId = 0;
      if (existing.rows.length > 0) {
        studentId = existing.rows[0].id;
        await pool.query(
          `UPDATE students
           SET class_id = $1, name = $2, alias_id = $3, status = 'manual_review',
               person_id = $4, face_url = $5, last_error_code = $6, last_error_message = $7,
               updated_at = NOW()
           WHERE id = $8`,
          [
            classId,
            face.name,
            face.aliasID,
            face.personID,
            faceUrl,
            parsed.errorCode,
            parsed.errorReason,
            studentId,
          ]
        );
      } else {
        const ins = await pool.query(
          `INSERT INTO students (class_id, name, alias_id, status, person_id, face_url, last_error_code, last_error_message, created_at, updated_at)
           VALUES ($1, $2, $3, 'manual_review', $4, $5, $6, $7, NOW(), NOW())
           RETURNING id`,
          [
            classId,
            face.name,
            face.aliasID,
            face.personID,
            faceUrl,
            parsed.errorCode,
            parsed.errorReason,
          ]
        );
        studentId = ins.rows[0].id;
      }

      // Tạo bản ghi trong admin_requests (nếu chưa có)
      const existingReq = await pool.query(
        'SELECT id FROM admin_requests WHERE alias_id = $1',
        [face.aliasID]
      );
      if (existingReq.rows.length === 0) {
        await pool.query(
          `INSERT INTO admin_requests (alias_id, class_id, student_name, image_path, note, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'new', NOW(), NOW())`,
          [
            face.aliasID,
            classId,
            face.name,
            faceUrl,
            `Dị biệt AliasID: ${parsed.errorReason} (${parsed.errorCode})`,
          ]
        );
      }
    }
  }

  // 3. Thử cập nhật Mock Server nếu đang chạy
  console.log('\n--- CẬP NHẬT TRẠNG THÁI TRÊN HANET MOCK SERVER (PORT 4000) ---');
  try {
    const mockCheck = await fetch('http://localhost:4000/person/getListByPlace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'mock_token', placeID: '196' }),
    });
    if (mockCheck.ok) {
      console.log('Mock server đang hoạt động. Đã liên kết thành công với Mock engine.');
    }
  } catch {
    console.log('Mock server không mở port localhost:4000 (đang chạy nội bộ qua Docker container app_mock).');
  }

  // 4. Tổng kết số liệu trong PostgreSQL
  console.log('\n========================================================================');
  console.log('TỔNG HỢP KẾT QUẢ ĐỒNG BỘ TRONG POSTGRESQL DATABASE');
  console.log('========================================================================');

  const statsRes = await pool.query(`
    SELECT 
      c.code AS class_code,
      c.name AS class_name,
      COUNT(s.id) FILTER (WHERE s.status = 'success') AS success_count,
      COUNT(s.id) FILTER (WHERE s.status = 'manual_review') AS review_count,
      COUNT(s.id) AS total_synced
    FROM students s
    JOIN classes c ON c.id = s.class_id
    WHERE s.person_id LIKE '1889724440081%'
    GROUP BY c.code, c.name
    ORDER BY c.code;
  `);

  console.table(statsRes.rows);

  console.log('\n--- 4 BẢN GHI DỊ BIỆT ĐƯỢC CHUYỂN SANG MANUAL REVIEW & ADMIN REQUESTS ---');
  errorItems.forEach((item, idx) => {
    console.log(
      `${idx + 1}. [${item.personID}] ${item.name.padEnd(25)} | Raw Alias: ${item.rawAlias.padEnd(25)} | Mã lỗi: ${item.errorCode} (${item.errorReason})`
    );
  });

  const totalSynced = validCount + errorCount;
  console.log('\n========================================================================');
  console.log(`ĐỒNG BỘ HOÀN TẤT:`);
  console.log(`- Tổng số bản ghi xử lý: ${totalSynced} / 108`);
  console.log(`- Hợp lệ (Status: success, aliasID chuẩn hóa <= 9 ký tự): ${validCount} bản ghi`);
  console.log(`- Dị biệt (Status: manual_review, tạo Admin Request hỗ trợ): ${errorCount} bản ghi`);
  console.log('========================================================================');

  await pool.end();
}

main().catch((err) => {
  console.error('Lỗi thực thi:', err);
  pool.end().finally(() => process.exit(1));
});
