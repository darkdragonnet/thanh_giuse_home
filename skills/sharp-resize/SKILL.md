---
name: sharp-resize
description: Xử lý và chuẩn hóa ảnh học sinh về kích thước 1280x736 cho HANET Cloud mà không gây OOM.
---

# SKILL: Chuẩn hóa Ảnh Bằng Sharp (Anti-OOM)

## 1. Mục đích
Resize ảnh học sinh từ file tải lên về đúng kích thước chuẩn **1280×736** (tỉ lệ chuẩn nhận diện của camera HANET), format JPEG chất lượng 85, và giải phóng bộ nhớ RAM ngay lập tức.

## 2. Ràng buộc Kỹ thuật
* Worker RAM limit: 768MB, chạy tuần tự `concurrency: 1`.
* Sharp có thể spike RAM 200MB–400MB nếu giải nén ảnh gốc 4K/8K. Bắt buộc giới hạn `limitInputPixels`.

## 3. Mã Nguồn Mẫu (TypeScript)

```typescript
import sharp from 'sharp';
import fs from 'node:fs/promises';

export async function processImageForHanet(inputPath: string, outputPath: string): Promise<{ width: number; height: number; size: number }> {
  // 1. Giới hạn số lượng điểm ảnh đầu vào tối đa (tương đương Full HD 1920x1080)
  const imageBuffer = await sharp(inputPath, {
    limitInputPixels: 1920 * 1080,
    failOn: 'error'
  })
    .rotate() // Tự động xoay đúng chiều theo thông số EXIF của camera điện thoại
    .resize(1280, 736, {
      fit: 'cover',
      position: 'center',
      withoutEnlargement: false
    })
    .jpeg({
      quality: 85,
      mozjpeg: true
    })
    .toBuffer();

  // 2. Ghi ra file ảnh chuẩn
  await fs.writeFile(outputPath, imageBuffer);

  // 3. Kích hoạt Garbage Collection nếu Node được chạy với cờ --expose-gc
  if (global.gc) {
    global.gc();
  }

  return {
    width: 1280,
    height: 736,
    size: imageBuffer.length
  };
}
```

## 4. Checklist Kiểm chứng
- [ ] Kích thước đầu ra đúng chuẩn 1280x736.
- [ ] Đã bật `.rotate()` để xử lý ảnh chụp dọc của điện thoại.
- [ ] Đã đặt `limitInputPixels` để chặn ảnh độc hại/quá khổ.
- [ ] Bộ nhớ được giải phóng trước khi bắt đầu request tiếp theo.
