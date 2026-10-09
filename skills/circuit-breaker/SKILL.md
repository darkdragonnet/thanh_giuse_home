---
name: circuit-breaker
description: Cơ chế ngắt mạch Circuit Breaker tự động bảo vệ hệ thống khi HANET Cloud bị lỗi 503 hoặc quá tải.
---

# SKILL: Circuit Breaker Cho HANET Cloud API

## 1. Mục đích
Khi HANET Cloud gặp sự cố quá tải và trả về mã `-503 SYSTEM_ERROR`, hệ thống sẽ tạm dừng gửi request thay vì liên tục dội tải làm nghẽn worker và hàng đợi.

## 2. Mã Triển Khai (TypeScript)

```typescript
export class HanetCircuitBreaker {
  private failures = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private openedAt = 0;
  private readonly threshold = 5;       // 5 lỗi liên tiếp sẽ kích hoạt OPEN
  private readonly cooldownMs = 300000; // 5 phút nghỉ (300.000 ms)

  async execute<T>(action: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt > this.cooldownMs) {
        this.state = 'HALF_OPEN';
      } else {
        const error: any = new Error('HANET Cloud hiện đang quá tải. Đang trong chế độ ngắt mạch.');
        error.code = 'CIRCUIT_BREAKER_OPEN';
        throw error;
      }
    }

    try {
      const result = await action();
      this.onSuccess();
      return result;
    } catch (err: any) {
      this.onFailure(err);
      throw err;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private onFailure(err: any) {
    if (err.responseCode === -503 || err.code === 'ECONNRESET') {
      this.failures++;
      if (this.failures >= this.threshold) {
        this.state = 'OPEN';
        this.openedAt = Date.now();
        console.error(`[CIRCUIT BREAKER] Đã ngắt mạch do 5 lỗi liên tiếp. Tạm dừng 5 phút.`);
      }
    }
  }
}
```

## 3. Checklist Kiểm chứng
- [ ] Chuyển sang trạng thái `OPEN` khi đủ 5 lỗi `-503`.
- [ ] Tự động chuyển `HALF_OPEN` sau 300 giây.
- [ ] Phục hồi về `CLOSED` ngay khi có 1 request gọi thử nghiệm thành công.
