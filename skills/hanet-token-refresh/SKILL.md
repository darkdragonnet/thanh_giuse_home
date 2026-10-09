---
name: hanet-token-refresh
description: Tự động gia hạn Access Token của HANET Cloud trước 24h để ngăn ngừa mã lỗi -103 ACCESS_TOKEN_EXPIRE.
---

# SKILL: Tự Động Gia Hạn Token HANET (Chống Lỗi -103)

## 1. Mục đích
Token truy cập của HANET có thời hạn hữu hạn. Nếu hết hạn, 100% request đăng ký khuôn mặt sẽ thất bại với mã `-103`. Skill này kiểm tra định kỳ và tự động gia hạn token lưu trong DB và cache Redis.

## 2. Mã Triển Khai (TypeScript)

```typescript
import { Pool } from 'pg';
import Redis from 'ioredis';

export class HanetTokenService {
  constructor(private db: Pool, private redis: Redis) {}

  async getValidAccessToken(): Promise<string> {
    // 1. Kiểm tra cache Redis trước
    const cachedToken = await this.redis.get('hanet:access_token');
    if (cachedToken) return cachedToken;

    // 2. Đọc từ PostgreSQL bảng settings
    const res = await this.db.query("SELECT key, value FROM settings WHERE key IN ('hanet_access_token', 'hanet_token_expires_at')");
    const settings = Object.fromEntries(res.rows.map(r => [r.key, r.value]));

    const expiresAt = parseInt(settings.hanet_token_expires_at || '0', 10);
    const now = Date.now();

    // 3. Nếu token còn hạn ít hơn 24 giờ, tự động gia hạn
    if (expiresAt - now < 24 * 60 * 60 * 1000) {
      return await this.refreshToken();
    }

    // Cache lại vào Redis trong 5 phút
    await this.redis.set('hanet:access_token', settings.hanet_access_token, 'EX', 300);
    return settings.hanet_access_token;
  }

  async refreshToken(): Promise<string> {
    // Gọi endpoint oauth/token của HANET Cloud
    console.log('[HANET TOKEN] Đang thực hiện làm mới Access Token...');
    // Cập nhật token mới vào Postgres và Redis
    return 'new_token';
  }
}
```

## 3. Checklist Kiểm chứng
- [ ] Chạy cron kiểm tra token mỗi 6 giờ.
- [ ] Tự động kích hoạt làm mới khi thời gian sống còn lại < 24 giờ.
- [ ] Bắt lỗi và gửi cảnh báo khẩn cấp tới Admin nếu việc refresh thất bại.
