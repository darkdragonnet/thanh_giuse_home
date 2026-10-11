import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

// ═══ TUÂN THỦ HIẾN PHÁP BỘ NHỚ (VPS 3GB RAM) ═══
// Tắt hoàn toàn cache của libvips để giải phóng RAM ngay sau mỗi ảnh
sharp.cache(false);
// Cố định 1 luồng xử lý ảnh đơn lẻ khớp với Worker Concurrency = 1
sharp.concurrency(1);

export interface ProcessedImageResult {
  buffer: Buffer;
  outputPath: string;
  filename: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/**
 * Tiền xử lý ảnh khuôn mặt theo chuẩn HANET Cloud:
 * - Kích thước: 1280 × 736 (Tỉ lệ chuẩn HANET nhận diện tối ưu)
 * - Định dạng: JPEG chất lượng 85
 * - Xuất file vào tmp-faces để phục vụ Nginx và trả về buffer
 */
export async function processFaceImage(
  inputPath: string,
  tmpFacesDir: string,
  aliasId: string
): Promise<ProcessedImageResult> {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`File ảnh đầu vào không tồn tại: ${inputPath}`);
  }

  if (!fs.existsSync(tmpFacesDir)) {
    fs.mkdirSync(tmpFacesDir, { recursive: true });
  }

  const outputFilename = `face_${aliasId}_${Date.now()}.jpg`;
  const outputPath = path.join(tmpFacesDir, outputFilename);

  // Resize về chuẩn 1280x736, chất lượng 85
  const buffer = await sharp(inputPath)
    .resize(1280, 736, {
      fit: 'cover',
      position: 'center',
    })
    .jpeg({
      quality: 85,
      progressive: true,
      mozjpeg: true,
    })
    .toBuffer();

  // Ghi file ra thư mục chia sẻ tmp-faces
  await fs.promises.writeFile(outputPath, buffer);

  return {
    buffer,
    outputPath,
    filename: outputFilename,
    width: 1280,
    height: 736,
    sizeBytes: buffer.length,
  };
}
