import { Pool } from 'pg';
import { generateStudentQrToken } from '@thanh-giuse/shared-infra';

export interface CloudPersonSyncItem {
  personID: string;
  aliasID: string;
  name: string;
  avatar?: string;
  title?: string;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function syncCloudPersonsToStudentsBatch(
  pool: Pool,
  cloudPersons: CloudPersonSyncItem[],
  batchSize = 100,
  onProgress?: (percent: number) => Promise<void>
): Promise<{ totalSynced: number; conflictsCount: number }> {
  // 1. Tải bảng map mã lớp [PREFIX -> ID] từ DB
  const classRes = await pool.query('SELECT id, code FROM classes');
  const classMap = new Map<string, number>(
    classRes.rows.map((r: { id: number; code: string }) => [r.code.trim().toUpperCase(), r.id])
  );

  const chunks = chunkArray(cloudPersons, batchSize);
  let totalSynced = 0;
  let conflictsCount = 0;

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const classIds: (number | null)[] = [];
      const names: string[] = [];
      const aliasIds: string[] = [];
      const personIds: string[] = [];
      const faceUrls: string[] = [];
      const statuses: string[] = [];
      const qrTokens: string[] = [];

      for (const p of chunk) {
        if (!p.aliasID) continue;

        // Trích xuất prefix (VD: 'GLV_0001' -> 'GLV')
        const prefix = p.aliasID.split('_')[0]?.trim().toUpperCase() || '';
        const mappedClassId = classMap.get(prefix) || null;

        // Nếu không map được tiền tố -> đưa vào hàng chờ duyệt thủ công
        const initialStatus = mappedClassId ? 'success' : 'conflict_pending_review';

        classIds.push(mappedClassId);
        names.push(p.name || '');
        aliasIds.push(p.aliasID);
        personIds.push(p.personID || '');
        faceUrls.push(p.avatar || '');
        statuses.push(initialStatus);
        qrTokens.push(generateStudentQrToken());

        if (!mappedClassId) {
          conflictsCount++;
          await client.query(
            `INSERT INTO sync_conflicts (
              alias_id, cloud_person_id, cloud_alias_id, cloud_name, cloud_face_url, conflict_type, status
            ) VALUES ($1, $2, $3, $4, $5, 'UNMAPPED_CLASS_PREFIX', 'pending_review')
            ON CONFLICT DO NOTHING;`,
            [p.aliasID, p.personID, p.aliasID, p.name, p.avatar || '']
          );
        }
      }

      // 2. Thực thi Bulk Upsert với UNNEST
      if (aliasIds.length > 0) {
        const bulkQuery = `
          INSERT INTO students (
            class_id, name, alias_id, person_id, face_url, status, retry_count, last_error_code, last_error_message, updated_at, qr_token
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
            NOW(),
            u.qr_token
          FROM UNNEST(
            $1::int[],
            $2::text[],
            $3::text[],
            $4::text[],
            $5::text[],
            $6::text[],
            $7::text[]
          ) AS u(class_id, name, alias_id, person_id, face_url, status, qr_token)
          ON CONFLICT (alias_id) DO UPDATE SET
            person_id = EXCLUDED.person_id,
            face_url = EXCLUDED.face_url,
            status = CASE 
              WHEN students.status = 'conflict_pending_review' THEN students.status 
              ELSE EXCLUDED.status 
            END,
            class_id = COALESCE(students.class_id, EXCLUDED.class_id),
            name = CASE 
              WHEN students.name IS NOT NULL AND TRIM(students.name) <> '' THEN students.name
              ELSE EXCLUDED.name 
            END,
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = NOW();
        `;

        await client.query(bulkQuery, [classIds, names, aliasIds, personIds, faceUrls, statuses, qrTokens]);
        totalSynced += aliasIds.length;
      }

      await client.query('COMMIT');

      if (onProgress) {
        const percent = Math.round(((chunkIdx + 1) / chunks.length) * 100);
        await onProgress(percent);
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return { totalSynced, conflictsCount };
}
