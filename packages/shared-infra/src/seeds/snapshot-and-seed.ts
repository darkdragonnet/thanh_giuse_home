import type { Pool, PoolClient } from 'pg';
import {
  generateQrToken,
  normalizeVietnameseStudentName,
  parseAndClassifyAlias,
} from '@thanh-giuse/shared-types';
import { REGEX_VALID_STUDENT_ID } from '../validators/identifier.validator.js';


export interface ExcelSeedStudentInput {
  classCode: string;
  name: string;
  qrToken?: string | undefined;
}

export interface CloudSnapshotFaceInput {
  personID: string;
  aliasID: string;
  name: string;
  faceUrl?: string | null | undefined;
  classCode?: string | undefined;
}

export interface Stage1SeedSummary {
  totalExcelInput: number;
  totalCloudSnapshotInput: number;
  classesCreatedCount: number;
  insertedStudentsCount: number;
  skippedDuplicateCount: number;
  matchedFromExcelCount: number;
  autoInsertedFromCloudCount: number;
  emptyNewStudentsCount: number;
  transactionDurationMs: number;
}

interface PreparedExcelRow {
  classCode: string;
  name: string;
  normalizedName: string;
  qrToken: string;
}

interface PreparedCloudRow {
  personId: string;
  rawAlias: string;
  fullName: string;
  normalizedName: string;
  faceUrl: string | null;
  classCode: string;
  fallbackQrToken: string;
}

/**
 * Giai đoạn 1: Khởi tạo Offline 100% trong DB & RAM (Set-Based SQL Mapping + Auto-INSERT Phương án 1)
 * - Nạp toàn bộ dữ liệu Excel (1.200 em) và Cloud Snapshot (140 em, nếu có) vào bộ nhớ RAM trước khi mở Transaction.
 * - Nếu không truyền `cloudSnapshotFaces` (hoặc mảng rỗng), hệ thống bảo toàn bảng `staging_cloud_faces` hiện có trong DB (Offline 100%).
 * - Hỗ trợ Idempotent Skip: Tự động bỏ qua học sinh đã tồn tại cùng `(class_id, normalized_name)` và bảo toàn `qr_token` cũ.
 * - Mở Transaction `BEGIN ISOLATION LEVEL READ COMMITTED` và thực thi Batch UNNEST + Set-Based SQL trong < 100ms.
 * - Tự động ROLLBACK nếu có bất kỳ lỗi ràng buộc hoặc cú pháp nào.
 */
export async function executeStage1SnapshotAndSeed(
  pool: Pool,
  excelStudents: ExcelSeedStudentInput[],
  cloudSnapshotFaces: CloudSnapshotFaceInput[] = []
): Promise<Stage1SeedSummary> {
  // ============================================================================
  // BƯỚC 0: CHUẨN BỊ & KHỬ TRÙNG LẶP DỮ LIỆU TRONG RAM TRƯỚC KHI MỞ TRANSACTION
  // ============================================================================
  const usedQrTokens = new Set<string>();
  const allocateUniqueQrToken = (preferred?: string): string => {
    let token = preferred && preferred.length === 16 ? preferred : generateQrToken();
    while (usedQrTokens.has(token)) {
      token = generateQrToken();
    }
    usedQrTokens.add(token);
    return token;
  };

  const seenExcelKeys = new Set<string>();
  const preparedExcel: PreparedExcelRow[] = [];
  let inMemoryDuplicateCount = 0;

  for (const row of excelStudents) {
    const cleanName = row.name.trim().replace(/\s+/g, ' ');
    const classCode = row.classCode.trim().toUpperCase();
    const normalizedName = normalizeVietnameseStudentName(cleanName);
    if (!classCode || !normalizedName) continue;

    const dedupKey = `${classCode}::${normalizedName}`;
    if (seenExcelKeys.has(dedupKey)) {
      inMemoryDuplicateCount++;
      continue;
    }
    seenExcelKeys.add(dedupKey);

    preparedExcel.push({
      classCode,
      name: cleanName,
      normalizedName,
      qrToken: allocateUniqueQrToken(row.qrToken),
    });
  }

  const preparedCloud: PreparedCloudRow[] = cloudSnapshotFaces.map((face) => {
    const cleanName = face.name.trim().replace(/\s+/g, ' ');
    const rawAlias = face.aliasID.trim().toUpperCase();
    let resolvedClassCode = face.classCode?.trim().toUpperCase() || '';

    if (!resolvedClassCode) {
      if (REGEX_VALID_STUDENT_ID.test(rawAlias)) {
        resolvedClassCode = rawAlias.slice(0, 4).toUpperCase();
      } else {
        const parsed = parseAndClassifyAlias({
          personID: face.personID,
          name: cleanName,
          aliasID: rawAlias,
        });
        resolvedClassCode = (parsed.maLopChuanHoa || 'TS1A').toUpperCase();
      }
    }

    return {
      personId: String(face.personID).trim(),
      rawAlias,
      fullName: cleanName,
      normalizedName: normalizeVietnameseStudentName(cleanName),
      faceUrl: face.faceUrl ?? null,
      classCode: resolvedClassCode,
      fallbackQrToken: allocateUniqueQrToken(),
    };
  });

  // Tập hợp danh sách mã lớp cần đảm bảo tồn tại
  const allClassCodes = Array.from(
    new Set([
      ...preparedExcel.map((e) => e.classCode),
      ...preparedCloud.map((c) => c.classCode),
    ].filter(Boolean))
  );

  // ============================================================================
  // BƯỚC 1..5: THỰC THI TRANSACTION CÔ LẬP READ COMMITTED (< 100ms)
  // ============================================================================
  const client: PoolClient = await pool.connect();
  const txStart = performance.now();

  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');

    // 1. Đảm bảo toàn bộ classes tồn tại bằng UNNEST
    let classesCreatedCount = 0;
    if (allClassCodes.length > 0) {
      const classNames = allClassCodes.map((code) => `Lớp ${code}`);
      const classTokens = allClassCodes.map((code) => `PIN_${code}`);
      const clsInsertRes = await client.query(
        `INSERT INTO classes (code, name, token, is_locked)
         SELECT u.code, u.name, u.token, FALSE
         FROM UNNEST($1::varchar[], $2::varchar[], $3::varchar[]) AS u(code, name, token)
         ON CONFLICT (code) DO NOTHING`,
        [allClassCodes, classNames, classTokens]
      );
      classesCreatedCount = clsInsertRes.rowCount ?? 0;
    }

    const classesRes = await client.query<{ id: number; code: string }>(
      'SELECT id, code FROM classes'
    );
    const classIdByCode = new Map<string, number>();
    for (const cls of classesRes.rows) {
      classIdByCode.set(cls.code.toUpperCase(), cls.id);
    }

    // 2. Xử lý bảng staging_cloud_faces:
    // - Nếu có truyền mảng cloudSnapshotFaces mới: TRUNCATE và nạp mới bằng UNNEST.
    // - Nếu không truyền (Offline 100% từ Web UI): Bảo toàn dữ liệu hiện có trong staging_cloud_faces
    //   và cập nhật bổ sung target_class_id cho các dòng chưa gán lớp nếu lớp mới vừa được tạo.
    if (preparedCloud.length > 0) {
      await client.query('TRUNCATE TABLE staging_cloud_faces');

      const stgPersonIds: string[] = [];
      const stgRawAliases: string[] = [];
      const stgFullNames: string[] = [];
      const stgNormalizedNames: string[] = [];
      const stgFaceUrls: (string | null)[] = [];
      const stgTargetClassIds: (number | null)[] = [];

      for (const c of preparedCloud) {
        stgPersonIds.push(c.personId);
        stgRawAliases.push(c.rawAlias);
        stgFullNames.push(c.fullName);
        stgNormalizedNames.push(c.normalizedName);
        stgFaceUrls.push(c.faceUrl);
        stgTargetClassIds.push(classIdByCode.get(c.classCode) ?? null);
      }

      await client.query(
        `INSERT INTO staging_cloud_faces (
           person_id, raw_alias, full_name, normalized_name, face_url, target_class_id, is_matched
         )
         SELECT
           u.person_id, u.raw_alias, u.full_name, u.normalized_name, u.face_url, u.target_class_id, FALSE
         FROM UNNEST(
           $1::varchar[],
           $2::varchar[],
           $3::varchar[],
           $4::varchar[],
           $5::text[],
           $6::int[]
         ) AS u(person_id, raw_alias, full_name, normalized_name, face_url, target_class_id)
         ON CONFLICT (person_id) DO UPDATE
         SET raw_alias = EXCLUDED.raw_alias,
             full_name = EXCLUDED.full_name,
             normalized_name = EXCLUDED.normalized_name,
             face_url = EXCLUDED.face_url,
             target_class_id = EXCLUDED.target_class_id,
             is_matched = FALSE`,
        [
          stgPersonIds,
          stgRawAliases,
          stgFullNames,
          stgNormalizedNames,
          stgFaceUrls,
          stgTargetClassIds,
        ]
      );
    } else {
      await client.query(`
        UPDATE staging_cloud_faces stg
        SET target_class_id = c.id
        FROM classes c
        WHERE stg.target_class_id IS NULL
          AND UPPER(SUBSTRING(stg.raw_alias FROM 1 FOR 4)) = c.code
      `);
    }

    // 3. Idempotent Skip & Batch INSERT danh sách học sinh từ Excel (status = 'empty', alias_id = NULL, qr_token cố định)
    let insertedStudentsCount = 0;
    let dbDuplicateCount = 0;

    if (preparedExcel.length > 0) {
      const targetClassIds = Array.from(
        new Set(
          preparedExcel
            .map((e) => classIdByCode.get(e.classCode))
            .filter((cid): cid is number => typeof cid === 'number')
        )
      );

      const existingStudentsRes = await client.query<{
        class_id: number;
        normalized_name: string;
      }>(
        `SELECT class_id, normalized_name
         FROM students
         WHERE class_id = ANY($1::int[])`,
        [targetClassIds]
      );

      const existingPairs = new Set<string>();
      for (const row of existingStudentsRes.rows) {
        existingPairs.add(`${row.class_id}::${row.normalized_name}`);
      }

      const stdClassIds: number[] = [];
      const stdNames: string[] = [];
      const stdNormalizedNames: string[] = [];
      const stdQrTokens: string[] = [];

      for (const e of preparedExcel) {
        const cid = classIdByCode.get(e.classCode);
        if (!cid) {
          throw new Error(`Không tìm thấy class_id cho mã lớp: ${e.classCode}`);
        }
        if (existingPairs.has(`${cid}::${e.normalizedName}`)) {
          dbDuplicateCount++;
          continue;
        }
        stdClassIds.push(cid);
        stdNames.push(e.name);
        stdNormalizedNames.push(e.normalizedName);
        stdQrTokens.push(e.qrToken);
      }

      if (stdClassIds.length > 0) {
        await client.query(
          `INSERT INTO students (
             class_id, name, normalized_name, alias_id, qr_token, status, cloud_alias_synced
           )
           SELECT
             u.class_id, u.name, u.normalized_name, NULL, u.qr_token, 'empty', FALSE
           FROM UNNEST(
             $1::int[],
             $2::varchar[],
             $3::varchar[],
             $4::varchar[]
           ) AS u(class_id, name, normalized_name, qr_token)`,
          [stdClassIds, stdNames, stdNormalizedNames, stdQrTokens]
        );
        insertedStudentsCount = stdClassIds.length;
      }
    }

    const skippedDuplicateCount = inMemoryDuplicateCount + dbDuplicateCount;

    // 4. Set-Based SQL Mapping: Khớp nối 1-1 an toàn theo (class_id, normalized_name)
    // Chỉ tự động gán khi cả trong Excel và trong Cloud đều có duy nhất 1 học sinh trùng tên trong cùng 1 lớp
    const matchedUpdateRes = await client.query<{ student_id: number; person_id: string }>(`
      WITH unique_excel_students AS (
        SELECT MIN(id) AS student_id, class_id, normalized_name
        FROM students
        WHERE status = 'empty' AND person_id IS NULL
        GROUP BY class_id, normalized_name
        HAVING COUNT(*) = 1
      ),
      unique_staging_faces AS (
        SELECT MIN(person_id) AS person_id, target_class_id, normalized_name
        FROM staging_cloud_faces
        WHERE is_matched = FALSE AND target_class_id IS NOT NULL
        GROUP BY target_class_id, normalized_name
        HAVING COUNT(*) = 1
      ),
      matched_pairs AS (
        SELECT ues.student_id, stg.person_id, stg.raw_alias, stg.face_url
        FROM unique_excel_students ues
        INNER JOIN unique_staging_faces usf
          ON ues.class_id = usf.target_class_id
         AND ues.normalized_name = usf.normalized_name
        INNER JOIN staging_cloud_faces stg
          ON stg.person_id = usf.person_id
      ),
      updated_students AS (
        UPDATE students s
        SET person_id = mp.person_id,
            face_url = mp.face_url,
            alias_id = mp.raw_alias,
            status = 'success',
            cloud_alias_synced = TRUE,
            updated_at = NOW()
        FROM matched_pairs mp
        WHERE s.id = mp.student_id
        RETURNING s.id AS student_id, mp.person_id
      )
      UPDATE staging_cloud_faces stg
      SET is_matched = TRUE,
          matched_student_id = us.student_id
      FROM updated_students us
      WHERE stg.person_id = us.person_id
      RETURNING us.student_id, us.person_id
    `);

    const matchedFromExcelCount = matchedUpdateRes.rowCount ?? 0;

    // 5. Phương án 1 (Auto-INSERT): Tự động INSERT các học sinh có trên Cloud nhưng chưa có trong Excel
    let autoInsertedFromCloudCount = 0;
    const unmatchedCloudRes = await client.query<{
      person_id: string;
      raw_alias: string;
      full_name: string;
      normalized_name: string;
      face_url: string | null;
      target_class_id: number;
    }>(`
      SELECT person_id, raw_alias, full_name, normalized_name, face_url, target_class_id
      FROM staging_cloud_faces
      WHERE is_matched = FALSE
        AND target_class_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM students s WHERE s.person_id = staging_cloud_faces.person_id
        )
      ORDER BY person_id ASC
    `);

    if ((unmatchedCloudRes.rowCount ?? 0) > 0) {
      const insClassIds: number[] = [];
      const insNames: string[] = [];
      const insNormalizedNames: string[] = [];
      const insAliases: string[] = [];
      const insPersonIds: string[] = [];
      const insFaceUrls: (string | null)[] = [];
      const insQrTokens: string[] = [];

      const fallbackTokenByPersonId = new Map(
        preparedCloud.map((c) => [c.personId, c.fallbackQrToken])
      );

      for (const row of unmatchedCloudRes.rows) {
        insClassIds.push(row.target_class_id);
        insNames.push(row.full_name);
        insNormalizedNames.push(row.normalized_name);
        insAliases.push(row.raw_alias);
        insPersonIds.push(row.person_id);
        insFaceUrls.push(row.face_url);
        insQrTokens.push(fallbackTokenByPersonId.get(row.person_id) || allocateUniqueQrToken());
      }

      const autoInsertRes = await client.query<{ id: number; person_id: string }>(
        `WITH inserted AS (
           INSERT INTO students (
             class_id, name, normalized_name, alias_id, person_id, face_url, qr_token, status, cloud_alias_synced
           )
           SELECT
             u.class_id, u.name, u.normalized_name, u.alias_id, u.person_id, u.face_url, u.qr_token, 'success', TRUE
           FROM UNNEST(
             $1::int[],
             $2::varchar[],
             $3::varchar[],
             $4::varchar[],
             $5::varchar[],
             $6::text[],
             $7::varchar[]
           ) AS u(class_id, name, normalized_name, alias_id, person_id, face_url, qr_token)
           ON CONFLICT (person_id) DO NOTHING
           RETURNING id, person_id
         )
         UPDATE staging_cloud_faces stg
         SET is_matched = TRUE,
             matched_student_id = ins.id
         FROM inserted ins
         WHERE stg.person_id = ins.person_id
         RETURNING ins.id, ins.person_id`,
        [
          insClassIds,
          insNames,
          insNormalizedNames,
          insAliases,
          insPersonIds,
          insFaceUrls,
          insQrTokens,
        ]
      );

      autoInsertedFromCloudCount = autoInsertRes.rowCount ?? 0;
    }

    await client.query('COMMIT');
    const txDurationMs = Number((performance.now() - txStart).toFixed(2));

    const emptyNewStudentsCount = Math.max(0, insertedStudentsCount - matchedFromExcelCount);

    return {
      totalExcelInput: excelStudents.length,
      totalCloudSnapshotInput: preparedCloud.length,
      classesCreatedCount,
      insertedStudentsCount,
      skippedDuplicateCount,
      matchedFromExcelCount,
      autoInsertedFromCloudCount,
      emptyNewStudentsCount,
      transactionDurationMs: txDurationMs,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lưu/cập nhật danh sách khuôn mặt từ HANET Cloud vào bảng nháp staging_cloud_faces
 * để phục vụ đối soát Offline 100% trong Giai đoạn 1.
 */
export async function upsertStagingCloudFaces(
  pool: Pool,
  cloudFaces: CloudSnapshotFaceInput[]
): Promise<{ upsertedCount: number }> {
  if (!Array.isArray(cloudFaces) || cloudFaces.length === 0) {
    return { upsertedCount: 0 };
  }

  const classesRes = await pool.query<{ id: number; code: string }>(
    'SELECT id, code FROM classes'
  );
  const classIdByCode = new Map<string, number>();
  for (const cls of classesRes.rows) {
    classIdByCode.set(cls.code.toUpperCase(), cls.id);
  }

  const stgPersonIds: string[] = [];
  const stgRawAliases: string[] = [];
  const stgFullNames: string[] = [];
  const stgNormalizedNames: string[] = [];
  const stgFaceUrls: (string | null)[] = [];
  const stgTargetClassIds: (number | null)[] = [];

  for (const face of cloudFaces) {
    const cleanName = face.name.trim().replace(/\s+/g, ' ');
    const rawAlias = face.aliasID.trim().toUpperCase();
    let resolvedClassCode = face.classCode?.trim().toUpperCase() || '';

    if (!resolvedClassCode) {
      if (REGEX_VALID_STUDENT_ID.test(rawAlias)) {
        resolvedClassCode = rawAlias.slice(0, 4).toUpperCase();
      } else {
        const parsed = parseAndClassifyAlias({
          personID: face.personID,
          name: cleanName,
          aliasID: rawAlias,
        });
        resolvedClassCode = (parsed.maLopChuanHoa || 'TS1A').toUpperCase();
      }
    }

    stgPersonIds.push(String(face.personID).trim());
    stgRawAliases.push(rawAlias);
    stgFullNames.push(cleanName);
    stgNormalizedNames.push(normalizeVietnameseStudentName(cleanName));
    stgFaceUrls.push(face.faceUrl ?? null);
    stgTargetClassIds.push(classIdByCode.get(resolvedClassCode) ?? null);
  }

  const res = await pool.query(
    `INSERT INTO staging_cloud_faces (
       person_id, raw_alias, full_name, normalized_name, face_url, target_class_id, is_matched
     )
     SELECT
       u.person_id, u.raw_alias, u.full_name, u.normalized_name, u.face_url, u.target_class_id, FALSE
     FROM UNNEST(
       $1::varchar[],
       $2::varchar[],
       $3::varchar[],
       $4::varchar[],
       $5::text[],
       $6::int[]
     ) AS u(person_id, raw_alias, full_name, normalized_name, face_url, target_class_id)
     ON CONFLICT (person_id) DO UPDATE
     SET raw_alias = EXCLUDED.raw_alias,
         full_name = EXCLUDED.full_name,
         normalized_name = EXCLUDED.normalized_name,
         face_url = COALESCE(EXCLUDED.face_url, staging_cloud_faces.face_url),
         target_class_id = COALESCE(EXCLUDED.target_class_id, staging_cloud_faces.target_class_id)`,
    [
      stgPersonIds,
      stgRawAliases,
      stgFullNames,
      stgNormalizedNames,
      stgFaceUrls,
      stgTargetClassIds,
    ]
  );

  // Tự động đồng bộ bù face_url từ staging_cloud_faces sang bảng students cho các hồ sơ đã có person_id
  await pool.query(`
    UPDATE students s
    SET face_url = stg.face_url,
        updated_at = NOW()
    FROM staging_cloud_faces stg
    WHERE s.person_id = stg.person_id
      AND stg.face_url IS NOT NULL
      AND stg.face_url <> ''
      AND (s.face_url IS NULL OR s.face_url = '')
  `);

  return { upsertedCount: res.rowCount ?? 0 };
}

/**
 * Chính sách dọn dẹp bảng nháp sau 7 ngày (Bảo vệ ổ cứng SSD 20GB của VPS)
 */
export async function cleanupStagingCloudFaces(pool: Pool): Promise<{ truncated: boolean }> {
  await pool.query('TRUNCATE TABLE staging_cloud_faces');
  return { truncated: true };
}

