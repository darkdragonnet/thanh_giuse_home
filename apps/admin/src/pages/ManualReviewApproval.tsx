import React, { useState, useEffect } from 'react';
import { apiClient } from '../api/client';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertCircle, RefreshCw, KeyRound, CheckCircle2, Search, Filter } from 'lucide-react';
import { format, parseISO } from 'date-fns';

export interface ManualReviewStudent {
  id: number;
  alias_id: string;
  name: string;
  class_code: string;
  status: string;
  retry_count: number;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
}

export const ManualReviewApproval: React.FC = () => {
  const [students, setStudents] = useState<ManualReviewStudent[]>([]);
  const [loading, setLoading] = useState(false);
  const [classFilter, setClassFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedStudent, setSelectedStudent] = useState<ManualReviewStudent | null>(null);
  const [targetStatus, setTargetStatus] = useState<'empty' | 'error'>('empty');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const fetchManualReviewStudents = async () => {
    try {
      setLoading(true);
      const res = await apiClient.get<ManualReviewStudent[]>('/students/manual-review', {
        class_code: classFilter.trim() || undefined,
      });
      // Endpoint trả về array trực tiếp theo contract admin-api.yaml
      if (Array.isArray(res)) {
        setStudents(res);
      } else {
        setStudents([]);
      }
    } catch (err: any) {
      console.error('Lỗi tải danh sách rà soát thủ công:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchManualReviewStudents();
  }, [classFilter]);

  const handleOpenUnlock = (student: ManualReviewStudent) => {
    setSelectedStudent(student);
    setTargetStatus('empty');
    setNote('');
  };

  const handleConfirmUnlock = async () => {
    if (!selectedStudent) return;
    try {
      setSubmitting(true);
      const res = await apiClient.post<{
        success: boolean;
        student_id: number;
        previous_status: string;
        current_status: string;
        message: string;
      }>(`/students/${selectedStudent.id}/unlock`, {
        target_status: targetStatus,
        note: note.trim() || undefined,
      });

      if (res.success) {
        setSuccessMessage(`Đã mở khóa học sinh "${selectedStudent.name}" thành trạng thái "${targetStatus}".`);
        setTimeout(() => setSuccessMessage(null), 4000);
        setSelectedStudent(null);
        await fetchManualReviewStudents();
      }
    } catch (err: any) {
      alert(err.message || 'Không thể mở khóa hồ sơ');
    } finally {
      setSubmitting(false);
    }
  };

  const filteredStudents = students.filter((s) => {
    if (!search.trim()) return true;
    const term = search.toLowerCase();
    return (
      s.name.toLowerCase().includes(term) ||
      (s.alias_id && s.alias_id.toLowerCase().includes(term)) ||
      (s.last_error_code && s.last_error_code.toLowerCase().includes(term)) ||
      (s.last_error_message && s.last_error_message.toLowerCase().includes(term))
    );
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-bold text-gray-900">Rà soát Thủ công (Manual Review)</h3>
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-800">
              {students.length} hồ sơ cần xử lý
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Danh sách hồ sơ học sinh bị cách ly (manual_review) do lỗi liên tiếp hoặc ảnh không đạt chuẩn. Admin có thể mở khóa đưa về empty hoặc error.
          </p>
        </div>

        <button
          onClick={fetchManualReviewStudents}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 shadow-sm disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Làm mới
        </button>
      </div>

      {/* Success Notification */}
      {successMessage && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-medium text-emerald-800">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-64">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Tìm tên, Alias, mã lỗi..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-gray-300 pl-9 pr-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Lọc mã lớp (VD: 10A2)..."
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              className="w-44 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-100 bg-gray-50/75 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3">Học sinh</th>
              <th className="px-4 py-3">AliasID</th>
              <th className="px-4 py-3">Lớp</th>
              <th className="px-4 py-3">Mã lỗi</th>
              <th className="px-4 py-3">Nội dung lỗi</th>
              <th className="px-4 py-3">Số lần thử</th>
              <th className="px-4 py-3">Thời gian</th>
              <th className="px-4 py-3 text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 text-xs">
            {filteredStudents.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-gray-400">
                  <AlertCircle className="mx-auto h-8 w-8 stroke-1 text-gray-300" />
                  <p className="mt-2 text-sm font-medium">Hiện không có hồ sơ nào cần rà soát thủ công.</p>
                </td>
              </tr>
            ) : (
              filteredStudents.map((st) => (
                <tr key={st.id} className="hover:bg-gray-50/50">
                  <td className="px-4 py-3 font-semibold text-gray-900">{st.name}</td>
                  <td className="px-4 py-3 font-mono font-bold text-gray-800">{st.alias_id || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{st.class_code || '—'}</td>
                  <td className="px-4 py-3">
                    <span className="rounded bg-rose-50 px-2 py-0.5 font-mono font-bold text-rose-700 border border-rose-200">
                      {st.last_error_code || 'N/A'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 max-w-xs truncate" title={st.last_error_message || ''}>
                    {st.last_error_message || '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-600 font-mono">{st.retry_count}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {st.created_at ? format(parseISO(st.created_at), 'HH:mm dd/MM') : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleOpenUnlock(st)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 border border-blue-200 transition"
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      Mở khóa
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Unlock Action Dialog */}
      <Dialog.Root open={!!selectedStudent} onOpenChange={(open) => !open && setSelectedStudent(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-2xl">
            <div className="flex items-center gap-3 text-blue-600">
              <KeyRound className="h-6 w-6 shrink-0" />
              <Dialog.Title className="text-lg font-bold text-gray-900">
                Mở khóa hồ sơ học sinh
              </Dialog.Title>
            </div>

            <Dialog.Description className="mt-2 text-xs text-gray-500">
              Giải phóng hồ sơ học sinh <span className="font-bold text-gray-800">{selectedStudent?.name}</span> ({selectedStudent?.alias_id}) khỏi trạng thái cách ly manual_review.
            </Dialog.Description>

            <div className="mt-4 space-y-4">
              {/* Chọn target_status */}
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1.5">
                  Trạng thái chuyển tiếp (target_status)
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label
                    className={`flex cursor-pointer flex-col rounded-lg border p-3 text-xs transition ${
                      targetStatus === 'empty'
                        ? 'border-blue-500 bg-blue-50/50 text-blue-900'
                        : 'border-gray-200 hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <input
                      type="radio"
                      name="target_status"
                      value="empty"
                      checked={targetStatus === 'empty'}
                      onChange={() => setTargetStatus('empty')}
                      className="sr-only"
                    />
                    <span className="font-bold">empty (Mặc định)</span>
                    <span className="mt-1 text-[11px] text-gray-500">
                      Cho phép chụp/nộp lại ảnh mới từ đầu.
                    </span>
                  </label>

                  <label
                    className={`flex cursor-pointer flex-col rounded-lg border p-3 text-xs transition ${
                      targetStatus === 'error'
                        ? 'border-rose-500 bg-rose-50/50 text-rose-900'
                        : 'border-gray-200 hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <input
                      type="radio"
                      name="target_status"
                      value="error"
                      checked={targetStatus === 'error'}
                      onChange={() => setTargetStatus('error')}
                      className="sr-only"
                    />
                    <span className="font-bold">error</span>
                    <span className="mt-1 text-[11px] text-gray-500">
                      Đánh dấu lỗi hồ sơ cần can thiệp khác.
                    </span>
                  </label>
                </div>
              </div>

              {/* Ghi chú note */}
              <div>
                <label className="block text-xs font-bold text-gray-700 mb-1">
                  Ghi chú hành động (Lưu vào Nhật ký Audit Log)
                </label>
                <textarea
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Ví dụ: Đã xác nhận với GVCN cho phép học sinh chụp lại ảnh mới..."
                  className="w-full rounded-lg border border-gray-300 p-2.5 text-xs text-gray-900 focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setSelectedStudent(null)}
                disabled={submitting}
                className="rounded-lg bg-gray-100 px-4 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-200"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={handleConfirmUnlock}
                disabled={submitting}
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? 'Đang xử lý...' : 'Xác nhận mở khóa'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
};
