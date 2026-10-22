export type HanetAction =
  | 'SUCCESS'             // Xử lý thành công (returnCode: 1)
  | 'RETRY_LATER'         // Lỗi tạm thời phía máy chủ (-503), đẩy lùi để BullMQ thử lại sau 300s
  | 'QUARANTINE_MANUAL'   // Lỗi khuôn mặt (-9006, -9007), cần chuyển sang manual_review
  | 'QUOTA_EXCEEDED'      // Hết hạn mức lưu trữ Face ID (-9008), thông báo Admin
  | 'SYSTEM_TOKEN_EXPIRED' // Token hết hạn (-103, -401), kích hoạt Kill Switch
  | 'FATAL_INVALID_DATA'  // Dữ liệu đầu vào sai cấu trúc (-1, -9002)
  | 'NOT_FOUND'           // Không tìm thấy thực thể (-5011)
  | 'ALREADY_EXISTS'      // Nhân sự hoặc khuôn mặt đã tồn tại (-9005)
  | 'UNKNOWN_ERROR';      // Các mã lỗi ngoại lệ khác

export interface HanetErrorEvaluation {
  returnCode: number;
  returnMessage: string;
  action: HanetAction;
  isRetryable: boolean;
  suggestedBackoffMs?: number | undefined;
  userFacingMessage: string;
}

export const HANET_ERROR_MAP: Record<number, Omit<HanetErrorEvaluation, 'returnCode' | 'returnMessage'>> = {
  1: {
    action: 'SUCCESS',
    isRetryable: false,
    userFacingMessage: 'Thao tác thành công.'
  },
  '-1': {
    action: 'FATAL_INVALID_DATA',
    isRetryable: false,
    userFacingMessage: 'Dữ liệu gửi lên không hợp lệ hoặc thiếu thông tin bắt buộc.'
  },
  '-103': {
    action: 'SYSTEM_TOKEN_EXPIRED',
    isRetryable: false,
    userFacingMessage: 'Phiên xác thực đã hết hạn, vui lòng thử lại sau.'
  },
  '-400': {
    action: 'QUARANTINE_MANUAL',
    isRetryable: false,
    userFacingMessage: 'Dữ liệu hoặc ảnh gửi lên HANET Cloud không hợp lệ, chuyển sang diện kiểm tra thủ công.'
  },
  '-401': {
    action: 'SYSTEM_TOKEN_EXPIRED',
    isRetryable: false,
    userFacingMessage: 'Phiên xác thực đã hết hạn, vui lòng thử lại sau.'
  },
  '-404': {
    action: 'FATAL_INVALID_DATA',
    isRetryable: false,
    userFacingMessage: 'Đường dẫn hoặc phương thức gọi API không được hỗ trợ.'
  },
  '-429': {
    action: 'RETRY_LATER',
    isRetryable: true,
    suggestedBackoffMs: 15_000,
    userFacingMessage: 'Vượt quá tần suất yêu cầu tới máy chủ nhận diện, đang thử lại sau giây lát.'
  },
  '-503': {
    action: 'RETRY_LATER',
    isRetryable: true,
    suggestedBackoffMs: 300_000, // 5 phút (300 giây) theo kiến trúc
    userFacingMessage: 'Hệ thống nhận diện đang quá tải, yêu cầu sẽ được tự động xử lý lại sau.'
  },
  '-909': {
    action: 'RETRY_LATER',
    isRetryable: true,
    suggestedBackoffMs: 10_000,
    userFacingMessage: 'Lỗi tải ảnh lên hệ thống, vui lòng thử lại.'
  },
  '-2035': {
    action: 'FATAL_INVALID_DATA',
    isRetryable: false,
    userFacingMessage: 'Tài khoản không có quyền thao tác trên tài nguyên này.'
  },
  '-5001': {
    action: 'RETRY_LATER',
    isRetryable: true,
    suggestedBackoffMs: 5000,
    userFacingMessage: 'Lỗi truy xuất danh sách khuôn mặt quen thuộc.'
  },
  '-5002': {
    action: 'RETRY_LATER',
    isRetryable: true,
    suggestedBackoffMs: 5000,
    userFacingMessage: 'Lỗi truy xuất danh sách khuôn mặt lạ.'
  },
  '-5003': {
    action: 'RETRY_LATER',
    isRetryable: true,
    suggestedBackoffMs: 5000,
    userFacingMessage: 'Lỗi truy xuất thông tin nhân sự.'
  },
  '-5011': {
    action: 'NOT_FOUND',
    isRetryable: false,
    userFacingMessage: 'Không tìm thấy thông tin nhân sự tương ứng.'
  },
  '-9002': {
    action: 'FATAL_INVALID_DATA',
    isRetryable: false,
    userFacingMessage: 'Định dạng file ảnh không được hỗ trợ (chỉ nhận JPG, JPEG, PNG).'
  },
  '-9003': {
    action: 'RETRY_LATER',
    isRetryable: true,
    suggestedBackoffMs: 15000,
    userFacingMessage: 'Lỗi máy chủ khi tạo mới hồ sơ học sinh.'
  },
  '-9004': {
    action: 'FATAL_INVALID_DATA',
    isRetryable: false,
    userFacingMessage: 'Lỗi khi xóa nhân sự trên hệ thống.'
  },
  '-9005': {
    action: 'ALREADY_EXISTS',
    isRetryable: false,
    userFacingMessage: 'Học sinh hoặc khuôn mặt này đã tồn tại trên hệ thống.'
  },
  '-9006': {
    action: 'QUARANTINE_MANUAL',
    isRetryable: false,
    userFacingMessage: 'Ảnh không đạt chuẩn (cần thấy rõ mặt, nhìn thẳng, không đeo kính râm hoặc khẩu trang).'
  },
  '-9007': {
    action: 'QUARANTINE_MANUAL',
    isRetryable: false,
    userFacingMessage: 'Khuôn mặt trong ảnh bị trùng lặp với một người khác đã đăng ký.'
  },
  '-9008': {
    action: 'QUOTA_EXCEEDED',
    isRetryable: false,
    userFacingMessage: 'Hệ thống đã hết hạn mức lưu trữ Face ID, vui lòng liên hệ ban quản trị.'
  }
};

export function evaluateHanetError(returnCode: number, returnMessage = ''): HanetErrorEvaluation {
  const mapped = HANET_ERROR_MAP[returnCode];
  if (mapped) {
    return {
      returnCode,
      returnMessage,
      ...mapped
    };
  }

  return {
    returnCode,
    returnMessage: returnMessage || 'UNKNOWN_ERROR',
    action: 'UNKNOWN_ERROR',
    isRetryable: false,
    userFacingMessage: `Đã xảy ra lỗi không xác định từ hệ thống nhận diện (${returnCode}).`
  };
}
