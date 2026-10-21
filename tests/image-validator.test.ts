import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import {
  validateImage,
  isHeicBuffer,
  MAX_IMAGE_SIZE_BYTES,
  MIN_IMAGE_DIMENSION,
  IMAGE_ERROR_CODES,
  ImageValidationResult,
  HEIC_BRANDS,
} from '../packages/shared-infra/src/validators/image.validator.js';

/**
 * Helper tạo JPEG hợp lệ có chính xác targetLength byte bằng cách chèn COM segment (0xFF 0xFE)
 */
function createExactLengthJpeg(baseJpeg: Buffer, targetLength: number): Buffer {
  const current = baseJpeg.subarray(0, baseJpeg.length - 2);
  const eoi = baseJpeg.subarray(baseJpeg.length - 2);
  let needed = targetLength - current.length - eoi.length;

  const chunks: Buffer[] = [current];
  while (needed > 0) {
    let chunkLen = Math.min(needed, 65535);
    if (needed - chunkLen > 0 && needed - chunkLen < 4) {
      chunkLen -= 4 - (needed - chunkLen);
    }
    const payloadLen = chunkLen - 4;
    const header = Buffer.from([0xff, 0xfe, (chunkLen - 2) >> 8, (chunkLen - 2) & 0xff]);
    const payload = Buffer.alloc(payloadLen, 0x20);
    chunks.push(header, payload);
    needed -= chunkLen;
  }
  chunks.push(eoi);
  return Buffer.concat(chunks);
}

describe('T002: Image Validator Unit Tests (TDD)', () => {
  let validSquare100x100: Buffer;
  let validWideRatio: Buffer;
  let validTallRatio: Buffer;
  let validStandard1280x736: Buffer;
  let subDetection99x99: Buffer;
  let subDetectionWidthLow: Buffer;
  let subDetectionHeightLow: Buffer;

  // Test buffers bổ sung theo yêu cầu nghiệm thu
  let jpegExact5242879: Buffer;
  let jpegExact5242880: Buffer;
  let valid100x500: Buffer;
  let valid500x100: Buffer;
  let valid200x2000: Buffer;
  let valid2000x200: Buffer;
  let validWebp120x3600: Buffer;
  let validWebp640x480: Buffer;
  let validExifOrientation90Jpeg: Buffer;
  let validGrayPng300x300: Buffer;
  let validRgbaPng300x300: Buffer;
  let gif300x300: Buffer;
  let tiff300x300: Buffer;

  // HEIC test buffers
  let validHeic300x400: Buffer;
  let corruptedHeic: Buffer;

  beforeAll(async () => {
    // 1. Test buffers ban đầu
    validSquare100x100 = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .jpeg()
      .toBuffer();

    validWideRatio = await sharp({
      create: {
        width: 800,
        height: 300, // Tỉ lệ 8:3 (sai tỉ lệ 16:9 chuẩn)
        channels: 3,
        background: { r: 0, g: 255, b: 0 },
      },
    })
      .jpeg()
      .toBuffer();

    validTallRatio = await sharp({
      create: {
        width: 300,
        height: 900, // Tỉ lệ 1:3 (ảnh dọc dài)
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .png()
      .toBuffer();

    validStandard1280x736 = await sharp({
      create: {
        width: 1280,
        height: 736,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
      },
    })
      .jpeg()
      .toBuffer();

    subDetection99x99 = await sharp({
      create: {
        width: 99,
        height: 99,
        channels: 3,
        background: { r: 255, g: 255, b: 0 },
      },
    })
      .png()
      .toBuffer();

    subDetectionWidthLow = await sharp({
      create: {
        width: 80,
        height: 250,
        channels: 3,
        background: { r: 255, g: 0, b: 255 },
      },
    })
      .jpeg()
      .toBuffer();

    subDetectionHeightLow = await sharp({
      create: {
        width: 250,
        height: 80,
        channels: 3,
        background: { r: 0, g: 255, b: 255 },
      },
    })
      .jpeg()
      .toBuffer();

    // 2. Test buffers bổ sung (Yêu cầu 1: Ngưỡng kích thước chính xác)
    jpegExact5242879 = createExactLengthJpeg(validSquare100x100, 5242879);
    jpegExact5242880 = createExactLengthJpeg(validSquare100x100, 5242880);

    // 3. Test buffers bổ sung (Yêu cầu 2: Kích thước biên 100x500 và 500x100)
    valid100x500 = await sharp({
      create: {
        width: 100,
        height: 500,
        channels: 3,
        background: { r: 50, g: 100, b: 150 },
      },
    })
      .jpeg()
      .toBuffer();

    valid500x100 = await sharp({
      create: {
        width: 500,
        height: 100,
        channels: 3,
        background: { r: 150, g: 100, b: 50 },
      },
    })
      .jpeg()
      .toBuffer();

    // 4. Test buffers bổ sung (Yêu cầu 3: Tỉ lệ cực đoan và WebP)
    valid200x2000 = await sharp({
      create: {
        width: 200,
        height: 2000,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    })
      .jpeg()
      .toBuffer();

    valid2000x200 = await sharp({
      create: {
        width: 2000,
        height: 200,
        channels: 3,
        background: { r: 60, g: 40, b: 20 },
      },
    })
      .jpeg()
      .toBuffer();

    validWebp120x3600 = await sharp({
      create: {
        width: 120,
        height: 3600,
        channels: 3,
        background: { r: 80, g: 120, b: 160 },
      },
    })
      .webp()
      .toBuffer();

    validWebp640x480 = await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: { r: 160, g: 120, b: 80 },
      },
    })
      .webp()
      .toBuffer();

    // 5. Test buffers bổ sung (Yêu cầu 4: EXIF Orientation, Grayscale, Alpha)
    validExifOrientation90Jpeg = await sharp({
      create: {
        width: 120,
        height: 600,
        channels: 3,
        background: { r: 200, g: 150, b: 100 },
      },
    })
      .withMetadata({ orientation: 6 }) // Orientation 6: xoay 90° CW
      .jpeg()
      .toBuffer();

    validGrayPng300x300 = await sharp({
      create: {
        width: 300,
        height: 300,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
      },
    })
      .toColourspace('b-w')
      .png()
      .toBuffer();

    validRgbaPng300x300 = await sharp({
      create: {
        width: 300,
        height: 300,
        channels: 4,
        background: { r: 255, g: 50, b: 50, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();

    // 6. Test buffers định dạng ngoài Whitelist (GIF, TIFF)
    gif300x300 = await sharp({
      create: {
        width: 300,
        height: 300,
        channels: 3,
        background: { r: 0, g: 200, b: 100 },
      },
    })
      .gif()
      .toBuffer();

    tiff300x300 = await sharp({
      create: {
        width: 300,
        height: 300,
        channels: 3,
        background: { r: 100, g: 100, b: 200 },
      },
    })
      .tiff()
      .toBuffer();

    // 7. Tải HEIC test fixture thật (300x400)
    const fixturePath = path.resolve(__dirname, 'fixtures/sample_300x400.heic');
    validHeic300x400 = fs.readFileSync(fixturePath);

    // HEIC hỏng: giữ nguyên ftyp box nhưng cắt cụt phần payload
    corruptedHeic = validHeic300x400.subarray(0, 48);
  });

  // ==========================================
  // CÁC TEST HIỆN CÓ ĐƯỢC GIỮ NGUYÊN HOÀN TOÀN
  // ==========================================

  describe('Trường hợp 1: Payload > 5MB bị chặn (Hard limit)', () => {
    it('Phải từ chối buffer vượt quá 5MB (5 * 1024 * 1024 + 1 bytes)', async () => {
      const oversizedBuffer = Buffer.alloc(MAX_IMAGE_SIZE_BYTES + 1);
      const result: ImageValidationResult = await validateImage(oversizedBuffer);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(IMAGE_ERROR_CODES.PAYLOAD_TOO_LARGE);
      expect(result.message).toMatch(/5MB/i);
    });

    it('Phải từ chối payload 6MB', async () => {
      const sixMbBuffer = Buffer.alloc(6 * 1024 * 1024);
      const result = await validateImage(sixMbBuffer);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(IMAGE_ERROR_CODES.PAYLOAD_TOO_LARGE);
    });
  });

  describe('Trường hợp 2: File hỏng hoặc không phải ảnh bị chặn', () => {
    it('Phải từ chối buffer rỗng (0 bytes)', async () => {
      const emptyBuffer = Buffer.alloc(0);
      const result = await validateImage(emptyBuffer);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(IMAGE_ERROR_CODES.CORRUPTED_IMAGE);
    });

    it('Phải từ chối chuỗi text giả mạo file ảnh', async () => {
      const fakeImage = Buffer.from('THIS_IS_NOT_A_VALID_IMAGE_BUFFER_CONTENT');
      const result = await validateImage(fakeImage);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(IMAGE_ERROR_CODES.CORRUPTED_IMAGE);
    });

    it('Phải từ chối header giả mạo bị cắt cụt (corrupted bytes)', async () => {
      const corruptedHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
      const result = await validateImage(corruptedHeader);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(IMAGE_ERROR_CODES.CORRUPTED_IMAGE);
    });

    it('Phải từ chối khi input không hợp lệ (null/undefined)', async () => {
      // @ts-expect-error test runtime validation
      const result = await validateImage(null);
      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(IMAGE_ERROR_CODES.INVALID_INPUT);
    });
  });

  describe('Trường hợp 3: Ảnh có kích thước dưới ngưỡng nhận diện (<100x100) bị chặn', () => {
    it('Phải từ chối ảnh 99x99 (cả 2 chiều đều dưới 100px)', async () => {
      const result = await validateImage(subDetection99x99);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(IMAGE_ERROR_CODES.RESOLUTION_TOO_LOW);
      expect(result.metadata?.width).toBe(99);
      expect(result.metadata?.height).toBe(99);
      expect(result.message).toMatch(/100x100/i);
    });

    it('Phải từ chối ảnh 80x250 (chiều rộng < 100px)', async () => {
      const result = await validateImage(subDetectionWidthLow);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(IMAGE_ERROR_CODES.RESOLUTION_TOO_LOW);
      expect(result.metadata?.width).toBe(80);
      expect(result.metadata?.height).toBe(250);
    });

    it('Phải từ chối ảnh 250x80 (chiều cao < 100px)', async () => {
      const result = await validateImage(subDetectionHeightLow);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(IMAGE_ERROR_CODES.RESOLUTION_TOO_LOW);
      expect(result.metadata?.width).toBe(250);
      expect(result.metadata?.height).toBe(80);
    });
  });

  describe('Trường hợp 4: Ảnh sai tỉ lệ được chấp nhận (Sharp downstream handles cover)', () => {
    it('Phải chấp nhận ảnh vuông 100x100 (tỉ lệ 1:1, đúng ngưỡng tối thiểu)', async () => {
      const result = await validateImage(validSquare100x100);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.width).toBe(100);
      expect(result.metadata?.height).toBe(100);
      expect(result.metadata?.aspectRatio).toBeCloseTo(1.0, 2);
    });

    it('Phải chấp nhận ảnh tỉ lệ ngang dị biệt 800x300 (tỉ lệ 8:3)', async () => {
      const result = await validateImage(validWideRatio);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.width).toBe(800);
      expect(result.metadata?.height).toBe(300);
      expect(result.metadata?.aspectRatio).toBeCloseTo(800 / 300, 2);
    });

    it('Phải chấp nhận ảnh tỉ lệ dọc dài 300x900 (tỉ lệ 1:3)', async () => {
      const result = await validateImage(validTallRatio);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.width).toBe(300);
      expect(result.metadata?.height).toBe(900);
      expect(result.metadata?.aspectRatio).toBeCloseTo(300 / 900, 2);
    });

    it('Phải chấp nhận ảnh chuẩn 1280x736', async () => {
      const result = await validateImage(validStandard1280x736);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.width).toBe(1280);
      expect(result.metadata?.height).toBe(736);
    });
  });

  describe('Bổ sung 1: Biên dung lượng chính xác (5.242.879 byte & 5.242.880 byte)', () => {
    it('JPEG hợp lệ dung lượng đúng 5.242.879 byte → ACCEPT', async () => {
      expect(jpegExact5242879.byteLength).toBe(5242879);
      const result = await validateImage(jpegExact5242879);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.sizeBytes).toBe(5242879);
      expect(result.metadata?.format).toBe('jpeg');
    });

    it('JPEG hợp lệ dung lượng đúng 5.242.880 byte (chính xác trần 5MB) → ACCEPT', async () => {
      expect(jpegExact5242880.byteLength).toBe(5242880);
      const result = await validateImage(jpegExact5242880);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.sizeBytes).toBe(5242880);
      expect(result.metadata?.format).toBe('jpeg');
    });
  });

  describe('Bổ sung 2: Kích thước biên cực cận ngưỡng tối thiểu (100x500 & 500x100)', () => {
    it('100x500 → ACCEPT', async () => {
      const result = await validateImage(valid100x500);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.width).toBe(100);
      expect(result.metadata?.height).toBe(500);
      expect(result.metadata?.aspectRatio).toBeCloseTo(100 / 500, 2);
    });

    it('500x100 → ACCEPT', async () => {
      const result = await validateImage(valid500x100);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.width).toBe(500);
      expect(result.metadata?.height).toBe(100);
      expect(result.metadata?.aspectRatio).toBeCloseTo(500 / 100, 2);
    });
  });

  describe('Bổ sung 3: Tỉ lệ cực đoan và định dạng WebP', () => {
    it('200x2000 (tỉ lệ 1:10) → ACCEPT', async () => {
      const result = await validateImage(valid200x2000);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.width).toBe(200);
      expect(result.metadata?.height).toBe(2000);
      expect(result.metadata?.aspectRatio).toBeCloseTo(1 / 10, 2);
    });

    it('2000x200 (tỉ lệ 10:1) → ACCEPT', async () => {
      const result = await validateImage(valid2000x200);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.width).toBe(2000);
      expect(result.metadata?.height).toBe(200);
      expect(result.metadata?.aspectRatio).toBeCloseTo(10 / 1, 2);
    });

    it('WebP hợp lệ 120x3600 → ACCEPT (định dạng webp)', async () => {
      const result = await validateImage(validWebp120x3600);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.width).toBe(120);
      expect(result.metadata?.height).toBe(3600);
      expect(result.metadata?.format).toBe('webp');
    });

    it('WebP hợp lệ 640x480 → ACCEPT (định dạng webp)', async () => {
      const result = await validateImage(validWebp640x480);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.width).toBe(640);
      expect(result.metadata?.height).toBe(480);
      expect(result.metadata?.format).toBe('webp');
    });
  });

  describe('Bổ sung 4: EXIF Orientation, PNG Grayscale, PNG RGBA', () => {
    it('JPEG có EXIF Orientation xoay 90°, kích thước lưu trữ 120x600 → ACCEPT', async () => {
      const result = await validateImage(validExifOrientation90Jpeg);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.width).toBe(120);
      expect(result.metadata?.height).toBe(600);
      expect(result.metadata?.format).toBe('jpeg');
    });

    it('PNG grayscale 300x300 → ACCEPT', async () => {
      const result = await validateImage(validGrayPng300x300);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.width).toBe(300);
      expect(result.metadata?.height).toBe(300);
      expect(result.metadata?.format).toBe('png');
    });

    it('PNG RGBA có alpha 300x300 → ACCEPT', async () => {
      const result = await validateImage(validRgbaPng300x300);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.width).toBe(300);
      expect(result.metadata?.height).toBe(300);
      expect(result.metadata?.format).toBe('png');
    });
  });

  // =========================================================================
  // BỔ SUNG WHITELIST ĐỊNH DẠNG (Bắt buộc REJECT GIF/TIFF với UNSUPPORTED_FORMAT)
  // =========================================================================

  describe('Bổ sung 5: Whitelist định dạng — Bắt buộc REJECT định dạng ngoài danh sách', () => {
    it('GIF hợp lệ 300x300 → Bắt buộc REJECT với mã UNSUPPORTED_FORMAT', async () => {
      const result = await validateImage(gif300x300);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(IMAGE_ERROR_CODES.UNSUPPORTED_FORMAT);
      expect(result.metadata?.format).toBe('gif');
      expect(result.metadata?.width).toBe(300);
      expect(result.metadata?.height).toBe(300);
      expect(result.message).toMatch(/không được hỗ trợ/i);
      expect(result.message).toMatch(/JPEG.*PNG.*WebP/i);
    });

    it('TIFF hợp lệ 300x300 → Bắt buộc REJECT với mã UNSUPPORTED_FORMAT', async () => {
      const result = await validateImage(tiff300x300);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(IMAGE_ERROR_CODES.UNSUPPORTED_FORMAT);
      expect(result.metadata?.format).toBe('tiff');
    });
  });

  // =========================================================================
  // BỔ SUNG XỬ LÝ HEIC/HEIF (Tự động chuyển đổi sang JPEG)
  // =========================================================================

  describe('Bổ sung 6: Xử lý định dạng HEIC/HEIF từ iPhone', () => {
    it('Kiểm tra hàm isHeicBuffer nhận diện đúng các brand ftyp của HEIC/HEIF', () => {
      // Buffer HEIC thật
      expect(isHeicBuffer(validHeic300x400)).toBe(true);

      // Thử nghiệm từng brand trong whitelist HEIC_BRANDS
      for (const brand of HEIC_BRANDS) {
        const mockFtyp = Buffer.alloc(16);
        mockFtyp.writeUInt32BE(16, 0);
        mockFtyp.write('ftyp', 4, 'ascii');
        mockFtyp.write(brand, 8, 'ascii');
        mockFtyp.writeUInt32BE(0, 12);
        expect(isHeicBuffer(mockFtyp)).toBe(true);
      }

      // Từ chối buffer không phải HEIC (JPEG, PNG, text)
      expect(isHeicBuffer(validSquare100x100)).toBe(false);
      expect(isHeicBuffer(validTallRatio)).toBe(false);
      expect(isHeicBuffer(Buffer.from('HELLO_WORLD_TEST'))).toBe(false);
    });

    it('HEIC đạt chuẩn (fixture 300x400) → ACCEPT, format sau chuyển đổi là jpeg, kích thước giữ đúng ảnh gốc', async () => {
      const result = await validateImage(validHeic300x400);

      expect(result.isValid).toBe(true);
      expect(result.metadata?.format).toBe('jpeg');
      expect(result.metadata?.width).toBe(300);
      expect(result.metadata?.height).toBe(400);
      expect(result.convertedBuffer).toBeDefined();
      expect(Buffer.isBuffer(result.convertedBuffer)).toBe(true);

      // Kiểm chứng convertedBuffer thực sự là một JPEG hợp lệ mà Sharp có thể đọc
      const convertedMeta = await sharp(result.convertedBuffer!).metadata();
      expect(convertedMeta.format).toBe('jpeg');
      expect(convertedMeta.width).toBe(300);
      expect(convertedMeta.height).toBe(400);
    });

    it('HEIC hỏng (đúng ftyp brand heic nhưng payload bị cắt cụt) → CORRUPTED_IMAGE, KHÔNG trả UNSUPPORTED_FORMAT', async () => {
      expect(isHeicBuffer(corruptedHeic)).toBe(true);

      const result = await validateImage(corruptedHeic);

      expect(result.isValid).toBe(false);
      expect(result.errorCode).toBe(IMAGE_ERROR_CODES.CORRUPTED_IMAGE);
      expect(result.errorCode).not.toBe(IMAGE_ERROR_CODES.UNSUPPORTED_FORMAT);
      expect(result.message).toMatch(/HEIC\/HEIF/i);
    });
  });
});
