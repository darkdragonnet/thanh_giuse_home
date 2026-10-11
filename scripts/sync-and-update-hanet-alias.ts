import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

const token = process.env.HANET_ACCESS_TOKEN;
const placeId = process.env.HANET_PLACE_ID;
const baseUrl = (process.env.HANET_API_BASE_URL || 'https://partner.hanet.ai').replace(/\/$/, '');

if (!token || !placeId) {
  console.error('Thiếu cấu hình HANET_ACCESS_TOKEN hoặc HANET_PLACE_ID trong .env');
  process.exit(1);
}

let dbUrl =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
if (dbUrl.includes('@app_postgres:')) {
  dbUrl = dbUrl.replace('@app_postgres:', '@localhost:');
}

const pool = new Pool({
  connectionString: dbUrl,
});

// Ánh xạ lớp theo tiền tố
const CLASS_MAPPING: Record<string, { classCode: string; prefixNew: string }> = {
  TN_GLV_: { classCode: 'GLV', prefixNew: 'GLV_' },
  LM_DMHCCC_: { classCode: 'LM', prefixNew: 'LM_' },
  TN_THEMSUC1A_: { classCode: 'TS1A', prefixNew: 'TS1A_' },
  TN_THEMSUC1C_: { classCode: 'TS1C', prefixNew: 'TS1C_' },
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callHanetApi(endpoint: string, params: Record<string, string>) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    form.append(k, v);
  }

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`HTTP Error: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as { returnCode: number; returnMessage: string; data: any };
}

async function main() {
  console.log('========================================================================');
  console.log('BẮT ĐẦU ĐỒNG BỘ & CẬP NHẬT ALIASID MỚI TỪ LOCALHOST LÊN HANET CLOUD');
  console.log('Áp dụng Quy trình 2 bước an toàn (updateAliasID + add-person) bảo toàn phòng ban');
  console.log('========================================================================\n');

  // 1. Lấy thông tin Class IDs từ Local Postgres
  const classRes = await pool.query(
    "SELECT id, code, name FROM classes WHERE code IN ('GLV', 'LM', 'TS1A', 'TS1C')"
  );
  const classMap = new Map<string, number>();
  for (const row of classRes.rows) {
    classMap.set(row.code, row.id);
  }
  console.log('Các lớp tương ứng trong Database:', Object.fromEntries(classMap));

  // 2. Lấy danh sách 50 nhân sự hiện tại trên Cloud HANET
  console.log('\n[1/4] Đang lấy danh sách nhân sự từ HANET Cloud (placeID: ' + placeId + ')...');
  const cloudListRes = await callHanetApi('/person/getListByPlace', {
    token,
    placeID: placeId,
  });

  const persons: any[] = cloudListRes.data || [];
  console.log(`Tìm thấy ${persons.length} nhân sự trên Cloud HANET.`);

  const updateResults: Array<{
    personID: string;
    name: string;
    oldAliasID: string;
    newAliasID: string;
    departmentID: number;
    aliasUpdated: boolean;
    deptLocked: boolean;
    localSynced: boolean;
    note?: string;
  }> = [];

  // 3. Xử lý cập nhật từng người
  console.log('\n[2/4] Tiến hành cập nhật AliasID mới và khóa phòng ban cho từng nhân sự...');

  for (let i = 0; i < persons.length; i++) {
    const p = persons[i];
    let newAliasID = p.aliasID;
    let targetClassCode = '';

    // Xác định tiền tố và mã lớp
    for (const [oldPrefix, meta] of Object.entries(CLASS_MAPPING)) {
      if (p.aliasID.startsWith(oldPrefix)) {
        newAliasID = `${meta.prefixNew}${p.aliasID.substring(oldPrefix.length)}`;
        targetClassCode = meta.classCode;
        break;
      }
    }

    // Nếu đã là tiền tố mới chuẩn
    if (!targetClassCode) {
      if (p.aliasID.startsWith('GLV_')) targetClassCode = 'GLV';
      else if (p.aliasID.startsWith('LM_')) targetClassCode = 'LM';
      else if (p.aliasID.startsWith('TS1A_')) targetClassCode = 'TS1A';
      else if (p.aliasID.startsWith('TS1C_')) targetClassCode = 'TS1C';
    }

    const classId = classMap.get(targetClassCode);
    const departmentID = p.departmentID;
    let aliasUpdated = false;
    let deptLocked = false;
    let localSynced = false;
    let note = '';

    // Ghi chú nếu là trường hợp người trùng tên Tân
    if (p.name.includes('Trần Nhật Minh Tân')) {
      note = 'Trường hợp đặc biệt: Nhân sự trùng tên Minh Tân';
    }

    console.log(
      `\n[${i + 1}/${persons.length}] Xử lý: ${p.name} | Alias: ${p.aliasID} -> ${newAliasID} (Dept: ${departmentID})`
    );

    // BƯỚC 1: Cập nhật AliasID trên HANET Cloud nếu cần đổi
    if (newAliasID !== p.aliasID) {
      try {
        const step1 = await callHanetApi('/person/updateAliasID', {
          token,
          personID: p.personID,
          aliasID: newAliasID,
        });

        if (step1.returnCode === 1) {
          aliasUpdated = true;
          console.log(`  -> Bước 1 (Đổi AliasID): THÀNH CÔNG (${newAliasID})`);
        } else {
          console.error(`  -> Bước 1 LỖI: ${step1.returnMessage}`);
        }
      } catch (err: any) {
        console.error(`  -> Bước 1 Ngoại lệ: ${err.message}`);
      }

      await delay(120);

      // BƯỚC 2: Khóa lại phòng ban (add-person) nếu có departmentID
      if (departmentID && departmentID > 0) {
        try {
          const step2 = await callHanetApi('/department/add-person', {
            token,
            departmentID: String(departmentID),
            personIDs: p.personID,
          });

          if (step2.returnCode === 1) {
            deptLocked = true;
            console.log(`  -> Bước 2 (Khóa phòng ban): THÀNH CÔNG (Dept: ${departmentID})`);
          } else {
            console.error(`  -> Bước 2 LỖI: ${step2.returnMessage}`);
          }
        } catch (err: any) {
          console.error(`  -> Bước 2 Ngoại lệ: ${err.message}`);
        }
      }

      await delay(120);
    } else {
      console.log(`  -> AliasID đã ở định dạng chuẩn mới (${newAliasID}). Bỏ qua gọi API HANET.`);
      aliasUpdated = true;
      deptLocked = true;
    }

    // BƯỚC 3: Đồng bộ vào PostgreSQL Local
    if (classId) {
      try {
        const existingStudent = await pool.query(
          'SELECT id FROM students WHERE person_id = $1 OR alias_id = $2',
          [p.personID, newAliasID]
        );

        if (existingStudent.rows.length > 0) {
          await pool.query(
            `UPDATE students
             SET class_id = $1, name = $2, alias_id = $3, status = 'success',
                 person_id = $4, face_url = $5, updated_at = NOW()
             WHERE id = $6`,
            [classId, p.name, newAliasID, p.personID, p.avatar, existingStudent.rows[0].id]
          );
        } else {
          await pool.query(
            `INSERT INTO students (class_id, name, alias_id, status, person_id, face_url, created_at, updated_at)
             VALUES ($1, $2, $3, 'success', $4, $5, NOW(), NOW())`,
            [classId, p.name, newAliasID, p.personID, p.avatar]
          );
        }
        localSynced = true;
        console.log(`  -> Đồng bộ Local DB: THÀNH CÔNG (ClassID: ${classId})`);
      } catch (err: any) {
        console.error(`  -> Lỗi lưu Local DB: ${err.message}`);
      }
    } else {
      console.warn(`  -> CẢNH BÁO: Không tìm thấy classId phù hợp cho mã ${targetClassCode}`);
    }

    updateResults.push({
      personID: p.personID,
      name: p.name,
      oldAliasID: p.aliasID,
      newAliasID,
      departmentID,
      aliasUpdated,
      deptLocked,
      localSynced,
      note,
    });
  }

  // 4. KIỂM CHỨNG LẠI 100% TRÊN HANET CLOUD
  console.log('\n========================================================================');
  console.log('[3/4] ĐANG KIỂM CHỨNG LẠI DỮ LIỆU TỪ HANET CLOUD SAU KHI CẬP NHẬT...');
  console.log('========================================================================');

  await delay(1000);
  const verifyRes = await callHanetApi('/person/getListByPlace', {
    token,
    placeID: placeId,
  });

  const verifiedPersons: any[] = verifyRes.data || [];
  let allAliasValid = true;
  let allDeptsIntact = true;

  console.log('\n--- BẢNG XÁC MINH CHI TIẾT TRÊN HANET CLOUD ---');
  verifiedPersons.forEach((vp, idx) => {
    const isLenValid = vp.aliasID.length <= 9;
    const hasDept = vp.departmentID && vp.departmentID > 0;

    if (!isLenValid) allAliasValid = false;
    if (!hasDept) allDeptsIntact = false;

    console.log(
      `${idx + 1}. [${vp.personID}] ${vp.name.padEnd(35)} | Alias: ${vp.aliasID.padEnd(10)} (Dài: ${vp.aliasID.length} <= 9: ${isLenValid ? 'OK' : 'FAIL'}) | Dept: ${vp.departmentID} (${hasDept ? 'OK' : 'MẤT PHÒNG BAN!'})`
    );
  });

  // 5. Kiểm tra Local Postgres
  console.log('\n[4/4] Kiểm tra số lượng bản ghi đã đồng bộ trong Database Local...');
  const localCountRes = await pool.query(
    "SELECT c.code, COUNT(s.id)::int as count FROM students s JOIN classes c ON c.id = s.class_id WHERE s.status = 'success' GROUP BY c.code ORDER BY c.code"
  );
  console.table(localCountRes.rows);

  console.log('\n========================================================================');
  console.log('KẾT QUẢ TỔNG KẾT:');
  console.log(`- Tổng nhân sự xử lý: ${persons.length}`);
  console.log(`- 100% AliasID <= 9 ký tự (Loại bỏ tiền tố thừa): ${allAliasValid ? 'ĐẠT (PASS)' : 'KHÔNG ĐẠT'}`);
  console.log(`- 100% Bảo toàn phòng ban (DepartmentID > 0): ${allDeptsIntact ? 'ĐẠT (PASS)' : 'KHÔNG ĐẠT'}`);
  console.log('========================================================================');

  await pool.end();
}

main().catch((err) => {
  console.error('Lỗi thực thi:', err);
  pool.end().finally(() => process.exit(1));
});
