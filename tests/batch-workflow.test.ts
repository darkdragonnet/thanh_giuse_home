import { describe, it, expect } from 'vitest';
import {
  calculateBatchProgress,
  findNextStudentForBatch,
  StudentBatchItem,
} from '../apps/student/src/utils/batchWorkflow.js';

describe('Batch Workflow Utility (US2 - Teacher Bulk Photo Capture)', () => {
  describe('calculateBatchProgress', () => {
    it('handles empty or invalid student arrays', () => {
      expect(calculateBatchProgress([])).toEqual({
        total: 0,
        completed: 0,
        pending: 0,
        remaining: 0,
        progressPercent: 0,
      });

      expect(calculateBatchProgress(null as unknown as StudentBatchItem[])).toEqual({
        total: 0,
        completed: 0,
        pending: 0,
        remaining: 0,
        progressPercent: 0,
      });
    });

    it('calculates correct statistics for a mixed class roster', () => {
      const students: StudentBatchItem[] = [
        { id: 1, name: 'Nguyễn Văn A', status: 'success' },
        { id: 2, name: 'Trần Thị B', status: 'synced' },
        { id: 3, name: 'Lê Văn C', status: 'pending' },
        { id: 4, name: 'Phạm Thị D', status: 'empty' },
        { id: 5, name: 'Vũ Văn E', status: 'error' },
        { id: 6, name: 'Hoàng Thị F', status: 'manual_review' },
      ];

      const stats = calculateBatchProgress(students);
      expect(stats.total).toBe(6);
      expect(stats.completed).toBe(2); // success + synced
      expect(stats.pending).toBe(1); // pending
      expect(stats.remaining).toBe(2); // empty + error
      // 3 out of 6 are completed/pending => 50%
      expect(stats.progressPercent).toBe(50);
    });
  });

  describe('findNextStudentForBatch', () => {
    const students: StudentBatchItem[] = [
      { id: 1, name: 'Học sinh 1', status: 'success' },
      { id: 2, name: 'Học sinh 2', status: 'error' },
      { id: 3, name: 'Học sinh 3', status: 'empty' },
      { id: 4, name: 'Học sinh 4', status: 'success' },
      { id: 5, name: 'Học sinh 5', status: 'empty' },
    ];

    it('prioritizes "empty" status starting after current student index', () => {
      // Đang ở học sinh 1 -> duyệt tiếp: 2(error), 3(empty), 4(success), 5(empty)
      // Ưu tiên số 1 là 'empty' kế tiếp -> ID 3
      const next = findNextStudentForBatch(students, 1);
      expect(next).not.toBeNull();
      expect(next?.id).toBe(3);
    });

    it('wraps around to the beginning if next empty is before current index', () => {
      // Đang ở học sinh 5 -> sau nó hết rồi, quay vòng về đầu: 1(success), 2(error), 3(empty), 4(success)
      // Ưu tiên 'empty' -> ID 3
      const next = findNextStudentForBatch(students, 5);
      expect(next).not.toBeNull();
      expect(next?.id).toBe(3);
    });

    it('falls back to "error" status if no "empty" students remain', () => {
      const roster: StudentBatchItem[] = [
        { id: 10, name: 'A', status: 'success' },
        { id: 20, name: 'B', status: 'error' },
        { id: 30, name: 'C', status: 'success' },
        { id: 40, name: 'D', status: 'error' },
      ];

      // Đang ở học sinh 20 -> kế tiếp tìm empty (không có) -> tìm error sau 20: 40
      const next = findNextStudentForBatch(roster, 20);
      expect(next).not.toBeNull();
      expect(next?.id).toBe(40);

      // Đang ở 40 -> tìm error sau 40 (quay vòng về trước): 20
      const nextWrap = findNextStudentForBatch(roster, 40);
      expect(nextWrap).not.toBeNull();
      expect(nextWrap?.id).toBe(20);
    });

    it('returns null when all students have completed or pending photos', () => {
      const allDone: StudentBatchItem[] = [
        { id: 100, name: 'X', status: 'success' },
        { id: 101, name: 'Y', status: 'synced' },
        { id: 102, name: 'Z', status: 'pending' },
      ];

      const next = findNextStudentForBatch(allDone, 100);
      expect(next).toBeNull();
    });

    it('handles student not found in roster gracefully by scanning from start', () => {
      const next = findNextStudentForBatch(students, 9999);
      expect(next).not.toBeNull();
      expect(next?.id).toBe(3); // First empty in list
    });
  });
});
