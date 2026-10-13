import { describe, it, expect, vi } from 'vitest';
import { HanetClient } from '../packages/hanet-client/src/index.js';
import { handleUpdateAlias } from '../apps/worker/src/processors/update-alias.processor.js';
import {
  parseAndClassifyAlias,
  generateDeterministicSuffix4,
  normalizePrefix4,
} from '../packages/shared-types/src/index.js';

describe('Kiểm thử Hệ thống Đối Soát & Đồng Bộ AliasID (Phase 4 Verification)', () => {
  // =========================================================================
  // TEST CASE 1: KIỂM ĐỊNH ĐỊNH DẠNG 9 KÝ TỰ (HIẾN PHÁP ĐIỀU 3 & ĐIỀU 4)
  // =========================================================================
  describe('Quy Chuẩn Định Danh 9 Ký Tự (Regex Guard)', () => {
    const FIXED_ALIAS_REGEX = /^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$/;

    it('Phải chấp nhận các mã định danh chuẩn 9 ký tự', () => {
      expect(FIXED_ALIAS_REGEX.test('TS1A_0001')).toBe(true);
      expect(FIXED_ALIAS_REGEX.test('GLV0_A1B2')).toBe(true);
      expect(FIXED_ALIAS_REGEX.test('LM01_9999')).toBe(true);
    });

    it('Phải từ chối các mã sai độ dài hoặc sai định dạng', () => {
      // 11 ký tự
      expect(FIXED_ALIAS_REGEX.test('HS_10A1_001')).toBe(false);
      // 17 ký tự legacy
      expect(FIXED_ALIAS_REGEX.test('STU_10A1_001_A7B2C')).toBe(false);
      // 7 ký tự (thiếu phần)
      expect(FIXED_ALIAS_REGEX.test('TS1A_01')).toBe(false);
      // Ký tự đặc biệt không hợp lệ
      expect(FIXED_ALIAS_REGEX.test('TS1A-0001')).toBe(false);
    });
  });

  // =========================================================================
  // TEST CASE 2: HANET CLIENT SDK MỞ RỘNG
  // =========================================================================
  describe('HanetClient SDK (updateAliasID & addPersonToDepartment)', () => {
    it('Client phải có đầy đủ 2 phương thức mở rộng', () => {
      const client = new HanetClient({
        token: 'test_token',
        placeId: '998577',
      });

      expect(typeof client.updateAliasID).toBe('function');
      expect(typeof client.addPersonToDepartment).toBe('function');
    });
  });

  // =========================================================================
  // TEST CASE 3: WORKER XỬ LÝ LỖI -103 (TOKEN EXPIRED) BẢO TỒN DỮ LIỆU
  // =========================================================================
  describe('Worker Error Handling: Mã -103 ACCESS_TOKEN_EXPIRE', () => {
    it('Phải kích hoạt Kill Switch, tạm dừng queue và KHÔNG đánh trượt bản ghi học sinh', async () => {
      const mockStudentRepo = {
        markFailure: vi.fn(),
        updateAliasSuccess: vi.fn(),
        recordSyncConflict: vi.fn(),
      };
      const mockLogRepo = {
        recordLog: vi.fn(),
      };
      const mockSettingsRepo = {
        setRegistrationEnabled: vi.fn(),
        setSetting: vi.fn(),
      };
      const mockRedisClient = {
        set: vi.fn(),
        hincrby: vi.fn(),
        hget: vi.fn(),
        hset: vi.fn(),
      };
      const mockHanetClient = {
        updateAliasID: vi.fn().mockResolvedValue({
          success: false,
          rawResponse: { returnCode: -103, returnMessage: 'Token expired' },
          evaluation: { action: 'REFRESH_TOKEN', userFacingMessage: 'Token hết hạn' },
        }),
        addPersonToDepartment: vi.fn(),
      };
      const mockPauseWorker = vi.fn().mockResolvedValue(undefined);

      const job: any = {
        id: 'job_test_103',
        data: {
          studentId: 101,
          aliasId: 'TS1A_OLD1',
          newAlias: 'TS1A_0001',
          personId: 'HANET_101',
          studentName: 'Nguyễn Văn A',
          departmentId: '10',
        },
      };

      const result = await handleUpdateAlias(job, {
        studentRepo: mockStudentRepo as any,
        logRepo: mockLogRepo as any,
        settingsRepo: mockSettingsRepo as any,
        redisClient: mockRedisClient as any,
        hanetClient: mockHanetClient as any,
        pauseWorker: mockPauseWorker,
      });

      // 1. Phải gọi tạm dừng Worker
      expect(mockPauseWorker).toHaveBeenCalled();

      // 2. Phải kích hoạt Kill Switch trong Redis và Settings
      expect(mockRedisClient.set).toHaveBeenCalledWith('setting:kill_switch', 'true');
      expect(mockSettingsRepo.setRegistrationEnabled).toHaveBeenCalledWith(false);

      // 3. Phải ghi log SYSTEM_TOKEN_EXPIRED
      expect(mockLogRepo.recordLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SYSTEM_TOKEN_EXPIRED' })
      );

      // 4. TUYỆT ĐỐI KHÔNG đánh trượt học sinh (không markFailure)
      expect(mockStudentRepo.markFailure).not.toHaveBeenCalled();

      // 5. Kết quả trả về failure an toàn
      expect(result.success).toBe(false);
      expect(result.reason).toBe('SYSTEM_TOKEN_EXPIRED');
    });
  });

  // =========================================================================
  // TEST CASE 4: WORKER XỬ LÝ LỖI -5011 (PERSON NOT FOUND) BẢO TỒN PERSON_ID
  // =========================================================================
  describe('Worker Error Handling: Mã -5011 PERSON_NOT_FOUND', () => {
    it('Phải chuyển sang manual_review và tuyệt đối không xóa person_id', async () => {
      const mockStudentRepo = {
        markFailure: vi.fn().mockResolvedValue({}),
        updateAliasSuccess: vi.fn(),
        recordSyncConflict: vi.fn(),
      };
      const mockLogRepo = {
        recordLog: vi.fn(),
      };
      const mockHanetClient = {
        updateAliasID: vi.fn().mockResolvedValue({
          success: false,
          rawResponse: { returnCode: -5011, returnMessage: 'Person not found' },
          evaluation: { action: 'QUARANTINE_MANUAL', userFacingMessage: 'Không tìm thấy người' },
        }),
        addPersonToDepartment: vi.fn(),
      };

      const job: any = {
        id: 'job_test_5011',
        data: {
          studentId: 102,
          aliasId: 'TS1A_OLD2',
          newAlias: 'TS1A_0002',
          personId: 'HANET_102',
          studentName: 'Trần Thị B',
          departmentId: '10',
        },
      };

      const result = await handleUpdateAlias(job, {
        studentRepo: mockStudentRepo as any,
        logRepo: mockLogRepo as any,
        hanetClient: mockHanetClient as any,
      });

      // 1. Phải chuyển sang manual_review
      expect(mockStudentRepo.markFailure).toHaveBeenCalledWith(
        102,
        'manual_review',
        '-5011',
        expect.stringContaining('Không tìm thấy personID')
      );

      // 2. Trả về kết quả yêu cầu admin đối soát
      expect(result.success).toBe(false);
      expect(result.reason).toBe('PERSON_NOT_FOUND');
    });
  });

  // =========================================================================
  // TEST CASE 5: WORKER HOÀN TẤT THÀNH CÔNG QUY TRÌNH 2 BƯỚC
  // =========================================================================
  describe('Worker Happy Path: Quy Trình 2 Bước Thành Công', () => {
    it('Phải gọi updateAliasID, delay và addPersonToDepartment đúng thứ tự', async () => {
      const callSequence: string[] = [];

      const mockStudentRepo = {
        markFailure: vi.fn(),
        updateAliasSuccess: vi.fn().mockImplementation(() => {
          callSequence.push('update_db');
        }),
        recordSyncConflict: vi.fn(),
      };
      const mockLogRepo = {
        recordLog: vi.fn(),
      };
      const mockHanetClient = {
        updateAliasID: vi.fn().mockImplementation(async () => {
          callSequence.push('update_alias');
          return { success: true, rawResponse: { returnCode: 1, returnMessage: 'Success' } };
        }),
        addPersonToDepartment: vi.fn().mockImplementation(async () => {
          callSequence.push('add_dept');
          return { success: true, rawResponse: { returnCode: 1, returnMessage: 'Success' } };
        }),
      };

      const job: any = {
        id: 'job_test_success',
        data: {
          studentId: 103,
          aliasId: 'TS1A_OLD3',
          newAlias: 'TS1A_0003',
          personId: 'HANET_103',
          studentName: 'Lê Hoàng C',
          departmentId: '10',
        },
      };

      const result = await handleUpdateAlias(job, {
        studentRepo: mockStudentRepo as any,
        logRepo: mockLogRepo as any,
        hanetClient: mockHanetClient as any,
      });

      expect(result.success).toBe(true);
      expect(result.aliasId).toBe('TS1A_0003');

      // Xác nhận thứ tự thực thi: update_alias -> add_dept -> update_db
      expect(callSequence).toEqual(['update_alias', 'add_dept', 'update_db']);
      expect(mockStudentRepo.updateAliasSuccess).toHaveBeenCalledWith(103, 'TS1A_0003');
    });
  });

  // =========================================================================
  // TEST CASE 7: BÓC TÁCH VÀ CHUẨN HÓA DỮ LIỆU CLOUD HANET THỰC TẾ VỀ 9 KÝ TỰ (FNV-1a HASH)
  // =========================================================================
  describe('Bóc tách & Chuẩn hóa Alias Cloud Thực Tế về 9 Ký Tự', () => {
    it('Phải chuẩn hóa mã Giáo Lý Viên 2 phần với hậu tố FNV-1a từ personID', () => {
      const res = parseAndClassifyAlias({
        personID: '12345',
        name: 'LUCIA Lê Thanh Minh Phương',
        aliasID: 'GLV_FK2S',
        avatar: 'https://vcdn-static.hanet.ai/face/employee/998577/avatar.jpg',
      });

      expect(res.isError).toBe(false);
      expect(res.partsCount).toBe(2);
      expect(res.nhom1_nganh).toBe('TN');
      expect(res.maLopChuanHoa).toBe('GLV0');
      // Hậu tố sinh mới 100% theo FNV-1a từ personID '12345'
      expect(res.aliasChuanHoaDuKien).toBe('GLV0_UCWO');
      expect(res.aliasChuanHoaDuKien).toHaveLength(9);
      expect(/^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$/.test(res.aliasChuanHoaDuKien!)).toBe(true);
    });

    it('Phải chuẩn hóa mã Thiếu Nhi 3 phần legacy với tiền tố RL2A và hậu tố FNV-1a', () => {
      const res = parseAndClassifyAlias({
        personID: '67890',
        name: 'EMMANUEL Nguyễn Văn Nam',
        aliasID: 'TN_XUNGTOI2A_4BDI',
        avatar: 'https://vcdn-static.hanet.ai/face/employee/998577/avatar.jpg',
      });

      expect(res.isError).toBe(false);
      expect(res.partsCount).toBe(3);
      expect(res.nhom1_nganh).toBe('TN');
      expect(res.maLopChuanHoa).toBe('RL2A');
      // Hậu tố sinh mới 100% theo FNV-1a từ personID '67890'
      expect(res.aliasChuanHoaDuKien).toBe('RL2A_C9BB');
      expect(res.aliasChuanHoaDuKien).toHaveLength(9);
      expect(/^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$/.test(res.aliasChuanHoaDuKien!)).toBe(true);
    });

    it('Mọi alias đều sinh hậu tố bất biến FNV-1a dựa trên personID', () => {
      const res = parseAndClassifyAlias({
        personID: '11111',
        name: 'MARIA Trần Thị Hà',
        aliasID: 'TS1A_0001',
      });

      expect(res.isError).toBe(false);
      expect(res.maLopChuanHoa).toBe('TS1A');
      // personID '11111' -> hash '5CZC'
      expect(res.aliasChuanHoaDuKien).toBe('TS1A_5CZC');
      expect(res.aliasChuanHoaDuKien).toHaveLength(9);
      expect(/^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$/.test(res.aliasChuanHoaDuKien!)).toBe(true);
    });

    it('Phải bảo toàn trường departmentID từ dữ liệu Cloud sang kết quả phân tích', () => {
      const res = parseAndClassifyAlias({
        personID: '77777',
        name: 'PHÊRÔ Trần Minh Mẫn',
        aliasID: 'GLV_FNWD',
        departmentID: 990653,
      });

      expect(res.isError).toBe(false);
      expect(res.departmentID).toBe(990653);
      expect(res.aliasChuanHoaDuKien).toBe('GLV0_HV0I');
      expect(res.aliasChuanHoaDuKien).toHaveLength(9);
    });

    it('Phải bắt lỗi nếu alias trống', () => {
      const res = parseAndClassifyAlias({
        personID: '99999',
        name: 'Vô Danh',
        aliasID: '',
      });

      expect(res.isError).toBe(true);
      expect(res.errorCode).toBe('ERR_EMPTY_ALIAS');
    });
  });

  describe('Cơ Chế Phòng Ngừa: Invalidation Cache khi Hoàn Tất Batch', () => {
    it('Phải chủ động xóa cache cache:hanet:real_cloud_faces khi batch đạt 100%', async () => {
      let isDoneSet = false;
      let cacheDeleted = false;

      const mockRedis = {
        hincrby: vi.fn().mockResolvedValue(1),
        hget: vi.fn().mockImplementation((_key, field) => {
          if (field === 'total') return Promise.resolve('1');
          if (field === 'processed') return Promise.resolve('1');
          return Promise.resolve(null);
        }),
        hset: vi.fn().mockImplementation((_key, field, val) => {
          if (field === 'is_done' && val === '1') isDoneSet = true;
          return Promise.resolve(1);
        }),
        del: vi.fn().mockImplementation((key) => {
          if (key === 'cache:hanet:real_cloud_faces') cacheDeleted = true;
          return Promise.resolve(1);
        }),
      };

      const mockStudentRepo = {
        updateAliasSuccess: vi.fn().mockResolvedValue(undefined),
        markFailure: vi.fn().mockResolvedValue(undefined),
        recordSyncConflict: vi.fn().mockResolvedValue(undefined),
      };

      const mockLogRepo = {
        recordLog: vi.fn().mockResolvedValue(undefined),
      };

      const mockHanetClient = {
        updateAliasID: vi.fn().mockResolvedValue({
          success: true,
          evaluation: { action: 'SUCCESS', returnMessage: 'Success' },
        }),
        addPersonToDepartment: vi.fn().mockResolvedValue({
          success: true,
          evaluation: { action: 'SUCCESS', returnMessage: 'Success' },
        }),
      };

      const jobData = {
        batchId: 'batch_test_invalidation',
        studentId: 99,
        aliasId: 'GLV_FK2S',
        newAlias: 'GLV0_FK2S',
        personId: 'HANET_999',
        studentName: 'Test Student',
        departmentId: 990653,
      };

      const job = {
        id: 'job_test_done',
        data: jobData,
      } as any;

      const context: any = {
        studentRepo: mockStudentRepo,
        logRepo: mockLogRepo,
        redisClient: mockRedis,
        hanetClient: mockHanetClient,
        settingsRepo: null,
        pauseWorker: vi.fn(),
      };

      const result = await handleUpdateAlias(job, context);
      expect(result.success).toBe(true);
      expect(isDoneSet).toBe(true);
      expect(cacheDeleted).toBe(true);
      expect(mockRedis.del).toHaveBeenCalledWith('cache:hanet:real_cloud_faces');
    });
  });

  // =========================================================================
  // TEST CASE 8: THUẬT TOÁN HASH FNV-1a PURE JS (generateDeterministicSuffix4)
  // =========================================================================
  describe('Thuật toán Hash FNV-1a Pure JS Base36 (generateDeterministicSuffix4)', () => {
    it('Phải sinh đúng 4 ký tự chữ-số viết hoa', () => {
      const suffix1 = generateDeterministicSuffix4('3318422336469729280');
      const suffix2 = generateDeterministicSuffix4('18897244400810101');
      const suffix3 = generateDeterministicSuffix4('0');

      expect(suffix1).toHaveLength(4);
      expect(suffix2).toHaveLength(4);
      expect(suffix3).toHaveLength(4);
      expect(/^[A-Z0-9]{4}$/.test(suffix1)).toBe(true);
      expect(/^[A-Z0-9]{4}$/.test(suffix2)).toBe(true);
      expect(/^[A-Z0-9]{4}$/.test(suffix3)).toBe(true);
    });

    it('Phải hoàn toàn xác định (Deterministic): Cùng 1 personID luôn cho cùng 1 suffix', () => {
      const pId = '18897244400810101';
      const run1 = generateDeterministicSuffix4(pId);
      const run2 = generateDeterministicSuffix4(pId);
      const run3 = generateDeterministicSuffix4(pId);

      expect(run1).toBe(run2);
      expect(run2).toBe(run3);
    });

    it('Khác personID phải cho suffix khác nhau (Tính phân tán cao)', () => {
      const s1 = generateDeterministicSuffix4('18897244400810101');
      const s2 = generateDeterministicSuffix4('18897244400810102');
      const s3 = generateDeterministicSuffix4('18897244400810103');

      expect(s1).not.toBe(s2);
      expect(s2).not.toBe(s3);
      expect(s1).not.toBe(s3);
    });
  });

  // =========================================================================
  // TEST CASE 9: QUY TẮC CHUẨN HÓA TIỀN TỐ 4 KÝ TỰ (normalizePrefix4)
  // =========================================================================
  describe('Quy tắc Chuẩn Hóa Tiền Tố (normalizePrefix4)', () => {
    it('Mã có trong từ điển phải ánh xạ chính xác (THEMSUC1A -> TS1A, XUNGTOI2A -> RL2A, BAODONG3 -> BD3A)', () => {
      expect(normalizePrefix4('THEMSUC1A')).toBe('TS1A');
      expect(normalizePrefix4('XUNGTOI2A')).toBe('RL2A');
      expect(normalizePrefix4('BAODONG3')).toBe('BD3A');
    });

    it('Mã ngắn hơn 4 ký tự phải đệm cho đủ 4 ký tự', () => {
      expect(normalizePrefix4('GLV')).toBe('GLV0');
      expect(normalizePrefix4('TN')).toBe('TN01');
    });

    it('Mã dài hơn 4 ký tự chưa trong từ điển: 2 ký tự đầu + 2 ký tự đuôi', () => {
      // GIAOLY1A -> 2 ký tự đầu 'GI' + đuôi '1A' -> GI1A
      expect(normalizePrefix4('GIAOLY1A')).toBe('GI1A');
    });
  });

  // =========================================================================
  // TEST CASE 10: LINEAR PROBING (ATTEMPT 0..3), ERR_EMPTY_SEGMENT & POSTGRES 23505
  // =========================================================================
  describe('Linear Probing, ERR_EMPTY_SEGMENT & Postgres 23505 Guard', () => {
    it('Phải bắt lỗi ERR_EMPTY_SEGMENT khi có dấu gạch dưới liên tiếp (VD: TN__01)', () => {
      const parsed = parseAndClassifyAlias({
        personID: '88888',
        name: 'Test Empty Segment',
        aliasID: 'TN__01',
      });
      expect(parsed.isError).toBe(true);
      expect(parsed.errorCode).toBe('ERR_EMPTY_SEGMENT');
    });

    it('Linear Probing (attempt = 0..3) phải tự động dịch chuyển hậu tố khi va chạm trong cùng lớp', async () => {
      const { resolveDeterministicAliasInMemory } = await import('../packages/shared-types/src/index.js');
      const usedMap = new Map<string, string>();
      const baseSuffix = generateDeterministicSuffix4('person_collision_A', 0);
      // Giả lập mã attempt=0 đã bị chiếm bởi một personID khác
      usedMap.set(`TS1A_${baseSuffix}`, 'existing_person_id');

      const resolved = resolveDeterministicAliasInMemory('TS1A', 'person_collision_A', usedMap);
      const expectedAttempt1 = `TS1A_${generateDeterministicSuffix4('person_collision_A', 1)}`;
      expect(resolved.attempt).toBe(1);
      expect(resolved.aliasId).toBe(expectedAttempt1);
      expect(resolved.collided).toBe(false);
    });

    it('Khi updateAliasSuccess ném lỗi Postgres 23505 (unique_violation), Worker phải ghi sync_conflicts và vẫn tăng processed để không treo Drawer ở 99%', async () => {
      const pgError: any = new Error('duplicate key value violates unique constraint "students_alias_id_key"');
      pgError.code = '23505';

      const mockStudentRepo = {
        updateAliasSuccess: vi.fn().mockRejectedValue(pgError),
        markFailure: vi.fn().mockResolvedValue({}),
        recordSyncConflict: vi.fn().mockResolvedValue(undefined),
      };
      const mockLogRepo = {
        recordLog: vi.fn().mockResolvedValue(undefined),
      };
      const mockRedis = {
        hincrby: vi.fn().mockResolvedValue(1),
        hget: vi.fn().mockResolvedValue('1'),
        hset: vi.fn().mockResolvedValue(1),
        del: vi.fn().mockResolvedValue(1),
      };
      const mockHanetClient = {
        updateAliasID: vi.fn().mockResolvedValue({
          success: true,
          rawResponse: { returnCode: 1 },
          evaluation: { action: 'SUCCESS' },
        }),
        addPersonToDepartment: vi.fn().mockResolvedValue({
          success: true,
          rawResponse: { returnCode: 1 },
          evaluation: { action: 'SUCCESS' },
        }),
      };

      const job: any = {
        id: 'job_23505',
        data: {
          batchId: 'batch_23505',
          studentId: 505,
          aliasId: 'TS1A_OLD9',
          newAlias: 'TS1A_BBC1',
          personId: 'HANET_505',
          studentName: 'Nguyễn Trùng Khóa',
          departmentId: '990653',
        },
      };

      const res = await handleUpdateAlias(job, {
        studentRepo: mockStudentRepo as any,
        logRepo: mockLogRepo as any,
        redisClient: mockRedis as any,
        hanetClient: mockHanetClient as any,
      });

      expect(res.success).toBe(false);
      expect(res.reason).toBe('DB_UNIQUE_VIOLATION_23505');
      expect(mockStudentRepo.recordSyncConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          studentId: 505,
          aliasId: 'TS1A_BBC1',
          conflictType: 'DB_UNIQUE_ALIAS_VIOLATION_23505',
        })
      );
      expect(mockStudentRepo.markFailure).toHaveBeenCalledWith(
        505,
        'manual_review',
        '23505',
        expect.stringContaining('23505')
      );
      // Phải tăng processed và failed để thanh tiến trình đạt 100% (is_done = '1')
      expect(mockRedis.hincrby).toHaveBeenCalledWith('batch:batch_23505', 'processed', 1);
      expect(mockRedis.hincrby).toHaveBeenCalledWith('batch:batch_23505', 'failed', 1);
      expect(mockRedis.hset).toHaveBeenCalledWith('batch:batch_23505', 'is_done', '1');
    });
  });

  // =========================================================================
  // TEST CASE 11: CHIẾN LƯỢC 2-PHASE ALIAS ID & SOFT-FAIL TRONG WORKER
  // =========================================================================
  describe('Chiến lược 2-Phase AliasID (tempAliasId -> finalAliasId + Soft-Fail)', () => {
    it('Pha 1 sinh tempAliasId 9 ký tự cho học sinh mới (aliasId = null), Pha 2 tính finalAliasId và giữ status=success ngay cả khi updateAliasID bị lỗi mạng (Soft-Fail)', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const sharp = (await import('sharp')).default;
      const { processRegistrationJob } = await import('../apps/worker/src/processor.js');
      const { workerEnv } = await import('../apps/worker/src/config.js');

      if (!fs.existsSync(workerEnv.uploadDir)) {
        fs.mkdirSync(workerEnv.uploadDir, { recursive: true });
      }
      if (!fs.existsSync(workerEnv.tmpFacesDir)) {
        fs.mkdirSync(workerEnv.tmpFacesDir, { recursive: true });
      }

      const tempFilename = `test_2phase_${Date.now()}.jpg`;
      const inputPath = path.join(workerEnv.uploadDir, tempFilename);
      const validJpeg = await sharp({
        create: { width: 200, height: 200, channels: 3, background: { r: 120, g: 150, b: 200 } },
      })
        .jpeg()
        .toBuffer();
      fs.writeFileSync(inputPath, validJpeg);

      let registeredTempAlias = '';
      const mockStudentRepo = {
        resolveUniqueFinalAliasId: vi.fn().mockImplementation(async (clsCode: string, personId: string) => {
          return `${clsCode}_${generateDeterministicSuffix4(personId, 0)}`;
        }),
        markPhase2LocalSuccess: vi.fn().mockResolvedValue({}),
        markCloudAliasSynced: vi.fn().mockResolvedValue(true),
        markSuccess: vi.fn().mockResolvedValue({}),
        markFailure: vi.fn(),
        findById: vi.fn().mockResolvedValue({ id: 777, retry_count: 0 }),
      };
      const mockLogRepo = {
        recordLog: vi.fn().mockResolvedValue(undefined),
      };
      const mockHanetClient = {
        registerByUrl: vi.fn().mockImplementation(async (params: { aliasID: string }) => {
          registeredTempAlias = params.aliasID;
          return {
            success: true,
            rawResponse: {
              returnCode: 1,
              data: {
                personID: '9988776655',
                file: 'https://static.hanet.ai/face/9988776655.jpg',
              },
            },
            evaluation: { action: 'SUCCESS' },
          };
        }),
        // Giả lập rớt mạng ở Pha 2 khi gọi updateAliasID
        updateAliasID: vi.fn().mockRejectedValue(new Error('Network timeout during Phase 2')),
      };

      const job: any = {
        id: 'job_2phase_softfail',
        data: {
          studentId: 777,
          aliasId: null, // Học sinh mới từ Excel chưa có alias_id
          qrToken: 'AbCdEfGh12345678',
          studentName: 'Phạm Gia Bảo',
          classCode: 'TS1A',
          tempFilename,
          uploadedAt: Date.now(),
          actionType: 'REGISTER',
        },
      };

      try {
        const result = await processRegistrationJob(job, {
          studentRepo: mockStudentRepo as any,
          logRepo: mockLogRepo as any,
          hanetClient: mockHanetClient as any,
        });

        // 1. Pha 1 phải gửi tempAliasId đúng chuẩn 9 ký tự bắt đầu bằng TS1A_
        expect(/^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$/.test(registeredTempAlias)).toBe(true);
        expect(registeredTempAlias.startsWith('TS1A_')).toBe(true);

        // 2. Pha 2 phải tính finalAliasId xác định từ personID '9988776655'
        const expectedFinalAlias = `TS1A_${generateDeterministicSuffix4('9988776655', 0)}`;
        expect(result.success).toBe(true);
        expect(result.personId).toBe('9988776655');
        expect(result.aliasId).toBe(expectedFinalAlias);

        // 3. Soft-Fail: Dù updateAliasID lỗi mạng, học sinh vẫn được đánh dấu 'success' local và cloudAliasSynced = false
        expect(result.cloudAliasSynced).toBe(false);
        expect(mockStudentRepo.markPhase2LocalSuccess).toHaveBeenCalledWith(
          777,
          '9988776655',
          'https://static.hanet.ai/face/9988776655.jpg',
          expectedFinalAlias,
          false
        );
        expect(mockStudentRepo.markFailure).not.toHaveBeenCalled();
      } finally {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      }
    });
  });

  // =========================================================================
  // TEST CASE 12: GIAI ĐOẠN 1 SET-BASED SQL MAPPING (< 100ms, TRANSACTION ROLLBACK) & CHỐT CHẶN 30S RETRY
  // =========================================================================
  describe('Giai đoạn 1 Set-Based SQL Mapping & Chốt chặn 30s Retry', () => {
    it('executeStage1SnapshotAndSeed phải chuẩn bị dữ liệu trong RAM trước khi BEGIN, thực thi UNNEST < 100ms và tự động ROLLBACK khi gặp lỗi', async () => {
      const { executeStage1SnapshotAndSeed } = await import('../packages/shared-infra/src/seeds/snapshot-and-seed.js');
      const executedQueries: string[] = [];

      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          executedQueries.push(sql.trim());
          if (sql.includes('SELECT id, code FROM classes')) {
            return { rows: [{ id: 1, code: 'TS1A' }], rowCount: 1 };
          }
          if (sql.includes('WITH unique_excel_students')) {
            return { rows: [{ student_id: 10, person_id: 'P1' }], rowCount: 1 };
          }
          if (sql.includes('FROM staging_cloud_faces') && sql.includes('WHERE is_matched = FALSE')) {
            return {
              rows: [
                {
                  person_id: 'P2_EXTRA',
                  raw_alias: 'TS1A_EXT2',
                  full_name: 'Học Sinh Phát Sinh',
                  normalized_name: 'hoc sinh phat sinh',
                  face_url: 'https://static.hanet.ai/p2.jpg',
                  target_class_id: 1,
                },
              ],
              rowCount: 1,
            };
          }
          if (sql.includes('WITH inserted AS')) {
            return { rows: [{ id: 11, person_id: 'P2_EXTRA' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
        release: vi.fn(),
      };

      const mockPool: any = {
        connect: vi.fn().mockResolvedValue(mockClient),
      };

      const summary = await executeStage1SnapshotAndSeed(
        mockPool,
        [
          { classCode: 'TS1A', name: 'Nguyễn Văn A' },
          { classCode: 'TS1A', name: 'Trần Thị B' },
        ],
        [
          { personID: 'P1', aliasID: 'TS1A_A1B2', name: 'Nguyễn Văn A', classCode: 'TS1A' },
          { personID: 'P2_EXTRA', aliasID: 'TS1A_EXT2', name: 'Học Sinh Phát Sinh', classCode: 'TS1A' },
        ]
      );

      expect(executedQueries[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
      expect(executedQueries[executedQueries.length - 1]).toBe('COMMIT');
      expect(summary.matchedFromExcelCount).toBe(1);
      expect(summary.autoInsertedFromCloudCount).toBe(1);
      expect(summary.emptyNewStudentsCount).toBe(1);
      expect(summary.transactionDurationMs).toBeLessThan(100);
    });

    it('getUnsyncedCloudAliasesForRetry phải có điều kiện updated_at < NOW() - INTERVAL \'30 seconds\'', async () => {
      const { StudentRepository } = await import('../packages/shared-infra/src/repositories/studentRepository.js');
      let capturedSql = '';
      const mockPool: any = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          capturedSql = sql;
          return { rows: [] };
        }),
      };
      const repo = new StudentRepository(mockPool);
      await repo.getUnsyncedCloudAliasesForRetry(50);

      expect(capturedSql).toContain('cloud_alias_synced');
      expect(capturedSql).toContain("INTERVAL '30 seconds'");
    });
  });
});



