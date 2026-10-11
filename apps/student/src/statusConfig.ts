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
 * - empty (⚪ Xám): Nút chính: Đăng ký | Nút phụ: Ẩn.
 * - pending (🟡 Vàng): Nút chính: Disabled ("Đang xử lý...") | Nút phụ: Gửi admin.
 * - success (🟢 Xanh lục): Nút chính: Cập nhật hình | Nút phụ: Gửi admin.
 * - error (🔴 Đỏ): Nút chính: Disabled | Nút phụ: Gửi admin.
 * - manual_review (🟠 Cam): Nút chính: Disabled ("Chờ duyệt") | Nút phụ: Gửi admin.
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
      text: 'Đăng ký',
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
      text: 'Đã xảy ra lỗi',
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
    label: 'Chờ duyệt',
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
