/**
 * Utility nén ảnh qua Canvas tuân thủ FR-004 & Kiến trúc Monorepo
 * - Max dimension: 1920px (giữ nguyên tỉ lệ)
 * - Chất lượng ban đầu: JPEG 0.85
 * - Mục tiêu: < 800 KB
 * - Trần cứng kỹ thuật: < 1 MB (1.048.576 bytes)
 * - Vòng lặp nấc thang: giảm chất lượng và scale down cho đến khi đạt trần < 1MB
 */

export const MAX_SIDE_DEFAULT = 1920;
export const INITIAL_QUALITY_DEFAULT = 0.85;
export const TARGET_SIZE_BYTES_DEFAULT = 800 * 1024; // 800 KB
export const HARD_CEILING_BYTES_DEFAULT = 1024 * 1024; // 1 MB (1.048.576 bytes)
export const MIN_QUALITY_DEFAULT = 0.35;
export const MIN_DIMENSION_DEFAULT = 640;

export interface CompressionOptions {
  maxSide?: number;
  initialQuality?: number;
  hardCeilingBytes?: number;
  minQuality?: number;
  minDimension?: number;
  encoder?: CanvasBlobEncoder;
}

export interface CompressionResult {
  blob: Blob;
  width: number;
  height: number;
  sizeBytes: number;
  quality: number;
}

export type CanvasBlobEncoder = (
  canvas: any,
  quality: number,
  mimeType?: string
) => Promise<Blob | null>;

/**
 * Encoder mặc định trên trình duyệt (sử dụng canvas.toBlob)
 */
export const defaultCanvasEncoder: CanvasBlobEncoder = (
  canvas: any,
  quality: number,
  mimeType = 'image/jpeg'
): Promise<Blob | null> => {
  return new Promise((resolve) => {
    if (typeof canvas?.toBlob === 'function') {
      canvas.toBlob((blob: Blob | null) => resolve(blob), mimeType, quality);
    } else {
      resolve(null);
    }
  });
};

/**
 * Tính toán kích thước mới bảo toàn tỉ lệ khung hình theo maxSide
 */
export function calculateTargetDimensions(
  srcWidth: number,
  srcHeight: number,
  maxSide: number
): { width: number; height: number } {
  let width = srcWidth;
  let height = srcHeight;

  if (width > maxSide || height > maxSide) {
    if (width >= height) {
      height = Math.round((height * maxSide) / width);
      width = maxSide;
    } else {
      width = Math.round((width * maxSide) / height);
      height = maxSide;
    }
  }

  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/**
 * Nén canvas theo thuật toán vòng lặp nấc thang bảo đảm trần cứng < 1MB
 */
export async function compressCanvasWithCeiling(
  canvas: any,
  initialWidth: number,
  initialHeight: number,
  options: CompressionOptions = {}
): Promise<CompressionResult> {
  const {
    initialQuality = INITIAL_QUALITY_DEFAULT,
    hardCeilingBytes = HARD_CEILING_BYTES_DEFAULT,
    minQuality = MIN_QUALITY_DEFAULT,
    minDimension = MIN_DIMENSION_DEFAULT,
    encoder = defaultCanvasEncoder,
  } = options;

  let currentWidth = initialWidth;
  let currentHeight = initialHeight;
  let quality = initialQuality;

  // Bước 1: Thử nén ở chất lượng ban đầu
  let blob = await encoder(canvas, quality, 'image/jpeg');
  if (!blob) {
    throw new Error('Lỗi khi nén ảnh chân dung qua Canvas. Trình duyệt không thể xuất Blob.');
  }

  // Bước 2: Nếu vượt trần cứng < 1MB, giảm chất lượng từng nấc (0.1 mỗi bước)
  while (blob.size > hardCeilingBytes && quality > minQuality) {
    quality = Math.max(minQuality, Math.round((quality - 0.1) * 100) / 100);
    const newBlob = await encoder(canvas, quality, 'image/jpeg');
    if (newBlob) {
      blob = newBlob;
    }
  }

  // Bước 3: Nếu chất lượng đã xuống sàn (minQuality) mà dung lượng vẫn > 1MB, scale down kích thước
  while (blob.size > hardCeilingBytes && Math.max(currentWidth, currentHeight) > minDimension) {
    currentWidth = Math.round(currentWidth * 0.8);
    currentHeight = Math.round(currentHeight * 0.8);

    if (typeof canvas.getContext === 'function' && typeof document !== 'undefined') {
      const scaledCanvas = document.createElement('canvas');
      scaledCanvas.width = currentWidth;
      scaledCanvas.height = currentHeight;
      const ctx = scaledCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(canvas, 0, 0, currentWidth, currentHeight);
        canvas = scaledCanvas;
      }
    }

    const newBlob = await encoder(canvas, quality, 'image/jpeg');
    if (newBlob) {
      blob = newBlob;
    }
  }

  // Bước 4: Kiểm tra chốt chặn trần cứng cuối cùng
  if (blob.size > hardCeilingBytes) {
    throw new Error(
      `Ảnh có dung lượng quá lớn (${Math.round(
        blob.size / 1024
      )} KB), vượt quá trần kỹ thuật 1 MB sau khi đã nén tối đa. Vui lòng chọn ảnh khác nhẹ hơn.`
    );
  }

  return {
    blob,
    width: currentWidth,
    height: currentHeight,
    sizeBytes: blob.size,
    quality,
  };
}
