import { describe, it, expect } from 'vitest';
import {
  calculateTargetDimensions,
  compressCanvasWithCeiling,
  HARD_CEILING_BYTES_DEFAULT,
} from '../apps/student/src/utils/canvasCompressor.js';

describe('T012: Canvas Compressor & Hard Ceiling Guard (< 1MB)', () => {
  describe('calculateTargetDimensions (MaxSide 1920)', () => {
    it('Giữ nguyên kích thước nếu cả 2 cạnh đều <= 1920', () => {
      const dim = calculateTargetDimensions(1280, 720, 1920);
      expect(dim.width).toBe(1280);
      expect(dim.height).toBe(720);
    });

    it('Scale down theo chiều ngang nếu width > 1920', () => {
      const dim = calculateTargetDimensions(3840, 2160, 1920);
      expect(dim.width).toBe(1920);
      expect(dim.height).toBe(1080);
    });

    it('Scale down theo chiều dọc nếu height > 1920', () => {
      const dim = calculateTargetDimensions(1080, 2160, 1920);
      expect(dim.height).toBe(1920);
      expect(dim.width).toBe(960);
    });
  });

  describe('compressCanvasWithCeiling (Vòng lặp nén & Trần cứng)', () => {
    it('Chấp nhận ngay ở chất lượng mặc định 0.85 nếu dung lượng < 1MB', async () => {
      // Mock encoder trả về Blob 600KB
      const mockEncoder = async (_canvas: any, quality: number) => {
        return new Blob([new Uint8Array(600 * 1024)], { type: 'image/jpeg' });
      };

      const result = await compressCanvasWithCeiling({}, 1920, 1080, {
        encoder: mockEncoder,
      });

      expect(result.sizeBytes).toBe(600 * 1024);
      expect(result.quality).toBe(0.85);
      expect(result.sizeBytes).toBeLessThan(HARD_CEILING_BYTES_DEFAULT);
    });

    it('Tự động giảm chất lượng từng nấc nếu ảnh ban đầu vượt trần 1MB', async () => {
      // Mock encoder: ở quality 0.85 size = 1.3MB, ở quality 0.75 size = 950KB (< 1MB)
      const mockEncoder = async (_canvas: any, quality: number) => {
        const sizeBytes = quality >= 0.8 ? 1.3 * 1024 * 1024 : 950 * 1024;
        return new Blob([new Uint8Array(sizeBytes)], { type: 'image/jpeg' });
      };

      const result = await compressCanvasWithCeiling({}, 1920, 1080, {
        encoder: mockEncoder,
      });

      expect(result.sizeBytes).toBeLessThan(HARD_CEILING_BYTES_DEFAULT);
      expect(result.quality).toBe(0.75);
    });

    it('Chặn và ném lỗi thân thiện tiếng Việt nếu đã xuống sàn mà dung lượng vẫn > 1MB', async () => {
      // Mock encoder luôn trả về Blob 1.5MB bất kể quality hay scale
      const mockEncoder = async () => {
        return new Blob([new Uint8Array(1.5 * 1024 * 1024)], { type: 'image/jpeg' });
      };

      await expect(
        compressCanvasWithCeiling({}, 1920, 1080, {
          encoder: mockEncoder,
          minDimension: 1200,
        })
      ).rejects.toThrow(/vượt quá trần kỹ thuật 1 MB/);
    });
  });
});
