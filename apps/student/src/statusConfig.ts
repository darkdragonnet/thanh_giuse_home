import type { StudentStatus } from '@thanh-giuse/shared-types';

export interface StatusUIConfig {
  label: string;
  dotEmoji: string;
  colorName: string;
  badgeStyle: {
    bg: string;
    text: string;
    border: string;
  };
  primaryButton: {
    text: string;
    disabled: boolean;
    action: 'REGISTER' | 'UPDATE_PHOTO' | 'NONE';
  };
  secondaryButton: {
    visible: boolean;
    text: string;
    action: 'CONTACT_ADMIN' | 'NONE';
  };
}

/**
 * Ma trận hiển thị trạng thái và nút bấm theo chuẩn đặc tả UI Student:
 * - empty (⚪ Xám): Nút chính: Đăng ký ngay | Nút phụ: Ẩn.
 * - pending (🟡 Vàng): Nút chính: Disabled ("Đang xử lý...") | Nút phụ: Gửi admin.
 * - success / synced (🟢 Xanh lục):
 *   + Học sinh (không có PIN): Nút chính: Disabled ("Đã hoàn tất đăng ký") | Nút phụ: Yêu cầu đổi ảnh (Gửi Admin).
 *   + Giáo viên (có PIN hợp lệ): Nút chính: Enabled ("Cập nhật hình") | Nút phụ: Gửi admin.
 * - error / failed_quota_exceeded (🔴 Đỏ): Nút chính: Enabled ("Thử đăng ký lại") | Nút phụ: Gửi admin.
 * - manual_review / conflict_pending_review (🟠 Cam): Nút chính: Enabled ("Nộp lại ảnh khác") | Nút phụ: Gửi admin.
 */
export const STATUS_UI_CONFIG: Record<StudentStatus, StatusUIConfig> = {
  empty: {
    label: 'Chưa nộp ảnh',
    dotEmoji: '⚪',
    colorName: 'Xám',
    badgeStyle: {
      bg: '#f3f4f6',
      text: '#4b5563',
      border: '#d1d5db',
    },
    primaryButton: {
      text: 'Đăng ký ngay',
      disabled: false,
      action: 'REGISTER',
    },
    secondaryButton: {
      visible: false,
      text: '',
      action: 'NONE',
    },
  },
  pending: {
    label: 'Đang xử lý',
    dotEmoji: '🟡',
    colorName: 'Vàng',
    badgeStyle: {
      bg: '#fef9c3',
      text: '#854d0e',
      border: '#facc15',
    },
    primaryButton: {
      text: 'Đang xử lý...',
      disabled: true,
      action: 'NONE',
    },
    secondaryButton: {
      visible: true,
      text: 'Gửi admin',
      action: 'CONTACT_ADMIN',
    },
  },
  success: {
    label: 'Đã hoàn tất',
    dotEmoji: '🟢',
    colorName: 'Xanh lục',
    badgeStyle: {
      bg: '#dcfce7',
      text: '#166534',
      border: '#86efac',
    },
    primaryButton: {
      text: 'Cập nhật hình',
      disabled: false,
      action: 'UPDATE_PHOTO',
    },
    secondaryButton: {
      visible: true,
      text: 'Gửi admin',
      action: 'CONTACT_ADMIN',
    },
  },
  synced: {
    label: 'Đã hoàn tất',
    dotEmoji: '🟢',
    colorName: 'Xanh lục',
    badgeStyle: {
      bg: '#dcfce7',
      text: '#166534',
      border: '#86efac',
    },
    primaryButton: {
      text: 'Cập nhật hình',
      disabled: false,
      action: 'UPDATE_PHOTO',
    },
    secondaryButton: {
      visible: true,
      text: 'Gửi admin',
      action: 'CONTACT_ADMIN',
    },
  },
  error: {
    label: 'Lỗi xử lý',
    dotEmoji: '🔴',
    colorName: 'Đỏ',
    badgeStyle: {
      bg: '#fee2e2',
      text: '#991b1b',
      border: '#fca5a5',
    },
    primaryButton: {
      text: 'Thử đăng ký lại',
      disabled: false,
      action: 'REGISTER',
    },
    secondaryButton: {
      visible: true,
      text: 'Gửi admin',
      action: 'CONTACT_ADMIN',
    },
  },
  failed_quota_exceeded: {
    label: 'Tạm khóa (Hết hạn mức)',
    dotEmoji: '🔴',
    colorName: 'Đỏ',
    badgeStyle: {
      bg: '#fee2e2',
      text: '#991b1b',
      border: '#fca5a5',
    },
    primaryButton: {
      text: 'Tạm ngưng nhận ảnh',
      disabled: true,
      action: 'NONE',
    },
    secondaryButton: {
      visible: true,
      text: 'Gửi admin',
      action: 'CONTACT_ADMIN',
    },
  },
  manual_review: {
    label: 'Cần chụp lại / Chờ duyệt',
    dotEmoji: '🟠',
    colorName: 'Cam',
    badgeStyle: {
      bg: '#ffedd5',
      text: '#9a3412',
      border: '#fdba74',
    },
    primaryButton: {
      text: 'Nộp lại ảnh khác',
      disabled: false,
      action: 'REGISTER',
    },
    secondaryButton: {
      visible: true,
      text: 'Gửi admin',
      action: 'CONTACT_ADMIN',
    },
  },
  conflict_pending_review: {
    label: 'Chờ duyệt xung đột',
    dotEmoji: '🟠',
    colorName: 'Cam',
    badgeStyle: {
      bg: '#ffedd5',
      text: '#9a3412',
      border: '#fdba74',
    },
    primaryButton: {
      text: 'Chờ duyệt',
      disabled: true,
      action: 'NONE',
    },
    secondaryButton: {
      visible: true,
      text: 'Gửi admin',
      action: 'CONTACT_ADMIN',
    },
  },
};

export function resolveStudentStatusConfig(
  status: StudentStatus,
  isTeacherVerified = false
): StatusUIConfig {
  const base = STATUS_UI_CONFIG[status] || STATUS_UI_CONFIG.empty;
  if ((status === 'success' || status === 'synced') && !isTeacherVerified) {
    return {
      ...base,
      primaryButton: {
        text: 'Đã hoàn tất đăng ký',
        disabled: true,
        action: 'NONE',
      },
      secondaryButton: {
        visible: true,
        text: 'Yêu cầu đổi ảnh (Gửi Admin)',
        action: 'CONTACT_ADMIN',
      },
    };
  }
  return base;
}
