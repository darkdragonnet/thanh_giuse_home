import sharp, { Metadata } from 'sharp';
import convert from 'heic-convert';

export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MIN_IMAGE_DIMENSION = 100; // 100 px

export const SUPPORTED_IMAGE_FORMATS = ['jpeg', 'png', 'webp'] as const;
export type SupportedImageFormat = (typeof SUPPORTED_IMAGE_FORMATS)[number];

export const HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'heim',
  'heis',
  'mif1',
  'mif2',
  'msf1',
]);

export const IMAGE_ERROR_CODES = {
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  CORRUPTED_IMAGE: 'CORRUPTED_IMAGE',
  RESOLUTION_TOO_LOW: 'RESOLUTION_TOO_LOW',
  INVALID_INPUT: 'INVALID_INPUT',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
} as const;

export type ImageErrorCode = (typeof IMAGE_ERROR_CODES)[keyof typeof IMAGE_ERROR_CODES];

export interface ImageMetadataInfo {
  width?: number;
  height?: number;
  format?: string;
  sizeBytes: number;
  aspectRatio?: number;
}

export interface ImageValidationResult {
  isValid: boolean;
  errorCode?: ImageErrorCode;
  message?: string;
  metadata?: ImageMetadataInfo;
  convertedBuffer?: Buffer;
}

export interface ImageValidationOptions {
  maxSizeBytes?: number;
  minDimension?: number;
  allowedFormats?: readonly string[];
}

/**
 * Kiểm tra buffer có phải là định dạng HEIC/HEIF dựa trên hộp ftyp và các brand tương thích
 */
export function isHeicBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.byteLength < 12) return false;

  // Hộp 'ftyp' nằm ở offset 4..8
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;

  // Kiểm tra major brand (offset 8..12)
  const majorBrand = buffer.toString('ascii', 8, 12).toLowerCase();
  if (HEIC_BRANDS.has(majorBrand)) return true;

  // Kiểm tra danh sách compatible brands (từ offset 16 trở đi)
  const boxSize = buffer.readUInt32BE(0);
  const end = Math.min(boxSize > 0 ? boxSize : buffer.byteLength, buffer.byteLength, 1024);
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    const brand = buffer.toString('ascii', offset, offset + 4).toLowerCase();
    if (HEIC_BRANDS.has(brand)) return true;
  }

  return false;
}

/**
 * Core image validator for Student Face Registration
 *
 * Thứ tự kiểm tra:
 * 1. Dung lượng gốc: Chặn payload > 5MB trước khi xử lý (bảo vệ RAM VPS)
 * 2. Nhận diện HEIC/HEIF: Chuyển đổi sang JPEG bằng heic-convert (thuần JS/WASM),
 *    giải phóng buffer gốc ngay sau khi chuyển đổi để tiết kiệm RAM. Lỗi chuyển đổi -> CORRUPTED_IMAGE.
 * 3. Giải mã Sharp: Bắt lỗi buffer hỏng hoặc không phải ảnh hợp lệ -> CORRUPTED_IMAGE.
 * 4. Whitelist định dạng: Chỉ chấp nhận 'jpeg', 'png', 'webp'. Định dạng khác (gif, tiff, bmp...)
 *    -> REJECT với mã UNSUPPORTED_FORMAT.
 * 5. Độ phân giải: Chặn ảnh có bất kỳ chiều nào < 100px -> RESOLUTION_TOO_LOW.
 * 6. Tỉ lệ khung hình: Chấp nhận mọi tỉ lệ (downstream worker cover 1280x736).
 */
export async function validateImage(
  input: Buffer | Uint8Array,
  options?: ImageValidationOptions
): Promise<ImageValidationResult> {
  const maxSize = options?.maxSizeBytes ?? MAX_IMAGE_SIZE_BYTES;
  const minDimension = options?.minDimension ?? MIN_IMAGE_DIMENSION;
  const allowedFormats = options?.allowedFormats ?? SUPPORTED_IMAGE_FORMATS;

  // 1. Kiểm tra tính hợp lệ của tham số đầu vào
  if (!input || !(Buffer.isBuffer(input) || input instanceof Uint8Array)) {
    return {
      isValid: false,
      errorCode: IMAGE_ERROR_CODES.INVALID_INPUT,
      message: 'Dữ liệu ảnh đầu vào không hợp lệ (yêu cầu Buffer hoặc Uint8Array)',
    };
  }

  let originalBuffer: Buffer | null = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const sizeBytes = originalBuffer.byteLength;

  // 2. Chặn buffer rỗng
  if (sizeBytes === 0) {
    return {
      isValid: false,
      errorCode: IMAGE_ERROR_CODES.CORRUPTED_IMAGE,
      message: 'Buffer ảnh rỗng (0 bytes)',
      metadata: { sizeBytes: 0 },
    };
  }

  // 3. Chặn cứng payload > 5MB trên buffer gốc trước khi xử lý nhằm bảo vệ RAM VPS
  if (sizeBytes > maxSize) {
    return {
      isValid: false,
      errorCode: IMAGE_ERROR_CODES.PAYLOAD_TOO_LARGE,
      message: `Dung lượng ảnh (${(sizeBytes / (1024 * 1024)).toFixed(2)} MB) vượt quá giới hạn cho phép (tối đa 5MB)`,
      metadata: { sizeBytes },
    };
  }

  let processedBuffer: Buffer = originalBuffer;
  let isConvertedFromHeic = false;

  // 4. Nhận diện và chuyển đổi ảnh HEIC/HEIF (chụp từ iPhone) sang JPEG
  if (isHeicBuffer(originalBuffer)) {
    try {
      const convertedArrayBuffer = await convert({
        buffer: originalBuffer,
        format: 'JPEG',
        quality: 0.9,
      });

      // Cho phép GC giải phóng buffer gốc HEIC ngay sau khi chuyển đổi để tiết kiệm RAM VPS
      originalBuffer = null;

      processedBuffer = Buffer.isBuffer(convertedArrayBuffer)
        ? convertedArrayBuffer
        : Buffer.from(convertedArrayBuffer);
      isConvertedFromHeic = true;
    } catch (error) {
      return {
        isValid: false,
        errorCode: IMAGE_ERROR_CODES.CORRUPTED_IMAGE,
        message: `File ảnh HEIC/HEIF bị hỏng hoặc không thể giải mã: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { sizeBytes },
      };
    }
  }

  // 5. Giải mã metadata bằng Sharp để kiểm tra tính toàn vẹn (file hỏng sẽ văng lỗi tại đây)
  let metadata: Metadata;
  try {
    metadata = await sharp(processedBuffer, { failOn: 'error' }).metadata();
  } catch (error) {
    return {
      isValid: false,
      errorCode: IMAGE_ERROR_CODES.CORRUPTED_IMAGE,
      message: `File ảnh hỏng hoặc không đúng định dạng: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { sizeBytes },
    };
  }

  const { width, height, format } = metadata;

  // 6. Kiểm tra có kích thước hợp lệ không
  if (!width || !height) {
    return {
      isValid: false,
      errorCode: IMAGE_ERROR_CODES.CORRUPTED_IMAGE,
      message: 'Không thể xác định kích thước ảnh',
      metadata: { width, height, format, sizeBytes },
    };
  }

  // 7. Whitelist định dạng: chỉ chấp nhận 'jpeg', 'png', 'webp'
  // Chuẩn hóa định dạng ('jpg' -> 'jpeg')
  const normalizedFormat = format?.toLowerCase() === 'jpg' ? 'jpeg' : format?.toLowerCase();

  if (!normalizedFormat || !allowedFormats.includes(normalizedFormat)) {
    return {
      isValid: false,
      errorCode: IMAGE_ERROR_CODES.UNSUPPORTED_FORMAT,
      message: `Định dạng ảnh '${format || 'không xác định'}' không được hỗ trợ. Hệ thống chỉ chấp nhận định dạng JPEG, PNG, hoặc WebP (ảnh HEIC từ iPhone được hỗ trợ tự động chuyển đổi).`,
      metadata: {
        width,
        height,
        format,
        sizeBytes,
        aspectRatio: width / height,
      },
    };
  }

  // 8. Chặn ảnh dưới ngưỡng nhận diện (<100x100)
  if (width < minDimension || height < minDimension) {
    return {
      isValid: false,
      errorCode: IMAGE_ERROR_CODES.RESOLUTION_TOO_LOW,
      message: `Kích thước ảnh (${width}x${height}) dưới ngưỡng nhận diện tối thiểu (yêu cầu tối thiểu 100x100)`,
      metadata: {
        width,
        height,
        format: normalizedFormat,
        sizeBytes,
        aspectRatio: width / height,
      },
    };
  }

  // 9. Chấp nhận ảnh hợp lệ
  return {
    isValid: true,
    metadata: {
      width,
      height,
      format: normalizedFormat,
      sizeBytes,
      aspectRatio: width / height,
    },
    ...(isConvertedFromHeic ? { convertedBuffer: processedBuffer } : {}),
  };
}
