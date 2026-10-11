export * from './statusConfig.js';

import { STATUS_UI_CONFIG, StatusUIConfig } from './statusConfig.js';
import type { StudentStatus } from '@thanh-giuse/shared-types';

/**
 * Trả về cấu hình hiển thị và nút bấm theo trạng thái học sinh
 */
export function getStudentStatusUI(status: StudentStatus): StatusUIConfig {
  return STATUS_UI_CONFIG[status] || STATUS_UI_CONFIG.empty;
}

/**
 * Render HTML cho badge trạng thái
 */
export function renderStatusBadgeHTML(status: StudentStatus): string {
  const cfg = getStudentStatusUI(status);
  return `<span style="display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 9999px; font-size: 13px; font-weight: 600; background-color: ${cfg.badgeStyle.bg}; color: ${cfg.badgeStyle.text}; border: 1px solid ${cfg.badgeStyle.border};">
    <span>${cfg.dotEmoji}</span>
    <span>${cfg.label}</span>
  </span>`;
}
