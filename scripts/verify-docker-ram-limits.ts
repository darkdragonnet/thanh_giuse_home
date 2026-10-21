import fs from 'node:fs';
import path from 'node:path';

interface ServiceMemoryCheck {
  service: string;
  expectedLimitMB: number;
  actualLimitMB?: number;
  expectedHeapMB?: number;
  actualHeapMB?: number;
  stopGracePeriod?: string;
  expectedStopGracePeriod?: string;
  passed: boolean;
  errors: string[];
}

const TOTAL_RAM_BUDGET_MB = 2112; // Principle I: aggregate sum <= 2,112 MB
const HOST_RAM_MB = 3072; // VPS 3.0 GB RAM
const MIN_HOST_HEADROOM_MB = 960; // 3072 - 2112 = 960 MB

export function verifyDockerRamLimits(composePath: string): {
  success: boolean;
  totalLimitMB: number;
  headroomMB: number;
  checks: ServiceMemoryCheck[];
} {
  if (!fs.existsSync(composePath)) {
    throw new Error(`File docker-compose không tồn tại tại: ${composePath}`);
  }

  const content = fs.readFileSync(composePath, 'utf-8');

  // Parse từng block service
  const serviceConfigs: Record<string, { expectedLimit: number; expectedHeap?: number; expectedStopGrace?: string }> = {
    app_proxy: { expectedLimit: 128 },
    app_postgres: { expectedLimit: 512 },
    app_redis: { expectedLimit: 192 },
    app_api: { expectedLimit: 512, expectedHeap: 384 },
    app_worker: { expectedLimit: 768, expectedHeap: 512, expectedStopGrace: '150s' },
  };

  const checks: ServiceMemoryCheck[] = [];
  let totalLimitMB = 0;

  for (const [serviceName, expected] of Object.entries(serviceConfigs)) {
    const check: ServiceMemoryCheck = {
      service: serviceName,
      expectedLimitMB: expected.expectedLimit,
      expectedHeapMB: expected.expectedHeap,
      expectedStopGracePeriod: expected.expectedStopGrace,
      passed: true,
      errors: [],
    };

    // Tìm block service
    const serviceRegex = new RegExp(`^\\s{2}${serviceName}:[\\s\\S]*?(?=^\\s{2}[a-zA-Z0-9_-]+:|\\Z)`, 'm');
    const match = content.match(serviceRegex);

    if (!match) {
      check.passed = false;
      check.errors.push(`Không tìm thấy định nghĩa service ${serviceName}`);
      checks.push(check);
      continue;
    }

    const serviceBlock = match[0];

    // Trích xuất memory limit
    const memMatch = serviceBlock.match(/memory:\s*([0-9]+)\s*([MGKmgk]?)/i);
    if (memMatch) {
      const val = parseInt(memMatch[1], 10);
      const unit = (memMatch[2] || 'M').toUpperCase();
      let memMB = val;
      if (unit === 'G') memMB = val * 1024;
      check.actualLimitMB = memMB;
      totalLimitMB += memMB;

      if (memMB !== expected.expectedLimit) {
        check.passed = false;
        check.errors.push(`RAM Limit ${memMB}MB không khớp chuẩn yêu cầu ${expected.expectedLimit}MB`);
      }
    } else {
      check.passed = false;
      check.errors.push(`Không tìm thấy cấu hình deploy.resources.limits.memory`);
    }

    // Trích xuất heap cap nếu có yêu cầu
    if (expected.expectedHeap) {
      const heapMatch = serviceBlock.match(/--max-old-space-size=([0-9]+)/);
      if (heapMatch) {
        const heapVal = parseInt(heapMatch[1], 10);
        check.actualHeapMB = heapVal;
        if (heapVal !== expected.expectedHeap) {
          check.passed = false;
          check.errors.push(`Heap cap ${heapVal}MB không khớp chuẩn yêu cầu ${expected.expectedHeap}MB`);
        }
      } else {
        check.passed = false;
        check.errors.push(`Thiếu cấu hình NODE_OPTIONS="--max-old-space-size=${expected.expectedHeap}"`);
      }
    }

    // Trích xuất stop_grace_period nếu có yêu cầu
    if (expected.expectedStopGrace) {
      const graceMatch = serviceBlock.match(/stop_grace_period:\s*([0-9]+s?)/);
      if (graceMatch) {
        check.stopGracePeriod = graceMatch[1];
        if (graceMatch[1] !== expected.expectedStopGrace) {
          check.passed = false;
          check.errors.push(`stop_grace_period ${graceMatch[1]} không khớp ${expected.expectedStopGrace}`);
        }
      } else {
        check.passed = false;
        check.errors.push(`Thiếu cấu hình stop_grace_period: ${expected.expectedStopGrace}`);
      }
    }

    checks.push(check);
  }

  const headroomMB = HOST_RAM_MB - totalLimitMB;
  const isBudgetPassed = totalLimitMB <= TOTAL_RAM_BUDGET_MB && headroomMB >= MIN_HOST_HEADROOM_MB;
  const isAllServicesPassed = checks.every((c) => c.passed);

  return {
    success: isBudgetPassed && isAllServicesPassed,
    totalLimitMB,
    headroomMB,
    checks,
  };
}

// Chạy trực tiếp nếu file được thực thi
const composeFile = path.resolve(process.cwd(), 'docker/docker-compose.yml');
console.log('═════════════════════════════════════════════════════════════════');
console.log('KIỂM CHỨNG T003: DOCKER RAM LIMITS & HEAP MATRIX (PRINCIPLE I)');
console.log(`Đường dẫn compose: ${composeFile}`);
console.log('═════════════════════════════════════════════════════════════════');

const result = verifyDockerRamLimits(composeFile);

for (const c of result.checks) {
  const status = c.passed ? '✓ ĐẠT' : '✗ LỆCH';
  const heapInfo = c.expectedHeapMB ? ` | Heap: ${c.actualHeapMB ?? 'N/A'}/${c.expectedHeapMB}MB` : '';
  const graceInfo = c.expectedStopGracePeriod ? ` | Grace: ${c.stopGracePeriod ?? 'N/A'}` : '';
  console.log(`[${status}] Service: ${c.service.padEnd(14)} | RAM: ${c.actualLimitMB ?? 'N/A'}/${c.expectedLimitMB}MB${heapInfo}${graceInfo}`);
  if (!c.passed) {
    for (const err of c.errors) {
      console.log(`       -> Lỗi: ${err}`);
    }
  }
}

console.log('-----------------------------------------------------------------');
console.log(`Tổng RAM Containers: ${result.totalLimitMB} MB / Trần tối đa: ${TOTAL_RAM_BUDGET_MB} MB`);
console.log(`Headroom OS/Kernel : ${result.headroomMB} MB / Tối thiểu : ${MIN_HOST_HEADROOM_MB} MB`);
console.log('-----------------------------------------------------------------');

if (result.success) {
  console.log('===> KẾT LUẬN: ĐẠT TOÀN BỘ CHỈ TIÊU BẢO VỆ TÀI NGUYÊN (GATE PASS)');
  process.exit(0);
} else {
  console.error('===> KẾT LUẬN: THẤT BẠI - CÓ ĐIỂM LỆCH VƯỢT TRẦN HOẶC THIẾU CẤU HÌNH');
  process.exit(1);
}
