import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const { Pool } = pg;
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const rawDbUrl =
  process.env.DATABASE_URL ||
  'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const DB_URL = rawDbUrl.replace('@app_postgres:', '@localhost:').replace('@postgres:', '@localhost:');
const ADMIN_SECRET_TOKEN = process.env.ADMIN_SECRET_TOKEN || 'admin_secret_super_secure_token';

describe('Contract Test: GET /api/admin/requests Photo Display & URL Sanitization', () => {
  let pool: pg.Pool;
  const createdRequestIds: number[] = [];
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  let reqIdNormal: number;
  let reqIdPasswd: number;
  let reqIdTraversal: number;
  let reqIdEmptyPath: number;

  const normalFilename = `admin_req_TEST_normal_${suffix}.jpg`;
  const normalFullPath = `/app/uploads/${normalFilename}`;

  const traversalFilename = `x_${suffix}.jpg`;
  const traversalPath = `../../${traversalFilename}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });

    // 1. Yêu cầu chuẩn: image_path là đường dẫn filesystem đầy đủ trong /app/uploads/
    const resNormal = await pool.query(
      `INSERT INTO admin_requests (student_name, alias_id, image_path, status, note)
       VALUES ($1, $2, $3, 'new', $4)
       RETURNING id`,
      [`TEST_Student_Normal_${suffix}`, `TEST_ALIAS_NORM_${suffix}`, normalFullPath, `TEST_note_${suffix}`]
    );
    reqIdNormal = resNormal.rows[0].id;
    createdRequestIds.push(reqIdNormal);

    // 2. Yêu cầu có image_path lạ: /etc/passwd
    const resPasswd = await pool.query(
      `INSERT INTO admin_requests (student_name, alias_id, image_path, status, note)
       VALUES ($1, $2, $3, 'new', $4)
       RETURNING id`,
      [`TEST_Student_Passwd_${suffix}`, `TEST_ALIAS_PASSWD_${suffix}`, '/etc/passwd', `TEST_note_${suffix}`]
    );
    reqIdPasswd = resPasswd.rows[0].id;
    createdRequestIds.push(reqIdPasswd);

    // 3. Yêu cầu có path traversal: ../../x.jpg
    const resTraversal = await pool.query(
      `INSERT INTO admin_requests (student_name, alias_id, image_path, status, note)
       VALUES ($1, $2, $3, 'new', $4)
       RETURNING id`,
      [`TEST_Student_Traversal_${suffix}`, `TEST_ALIAS_TRAV_${suffix}`, traversalPath, `TEST_note_${suffix}`]
    );
    reqIdTraversal = resTraversal.rows[0].id;
    createdRequestIds.push(reqIdTraversal);

    // 4. Yêu cầu rỗng: image_path là chuỗi rỗng
    const resEmpty = await pool.query(
      `INSERT INTO admin_requests (student_name, alias_id, image_path, status, note)
       VALUES ($1, $2, $3, 'new', $4)
       RETURNING id`,
      [`TEST_Student_Empty_${suffix}`, `TEST_ALIAS_EMPTY_${suffix}`, '', `TEST_note_${suffix}`]
    );
    reqIdEmptyPath = resEmpty.rows[0].id;
    createdRequestIds.push(reqIdEmptyPath);
  });

  afterAll(async () => {
    try {
      if (createdRequestIds.length > 0) {
        await pool.query('DELETE FROM admin_requests WHERE id = ANY($1::int[])', [createdRequestIds]);
      }
      await pool.query(
        "DELETE FROM admin_requests WHERE student_name LIKE 'TEST_%' OR alias_id LIKE 'TEST_%' OR note LIKE 'TEST_%'"
      );
    } finally {
      await pool.end();
    }
  });

  it('1. GET /api/admin/requests trả image_url với /uploads/ + basename và KHÔNG lộ image_path thô', async () => {
    const res = await fetch(`${API_BASE}/api/admin/requests?page=1&limit=50`, {
      headers: {
        Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const items = Array.isArray(body.data) ? body.data : body.data.items;
    const itemNormal = items.find((item: any) => item.id === reqIdNormal);

    expect(itemNormal).toBeDefined();
    // Phải có trường image_url với format /uploads/<basename>
    expect(itemNormal.image_url).toBe(`/uploads/${normalFilename}`);
    // Tuyệt đối không chứa đường dẫn filesystem máy chủ (/app/...)
    expect(itemNormal.image_url).not.toContain('/app/');
    // Không còn trả image_path thô ra client
    expect(itemNormal).not.toHaveProperty('image_path');
  });

  it('2. Đường dẫn lạ (/etc/passwd, ../../x.jpg) chỉ lấy basename, không lộ thư mục gốc, không chứa ..', async () => {
    const res = await fetch(`${API_BASE}/api/admin/requests?page=1&limit=50`, {
      headers: {
        Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const items = Array.isArray(body.data) ? body.data : body.data.items;

    // Test case: /etc/passwd -> /uploads/passwd, không chứa /etc/ hay ..
    const itemPasswd = items.find((item: any) => item.id === reqIdPasswd);
    expect(itemPasswd).toBeDefined();
    expect(itemPasswd.image_url).toBe('/uploads/passwd');
    expect(itemPasswd.image_url).not.toContain('/etc/');
    expect(itemPasswd.image_url).not.toContain('..');
    expect(itemPasswd).not.toHaveProperty('image_path');

    // Test case: ../../x.jpg -> /uploads/x.jpg, không chứa ..
    const itemTrav = items.find((item: any) => item.id === reqIdTraversal);
    expect(itemTrav).toBeDefined();
    expect(itemTrav.image_url).toBe(`/uploads/${traversalFilename}`);
    expect(itemTrav.image_url).not.toContain('..');
    expect(itemTrav).not.toHaveProperty('image_path');
  });

  it('3. Yêu cầu không có image_path (rỗng hoặc null) → image_url = null, không crash', async () => {
    const res = await fetch(`${API_BASE}/api/admin/requests?page=1&limit=50`, {
      headers: {
        Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const items = Array.isArray(body.data) ? body.data : body.data.items;

    const itemEmpty = items.find((item: any) => item.id === reqIdEmptyPath);
    expect(itemEmpty).toBeDefined();
    expect(itemEmpty.image_url).toBeNull();
    expect(itemEmpty).not.toHaveProperty('image_path');
  });

  it('4. Toàn bộ response không chứa đường dẫn filesystem (/app/uploads hoặc /app/...)', async () => {
    const res = await fetch(`${API_BASE}/api/admin/requests?page=1&limit=50`, {
      headers: {
        Authorization: `Bearer ${ADMIN_SECRET_TOKEN}`,
      },
    });

    expect(res.status).toBe(200);
    const rawText = await res.text();

    // Dữ liệu TEST_ của chúng ta không được để lộ /app/uploads
    expect(rawText).not.toContain(normalFullPath);
    expect(rawText).not.toContain('/app/uploads/admin_req_TEST_');
  });
});
