import React, { useState, useEffect } from 'react';
import { apiClient } from '../../api/client';
import * as Dialog from '@radix-ui/react-dialog';
import * as Switch from '@radix-ui/react-switch';
import { QrCode, Copy, Download, Search, Check, Plus, Users } from 'lucide-react';
import { CreateClassModal } from './CreateClassModal';
import { ClassStudentsModal } from './ClassStudentsModal';

interface ClassItem {
  id: number;
  code: string;
  name: string;
  teacher_name: string;
  token: string;
  is_locked: boolean;
  total_students: number;
  success_count: number;
  pending_count: number;
  error_count: number;
  manual_review_count: number;
  empty_count: number;
}

export const ClassesTab: React.FC = () => {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [search, setSearch] = useState('');
  const [selectedQR, setSelectedQR] = useState<{ code: string; token: string } | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedClassForStudents, setSelectedClassForStudents] = useState<ClassItem | null>(null);

  const fetchClasses = async () => {
    try {
      const res = await apiClient.get<{ success: boolean; data: ClassItem[] }>('/classes', { search });
      if (res.success) setClasses(res.data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchClasses();
  }, [search]);

  const toggleLock = async (classId: number, currentLock: boolean) => {
    try {
      await apiClient.patch(`/classes/${classId}/lock`, { is_locked: !currentLock });
      setClasses(prev => prev.map(c => c.id === classId ? { ...c, is_locked: !currentLock } : c));
    } catch {
      alert('Không thể cập nhật trạng thái khóa lớp');
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedToken(id);
    setTimeout(() => setCopiedToken(null), 2000);
  };

  const exportCSV = (cls: ClassItem) => {
    const headers = 'STT,Họ và tên,AliasID,Trạng thái,Mã Lớp\n';
    const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), headers], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `danh_sach_lop_${cls.code}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-4">
      {/* Search & Actions */}
      <div className="flex items-center justify-between">
        <div className="relative w-72">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Tìm mã lớp, tên lớp, GVCN..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-300 pl-9 pr-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <button
          onClick={() => setIsCreateOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Tạo Lớp Mới
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-100 bg-gray-50/75 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3">Mã Lớp</th>
              <th className="px-4 py-3">Tên Lớp & GVCN</th>
              <th className="px-4 py-3">Sĩ Số</th>
              <th className="px-4 py-3">Tiến độ (🟢 🟡 🟠 🔴)</th>
              <th className="px-4 py-3">Mã PIN (Bypass)</th>
              <th className="px-4 py-3 text-center">Khóa nộp</th>
              <th className="px-4 py-3 text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {classes.map((c) => {
              const total = c.total_students || 1;
              const pSuccess = (c.success_count / total) * 100;
              const pPending = (c.pending_count / total) * 100;
              const pReview = (c.manual_review_count / total) * 100;
              const pError = (c.error_count / total) * 100;

              return (
                <tr key={c.id} className="hover:bg-gray-50/50">
                  <td className="px-4 py-3 font-bold text-gray-900">{c.code}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-800">{c.name}</div>
                    <div className="text-xs text-gray-400">GV: {c.teacher_name || 'Chưa cập nhật'}</div>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => setSelectedClassForStudents(c)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-700 hover:bg-blue-100 transition shadow-sm"
                      title="Nhấn để xem và quản lý học sinh trong lớp"
                    >
                      <Users className="h-3.5 w-3.5 text-blue-600" />
                      <span>{c.total_students}</span>
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="w-48">
                      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-gray-100">
                        <div style={{ width: `${pSuccess}%` }} className="bg-emerald-500" title={`Thành công: ${c.success_count}`} />
                        <div style={{ width: `${pPending}%` }} className="bg-amber-400" title={`Đang chờ: ${c.pending_count}`} />
                        <div style={{ width: `${pReview}%` }} className="bg-orange-500" title={`Cần duyệt: ${c.manual_review_count}`} />
                        <div style={{ width: `${pError}%` }} className="bg-rose-500" title={`Lỗi: ${c.error_count}`} />
                      </div>
                      <div className="mt-1 flex justify-between text-[11px] text-gray-400">
                        <span>{c.success_count}/{c.total_students} hoàn thành</span>
                        <span>{Math.round(pSuccess)}%</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs bg-gray-100 px-2 py-0.5 rounded text-gray-700">
                      {c.token}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Switch.Root
                      checked={c.is_locked}
                      onCheckedChange={() => toggleLock(c.id, c.is_locked)}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${
                        c.is_locked ? 'bg-rose-600' : 'bg-gray-200'
                      }`}
                    >
                      <Switch.Thumb
                        className={`pointer-events-none block h-4 w-4 rounded-full bg-white shadow-lg transition-transform ${
                          c.is_locked ? 'translate-x-4' : 'translate-x-0.5'
                        } mt-0.5`}
                      />
                    </Switch.Root>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => setSelectedClassForStudents(c)}
                        className="rounded p-1.5 text-blue-600 hover:bg-blue-50"
                        title="Quản lý học sinh trong lớp"
                      >
                        <Users className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setSelectedQR({ code: c.code, token: c.token })}
                        className="rounded p-1.5 text-gray-500 hover:bg-gray-100"
                        title="Tạo mã QR lớp"
                      >
                        <QrCode className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => copyToClipboard(`${window.location.origin}/l/${c.code}?token=${c.token}`, `link-${c.id}`)}
                        className="rounded p-1.5 text-gray-500 hover:bg-gray-100"
                        title="Sao chép link nộp bài"
                      >
                        {copiedToken === `link-${c.id}` ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                      </button>
                      <button
                        onClick={() => exportCSV(c)}
                        className="rounded p-1.5 text-gray-500 hover:bg-gray-100"
                        title="Xuất file CSV lớp"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Modal QR Code */}
      <Dialog.Root open={Boolean(selectedQR)} onOpenChange={(open) => !open && setSelectedQR(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-xl">
            <Dialog.Title className="text-center text-lg font-bold text-gray-900">
              Mã QR Đăng Ký — Lớp {selectedQR?.code}
            </Dialog.Title>
            <div className="mt-4 flex flex-col items-center">
              <div className="rounded-xl border p-4 bg-white shadow-inner">
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(
                    `${window.location.origin}/l/${selectedQR?.code}?token=${selectedQR?.token}`
                  )}`}
                  alt="Class QR Code"
                  className="h-48 w-48"
                />
              </div>
              <p className="mt-3 text-center text-xs text-gray-500">
                Gửi mã QR này vào nhóm Zalo để học sinh quét và nộp ảnh trực tiếp.
              </p>
            </div>
            <div className="mt-6">
              <button
                onClick={() => setSelectedQR(null)}
                className="w-full rounded-lg bg-gray-100 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-200"
              >
                Đóng
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Modal Tạo Lớp Học Mới */}
      <CreateClassModal
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSuccess={fetchClasses}
      />

      {/* Modal Quản Lý Học Sinh Theo Lớp */}
      <ClassStudentsModal
        open={Boolean(selectedClassForStudents)}
        onOpenChange={(open) => !open && setSelectedClassForStudents(null)}
        classItem={selectedClassForStudents}
        onClassUpdated={fetchClasses}
      />
    </div>
  );
};
