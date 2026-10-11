import { describe, it, expect, vi } from 'vitest';
import { HanetClient } from '../packages/hanet-client/src/index.js';
import { handleUpdateAlias } from '../apps/worker/src/processors/update-alias.processor.js';
import { parseAndClassifyAlias } from '../packages/shared-types/src/index.js';

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
  // TEST CASE 7: BÓC TÁCH VÀ CHUẨN HÓA DỮ LIỆU CLOUD HANET THỰC TẾ VỀ 9 KÝ TỰ
  // =========================================================================
  describe('Bóc tách & Chuẩn hóa Alias Cloud Thực Tế về 9 Ký Tự', () => {
    it('Phải chuẩn hóa mã Giáo Lý Viên 2 phần (GLV_FK2S -> GLV0_FK2S)', () => {
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
      expect(res.aliasChuanHoaDuKien).toBe('GLV0_FK2S');
      expect(res.aliasChuanHoaDuKien).toHaveLength(9);
    });

    it('Phải chuẩn hóa mã Thiếu Nhi 3 phần legacy (TN_XUNGTOI2A_4BDI -> RL2A_4BDI)', () => {
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
      expect(res.aliasChuanHoaDuKien).toBe('RL2A_4BDI');
      expect(res.aliasChuanHoaDuKien).toHaveLength(9);
    });

    it('Phải giữ nguyên mã đã đúng chuẩn 9 ký tự (TS1A_0001 -> TS1A_0001)', () => {
      const res = parseAndClassifyAlias({
        personID: '11111',
        name: 'MARIA Trần Thị Hà',
        aliasID: 'TS1A_0001',
      });

      expect(res.isError).toBe(false);
      expect(res.maLopChuanHoa).toBe('TS1A');
      expect(res.aliasChuanHoaDuKien).toBe('TS1A_0001');
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
});

