import { Pool } from 'pg';

export class SettingsRepository {
  constructor(private readonly db: Pool) {}

  public async getSetting(key: string): Promise<string | null> {
    const res = await this.db.query('SELECT value FROM settings WHERE key = $1', [key]);
    return res.rows[0]?.value || null;
  }

  public async get(key: string): Promise<string | null> {
    return this.getSetting(key);
  }

  public async isRegistrationEnabled(): Promise<boolean> {
    const value = await this.getSetting('registration_enabled');
    // Mặc định là true nếu chưa cấu hình
    return value === null || value.toLowerCase() === 'true';
  }

  public async setRegistrationEnabled(enabled: boolean): Promise<void> {
    const query = `
      INSERT INTO settings (key, value) 
      VALUES ('registration_enabled', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
    `;
    await this.db.query(query, [String(enabled)]);
  }

  public async setSetting(key: string, value: string): Promise<void> {
    const query = `
      INSERT INTO settings (key, value) 
      VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
    `;
    await this.db.query(query, [key, value]);
  }

  public async set(key: string, value: string): Promise<void> {
    return this.setSetting(key, value);
  }
}
