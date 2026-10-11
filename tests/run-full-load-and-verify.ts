import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { runLoadTest } from './load-test-concurrent.js';
import {
  StudentRepository,
  createDbPool,
  closeDbPool,
  createRedisClient,
  closeRedisClient,
} from '@thanh-giuse/shared-infra';

const dbUrl = 'postgresql://postgres_user:super_secure_postgres_password_change_me@localhost:5432/thanh_giuse_db';
const redisUrl = 'redis://:super_secure_redis_password_change_me@localhost:6379/0';
const NGINX_BASE = 'http://localhost:8090';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDockerStats(): Array<{ name: string; cpu: string; mem: string; memPerc: string }> {
  try {
    const raw = execSync(
      'docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}"',
      { encoding: 'utf-8' }
    );
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, cpu, mem, memPerc] = line.split('|');
        return { name, cpu, mem, memPerc };
      });
  } catch {
    return [];
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('   BƯỚC 1: LOAD TEST ĐỒNG THỜI (25 REQUESTS) & GIÁM SÁT TÀI NGUYÊN');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const pool = createDbPool({ connectionString: dbUrl });
  const redis = createRedisClient({ url: redisUrl });
  const studentRepo = new StudentRepository(pool);

  // 1. Chuẩn bị database, mock server, redis và uploads
  console.log('[CHUẨN BỊ] Reset mock server và đặt trạng thái 25 học sinh (ID 1..25) về "empty"...');
  await fetch('http://localhost:4000/mock/reset', { method: 'DELETE' });

  // Xóa sạch thư mục tmp-faces trước khi bắt đầu
  const tmpFacesDir = path.resolve('uploads/tmp-faces');
  if (fs.existsSync(tmpFacesDir)) {
    for (const f of fs.readdirSync(tmpFacesDir)) {
      if (!f.startsWith('.')) fs.unlinkSync(path.join(tmpFacesDir, f));
    }
  }

  await pool.query(`
    UPDATE students 
    SET status = 'empty', local_image_path = NULL, person_id = NULL, face_url = NULL, 
        last_error_code = NULL, last_error_message = NULL, retry_count = 0
    WHERE id BETWEEN 1 AND 25
  `);
  // Xóa sạch rate limiter và job trong redis
  await redis.flushdb();

  // Baseline docker stats
  console.log('\n[BASELINE STATS TRƯỚC KHI TẢI]');
  const baselineStats = getDockerStats();
  console.table(baselineStats);

  // 2. Kích hoạt Load Test 25 concurrent requests
  console.log('\n>>> KÍCH HOẠT 25 CONCURRENT REQUESTS TẢI ẢNH...');
  const loadResult = await runLoadTest();

  // 3. Giám sát Worker bốc job tuần tự (Concurrency = 1) và lấy mẫu docker stats
  console.log('\n[GIÁM SÁT TIẾN ĐỘ WORKER XỬ LÝ HÀNG ĐỢI TUẦN TỰ (CONCURRENCY: 1)]');
  const statsSamples: Array<{
    timestamp: string;
    completedCount: number;
    workerMem: string;
    apiMem: string;
    totalMemMb: number;
  }> = [];

  let isAllCompleted = false;
  const maxWaitSec = 180; // tối đa 3 phút
  const startTime = Date.now();

  while ((Date.now() - startTime) / 1000 < maxWaitSec) {
    await sleep(1500);

    const stats = getDockerStats();
    const workerStat = stats.find((s) => s.name === 'thanh_giuse_worker');
    const apiStat = stats.find((s) => s.name === 'thanh_giuse_api');

    // Đếm số học sinh đã hoàn tất
    const countRes = await pool.query(
      "SELECT count(*) FROM students WHERE id BETWEEN 1 AND 25 AND status = 'success'"
    );
    const completedCount = parseInt(countRes.rows[0].count, 10);

    // Tính tổng RAM 6 container
    let totalMemMb = 0;
    for (const s of stats) {
      const match = s.mem.match(/^([0-9.]+)(MiB|GiB|KiB)/);
      if (match) {
        const val = parseFloat(match[1]);
        const unit = match[2];
        if (unit === 'GiB') totalMemMb += val * 1024;
        else if (unit === 'MiB') totalMemMb += val;
        else if (unit === 'KiB') totalMemMb += val / 1024;
      }
    }

    const sample = {
      timestamp: new Date().toLocaleTimeString(),
      completedCount,
      workerMem: workerStat ? workerStat.mem : 'N/A',
      apiMem: apiStat ? apiStat.mem : 'N/A',
      totalMemMb: Math.round(totalMemMb * 100) / 100,
    };
    statsSamples.push(sample);

    console.log(
      `[${sample.timestamp}] Hoàn tất: ${completedCount}/25 | Worker RAM: ${sample.workerMem} | API RAM: ${sample.apiMem} | Tổng 6 Container RAM: ${sample.totalMemMb} MiB`
    );

    if (completedCount === 25) {
      isAllCompleted = true;
      break;
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n-> Hàng đợi đã xử lý xong trong ${durationSec}s! Hoàn tất ${isAllCompleted ? '25/25' : 'CHƯA ĐỦ'} học sinh.`);

  // 4. Kiểm tra tính toàn vẹn thư mục uploads/tmp-faces/
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('   BƯỚC 2: XÁC NHẬN TÍNH TOÀN VẸN THƯ MỤC uploads/tmp-faces/');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const tmpFacesDirInHost = path.resolve('uploads/tmp-faces');
  let leftoverFiles: string[] = [];
  if (fs.existsSync(tmpFacesDirInHost)) {
    leftoverFiles = fs.readdirSync(tmpFacesDirInHost).filter((f) => !f.startsWith('.'));
  }
  console.log(`- Số file tạm còn lại trong uploads/tmp-faces/: ${leftoverFiles.length}`);
  if (leftoverFiles.length > 0) {
    console.warn(`  Cảnh báo file tồn đọng:`, leftoverFiles);
  } else {
    console.log('  ✔ Toàn bộ file tạm sau khi nộp HANET thành công đã được dọn dẹp sạch sẽ!');
  }

  // 5. Kiểm tra giao diện tĩnh Frontend qua Nginx (http://localhost:8090/)
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('   BƯỚC 3: KIỂM TRA PHỤC VỤ FRONTEND TĨNH & API QUA NGINX (PORT 8090)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // A. Kiểm tra tải index.html SPA
  const frontendHtmlRes = await fetch(`${NGINX_BASE}/`);
  const frontendHtml = await frontendHtmlRes.text();
  const hasForm = frontendHtml.includes('id="studentSelect"') && frontendHtml.includes('id="submitBtn"');
  console.log(`- GET / (SPA HTML): HTTP ${frontendHtmlRes.status} | Giao diện hợp lệ: ${hasForm ? 'ĐẠT ✔' : 'LỖI ✘'}`);

  // B. Kiểm tra API GET /api/classes/1/students qua Nginx
  const studentsApiRes = await fetch(`${NGINX_BASE}/api/classes/1/students`);
  const studentsApiJson = (await studentsApiRes.json()) as any[];
  console.log(`- GET /api/classes/1/students: HTTP ${studentsApiRes.status} | Số học sinh trả về: ${studentsApiJson.length}`);

  const successStudents = studentsApiJson.filter((s) => s.status === 'success');
  console.log(`- Số học sinh có trạng thái 'success' (sẽ tự động disabled trên dropdown): ${successStudents.length}`);

  // In ra bảng tổng kết tiêu chuẩn nghiệm thu
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('   BẢNG ĐỐI CHIẾU TIÊU CHUẨN NGHIỆM THU (PASS CRITERIA)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const maxWorkerMem = Math.max(
    ...statsSamples.map((s) => {
      const match = s.workerMem.match(/^([0-9.]+)/);
      return match ? parseFloat(match[1]) : 0;
    })
  );
  const maxTotalMem = Math.max(...statsSamples.map((s) => s.totalMemMb));

  console.log(`1. API 200 OK Enqueue trong vòng < 2 giây: ${loadResult.avgDuration < 2000 ? 'ĐẠT ✔' : 'KHÔNG ĐẠT ✘'} (TB: ${loadResult.avgDuration}ms, Tối đa: ${loadResult.maxDuration}ms)`);
  console.log(`2. Worker RAM duy trì <= 150 MB (thực tế max ${maxWorkerMem} MiB): ${maxWorkerMem <= 150 ? 'ĐẠT ✔' : 'KHÔNG ĐẠT ✘'}`);
  console.log(`3. Tổng RAM 6 container duy trì < 800 MB (thực tế max ${maxTotalMem} MiB): ${maxTotalMem < 800 ? 'ĐẠT ✔' : 'KHÔNG ĐẠT ✘'}`);
  console.log(`4. Dọn dẹp hoàn toàn tmp-faces: ${leftoverFiles.length === 0 ? 'ĐẠT ✔' : 'KHÔNG ĐẠT ✘'}`);
  console.log(`5. Frontend Nginx nạp đúng danh sách học sinh: ${studentsApiJson.length >= 25 ? 'ĐẠT ✔' : 'KHÔNG ĐẠT ✘'}`);

  await closeDbPool(pool);
  await closeRedisClient(redis);
}

main().catch((err) => {
  console.error('Lỗi khi chạy kiểm thử:', err);
  process.exit(1);
});
