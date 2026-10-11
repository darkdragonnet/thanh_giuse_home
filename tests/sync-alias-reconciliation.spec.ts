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
});


