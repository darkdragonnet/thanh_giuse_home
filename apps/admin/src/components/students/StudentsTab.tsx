import React, { useState, useEffect } from 'react';
import { apiClient } from '../../api/client';
import * as Dialog from '@radix-ui/react-dialog';
import { Search, Eye, Upload, RotateCcw } from 'lucide-react';

interface Student {
  id: number;
  class_id: number;
  class_code: string;
  name: string;
  alias_id: string;
  status: 'empty' | 'pending' | 'success' | 'error' | 'manual_review';
  person_id: string | null;
  face_url: string | null;
  local_image_path: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  retry_count: number;
}

interface ClassOption {
  id: number;
  code: string;
  name: string;
}

export const StudentsTab: React.FC = () => {
  const [students, setStudents] = useState<Student[]>([]);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string>('');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>('');
  const [search, setSearch] = useState('');
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const fetchClassOptions = async () => {
      try {
        const res = await apiClient.get<{ success: boolean; data: ClassOption[] }>('/classes');
        if (res.success) setClasses(res.data);
      } catch (err) {
        console.error(err);
      }
    };
    fetchClassOptions();
  }, []);

  const fetchStudents = async () => {
    try {
      const res = await apiClient.get<{ success: boolean; data: { items: Student[]; total: number } }>('/students', {
        page,
        limit: 20,
        class_id: selectedClassId || undefined,
        status: status || undefined,
        search: search || undefined,
      });
      if (res.success) {
        setStudents(res.data.items);
        setTotal(res.data.total);
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchStudents();
  }, [page, status, search, selectedClassId]);

  const handleOverridePhoto = async (studentId: number) => {
    if (!uploadFile) return;
    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      await apiClient.post(`/students/${studentId}/override`, formData);
      alert('Đã đẩy job cập nhật ảnh ưu tiên (Priority 1) vào hàng đợi!');
      setSelectedStudent(null);
      setUploadFile(null);
      fetchStudents();
    } catch (err: any) {
      alert(err.message || 'Lỗi cập nhật ảnh');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetStudent = async (studentId: number) => {
    if (!confirm('Bạn có chắc chắn muốn đưa học sinh này về trạng thái empty để nộp lại?')) return;
    try {
      await apiClient.post(`/students/${studentId}/reset`);
      setSelectedStudent(null);
      fetchStudents();
    } catch {
      alert('Không thể đặt lại trạng thái');
    }
  };

  const totalPages = Math.ceil(total / 20) || 1;

  return (
    <div className="space-y-4">
      {/* Bộ lọc & Tổng số */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-64">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Tìm theo tên hoặc aliasID..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="w-full rounded-lg border border-gray-300 pl-9 pr-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          <select
            value={selectedClassId}
            onChange={(e) => { setSelectedClassId(e.target.value); setPage(1); }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="">Tất cả các lớp</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                Lớp {c.code} - {c.name}
              </option>
            ))}
          </select>

          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="">Tất cả trạng thái</option>
            <option value="empty">⚪ Chưa nộp (empty)</option>
            <option value="pending">🟡 Đang xử lý (pending)</option>
            <option value="success">🟢 Thành công (success)</option>
            <option value="manual_review">🟠 Cần duyệt lại (manual_review)</option>
            <option value="error">🔴 Lỗi hệ thống (error)</option>
          </select>
        </div>

        <span className="text-xs text-gray-500 font-medium">
          Tổng số: <strong className="text-gray-800">{total}</strong> học sinh
        </span>
      </div>

      {/* Danh sách */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-100 bg-gray-50/75 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3">Ảnh</th>
              <th className="px-4 py-3">Họ và tên</th>
              <th className="px-4 py-3">Lớp</th>
              <th className="px-4 py-3">AliasID</th>
              <th className="px-4 py-3">Trạng thái</th>
              <th className="px-4 py-3 text-right">Chi tiết</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {students.map((s) => (
              <tr key={s.id} className="hover:bg-gray-50/50">
                <td className="px-4 py-2">
                  <div className="h-10 w-10 overflow-hidden rounded-full border bg-gray-100">
                    <img
                      src={`/images/${s.alias_id}.jpg`}
                      alt={s.name}
                      onError={(e) => { (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="%23ccc" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/></svg>'; }}
                      className="h-full w-full object-cover"
                    />
                  </div>
                </td>
                <td className="px-4 py-3 font-semibold text-gray-900">{s.name}</td>
                <td className="px-4 py-3 font-medium text-gray-600">{s.class_code}</td>
                <td className="px-4 py-3 font-mono text-xs text-gray-500">{s.alias_id}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    s.status === 'success' ? 'bg-emerald-50 text-emerald-700' :
                    s.status === 'pending' ? 'bg-amber-50 text-amber-700' :
                    s.status === 'manual_review' ? 'bg-orange-50 text-orange-700' :
                    s.status === 'error' ? 'bg-rose-50 text-rose-700' : 'bg-gray-100 text-gray-600'
                  }`}>
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                    {s.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => setSelectedStudent(s)}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    Xem
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-gray-200 pt-3">
          <span className="text-xs text-gray-500">
            Trang {page} / {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-lg border px-3 py-1 text-xs font-medium disabled:opacity-40"
            >
              Trang trước
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="rounded-lg border px-3 py-1 text-xs font-medium disabled:opacity-40"
            >
              Trang sau
            </button>
          </div>
        </div>
      )}

      {/* Modal Can thiệp */}
      <Dialog.Root open={Boolean(selectedStudent)} onOpenChange={(open) => !open && setSelectedStudent(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-2xl">
            {selectedStudent && (
              <div className="space-y-5">
                <Dialog.Title className="text-lg font-bold text-gray-900">
                  Hồ sơ học sinh: {selectedStudent.name} ({selectedStudent.class_code})
                </Dialog.Title>

                {/* Đối chiếu ảnh */}
                <div className="grid grid-cols-2 gap-4 rounded-xl border bg-gray-50 p-4">
                  <div>
                    <span className="text-xs font-bold uppercase text-gray-500">Ảnh Local VPS (1280x736)</span>
                    <div className="mt-2 aspect-[16/9] overflow-hidden rounded-lg border bg-black/5">
                      <img
                        src={`/images/${selectedStudent.alias_id}.jpg`}
                        alt="Local VPS"
                        className="h-full w-full object-cover"
                        onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
                      />
                    </div>
                  </div>
                  <div>
                    <span className="text-xs font-bold uppercase text-gray-500">Ảnh HANET CDN</span>
                    <div className="mt-2 aspect-[16/9] overflow-hidden rounded-lg border bg-black/5">
                      {selectedStudent.face_url ? (
                        <img src={selectedStudent.face_url} alt="HANET CDN" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-xs text-gray-400">Chưa đồng bộ lên Cloud</div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Thông số & Lỗi */}
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div><span className="text-gray-500">Person ID:</span> <span className="font-mono font-medium">{selectedStudent.person_id || 'Chưa có'}</span></div>
                  <div><span className="text-gray-500">Số lần thử:</span> <span className="font-semibold">{selectedStudent.retry_count}</span></div>
                  {selectedStudent.last_error_code && (
                    <div className="col-span-2 rounded-lg bg-rose-50 p-3 text-rose-800 text-xs">
                      <span className="font-bold">Mã lỗi: {selectedStudent.last_error_code}</span> — {selectedStudent.last_error_message}
                    </div>
                  )}
                </div>

                {/* Hành động can thiệp */}
                <div className="space-y-3 border-t pt-4">
                  <div className="text-xs font-bold uppercase text-gray-500">Cập nhật ảnh ưu tiên (Priority 1)</div>
                  <div className="flex items-center gap-3">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                      className="text-xs file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-blue-700 hover:file:bg-blue-100"
                    />
                    <button
                      onClick={() => handleOverridePhoto(selectedStudent.id)}
                      disabled={!uploadFile || submitting}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      Nạp Job Ưu Tiên
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between border-t pt-4">
                  <button
                    onClick={() => handleResetStudent(selectedStudent.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reset về Empty
                  </button>
                  <button
                    onClick={() => setSelectedStudent(null)}
                    className="rounded-lg bg-gray-100 px-4 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-200"
                  >
                    Đóng
                  </button>
                </div>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
};
