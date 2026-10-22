/**
 * Utility hỗ trợ quy trình chụp ảnh hàng loạt cho Giáo viên (Batch Photography Workflow)
 * Tuân thủ US2: Tự động chuyển học sinh tiếp theo chưa có ảnh, ưu tiên 'empty' rồi 'error'.
 */

export interface StudentBatchItem {
  id: number;
  name: string;
  status: string;
  alias_id?: string | null;
  [key: string]: any;
}

export interface BatchProgressStats {
  total: number;
  completed: number;
  pending: number;
  remaining: number;
  progressPercent: number;
}

/**
 * Tính toán tiến độ chụp ảnh của lớp học
 */
export function calculateBatchProgress(students: StudentBatchItem[]): BatchProgressStats {
  if (!Array.isArray(students) || students.length === 0) {
    return {
      total: 0,
      completed: 0,
      pending: 0,
      remaining: 0,
      progressPercent: 0,
    };
  }

  const total = students.length;
  const completed = students.filter((s) => s.status === 'success' || s.status === 'synced').length;
  const pending = students.filter((s) => s.status === 'pending').length;
  const remaining = students.filter((s) => s.status === 'empty' || s.status === 'error').length;
  const progressPercent = total > 0 ? Math.round(((completed + pending) / total) * 100) : 0;

  return {
    total,
    completed,
    pending,
    remaining,
    progressPercent,
  };
}

/**
 * Tìm học sinh tiếp theo cần chụp ảnh trong lớp:
 * - Ưu tiên 1: học sinh ở trạng thái 'empty' (chưa nộp ảnh bao giờ).
 * - Ưu tiên 2: học sinh ở trạng thái 'error' (ảnh bị lỗi cần chụp lại).
 * - Bắt đầu quét từ vị trí sau currentStudentId trong danh sách (vòng tròn).
 * - Trả về null nếu toàn bộ học sinh đều đã nộp (hoặc đang xử lý / manual_review).
 */
export function findNextStudentForBatch(
  students: StudentBatchItem[],
  currentStudentId?: number
): StudentBatchItem | null {
  if (!Array.isArray(students) || students.length === 0) {
    return null;
  }

  const currentIndex = currentStudentId
    ? students.findIndex((s) => s.id === currentStudentId)
    : -1;

  // Sắp xếp danh sách duyệt xoay vòng từ sau vị trí học sinh hiện tại
  const orderedList: StudentBatchItem[] = [];
  if (currentIndex >= 0 && currentIndex < students.length - 1) {
    orderedList.push(...students.slice(currentIndex + 1));
    orderedList.push(...students.slice(0, currentIndex + 1));
  } else {
    orderedList.push(...students);
  }

  // 1. Quét tìm học sinh 'empty' (ưu tiên cao nhất)
  const emptyStudent = orderedList.find(
    (s) => s.status === 'empty' && s.id !== currentStudentId
  );
  if (emptyStudent) {
    return emptyStudent;
  }

  // 2. Quét tìm học sinh 'error' (cần chụp lại)
  const errorStudent = orderedList.find(
    (s) => s.status === 'error' && s.id !== currentStudentId
  );
  if (errorStudent) {
    return errorStudent;
  }

  return null;
}
