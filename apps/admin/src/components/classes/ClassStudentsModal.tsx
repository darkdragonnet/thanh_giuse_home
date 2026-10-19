import React, { useState, useEffect, useMemo } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { apiClient } from '../../api/client';
import {
  Users,
  Plus,
  FileSpreadsheet,
  Search,
  Pencil,
  Trash2,
  RotateCcw,
  Check,
  X,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Copy,
  AlertTriangle,
  Zap,
  Play,
} from 'lucide-react';

export interface ClassItem {
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

export interface ClassStudentItem {
  id: number;
  class_id: number;
  name: string;
  alias_id: string;
  status: 'empty' | 'pending' | 'success' | 'error' | 'manual_review';
  person_id?: string | null;
  face_url?: string | null;
  local_image_path?: string | null;
  last_error_code?: string | null;
  last_error_message?: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

interface ClassStudentsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  classItem: ClassItem | null;
  onClassUpdated?: () => void;
}

/**
 * Smart Sanitizer: Bóc tách số thứ tự đầu dòng (1., 02 -, 3/...) -> lấy họ tên thuần túy
 */
export const sanitizeStudentName = (rawName: string): string => {
  return rawName
    .replace(/^\s*\d+[\.\-\/\)\s]\s*/, '')
    .trim()
    .replace(/\s+/g, ' ');
};

export const ClassStudentsModal: React.FC<ClassStudentsModalProps> = ({
  open,
  onOpenChange,
  classItem,
  onClassUpdated,
}) => {
  const [students, setStudents] = useState<ClassStudentItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'list' | 'single' | 'bulk'>('list');
  const [copiedAlias, setCopiedAlias] = useState<string | null>(null);

  // Single Add form
  const [singleName, setSingleName] = useState('');
  const [singleSubmitting, setSingleSubmitting] = useState(false);
  const [singleError, setSingleError] = useState<string | null>(null);
  const [singleSuccess, setSingleSuccess] = useState<string | null>(null);

  // Bulk Add form
  const [bulkText, setBulkText] = useState('');
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkSuccess, setBulkSuccess] = useState<string | null>(null);

  // Inline edit name
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingSubmitting, setEditingSubmitting] = useState(false);

  // Action feedback
  const [bannerMessage, setBannerMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isRequeuing, setIsRequeuing] = useState(false);
  const [retryingStudentId, setRetryingStudentId] = useState<number | null>(null);

  const fetchStudents = async () => {
    if (!classItem) return;
    setIsLoading(true);
    try {
      const res = await apiClient.get<{ success: boolean; data: ClassStudentItem[] }>(
        `/classes/${classItem.id}/students`
      );
      if (res.success) {
        setStudents(res.data);
      }
    } catch (err: any) {
      console.error(err);
      setBannerMessage({ type: 'error', text: err.message || 'Không thể tải danh sách học sinh' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (open && classItem) {
      fetchStudents();
      setActiveTab('list');
      setSearch('');
      setBannerMessage(null);
      setSingleName('');
      setBulkText('');
      setEditingId(null);
    }
  }, [open, classItem?.id]);

  // Bulk preview parsing with duplicate detection
  const parsedBulkNames = useMemo(() => {
    if (!bulkText.trim()) return [];
    return bulkText
      .split('\n')
      .map(sanitizeStudentName)
      .filter((n) => n.length >= 2 && n.length <= 100);
  }, [bulkText]);

  const duplicateWarning = useMemo(() => {
    const existingNamesLower = new Set(students.map((s) => s.name.toLowerCase()));
    const duplicates = parsedBulkNames.filter((name) => existingNamesLower.has(name.toLowerCase()));
    return duplicates.length > 0 ? duplicates : null;
  }, [parsedBulkNames, students]);

  const handleCopyAlias = (alias: string) => {
    navigator.clipboard.writeText(alias);
    setCopiedAlias(alias);
    setTimeout(() => setCopiedAlias(null), 2000);
  };

  const handleCreateSingle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!classItem) return;
    setSingleError(null);
    setSingleSuccess(null);

    const clean = sanitizeStudentName(singleName);
    if (clean.length < 2 || clean.length > 100) {
      setSingleError('Họ và tên học sinh phải từ 2 đến 100 ký tự');
      return;
    }

    setSingleSubmitting(true);
    try {
      await apiClient.post(`/classes/${classItem.id}/students`, { name: clean });
      setSingleSuccess(`Đã thêm thành công học sinh "${clean}"!`);
      setSingleName('');
      await fetchStudents();
      onClassUpdated?.();
      setTimeout(() => {
        setSingleSuccess(null);
        setActiveTab('list');
      }, 900);
    } catch (err: any) {
      setSingleError(err.message || 'Lỗi khi thêm học sinh');
    } finally {
      setSingleSubmitting(false);
    }
  };

  const handleCreateBulk = async () => {
    if (!classItem || parsedBulkNames.length === 0) return;
    setBulkError(null);
    setBulkSuccess(null);
    setBulkSubmitting(true);

    try {
      const res = await apiClient.post<{ success: boolean; data: ClassStudentItem[] }>(
        `/classes/${classItem.id}/students`,
        { names: parsedBulkNames }
      );
      setBulkSuccess(`Đã nhập thành công ${res.data?.length || parsedBulkNames.length} học sinh!`);
      setBulkText('');
      await fetchStudents();
      onClassUpdated?.();
      setTimeout(() => {
        setBulkSuccess(null);
        setActiveTab('list');
      }, 1000);
    } catch (err: any) {
      setBulkError(err.message || 'Lỗi khi nhập danh sách học sinh');
    } finally {
      setBulkSubmitting(false);
    }
  };

  const handleStartEdit = (student: ClassStudentItem) => {
    setEditingId(student.id);
    setEditingName(student.name);
  };

  const handleSaveEdit = async (studentId: number) => {
    const clean = sanitizeStudentName(editingName);
    if (clean.length < 2 || clean.length > 100) {
      alert('Họ và tên học sinh phải từ 2 đến 100 ký tự');
      return;
    }

    setEditingSubmitting(true);
    try {
      await apiClient.put(`/students/${studentId}`, { name: clean });
      setStudents((prev) => prev.map((s) => (s.id === studentId ? { ...s, name: clean } : s)));
      setEditingId(null);
      setBannerMessage({ type: 'success', text: `Đã đổi tên học sinh thành "${clean}"` });
      onClassUpdated?.();
    } catch (err: any) {
      alert(err.message || 'Không thể đổi tên học sinh');
    } finally {
      setEditingSubmitting(false);
    }
  };

  const handleDelete = async (student: ClassStudentItem) => {
    if (student.status === 'pending') {
      alert('Học sinh đang trong tiến trình xử lý ảnh trên hàng đợi, không thể xóa lúc này!');
      return;
    }

    let confirmMsg = `Bạn có chắc chắn muốn xóa học sinh "${student.name}" khỏi lớp?`;
    if (student.person_id) {
      confirmMsg = `⚠️ CẢNH BÁO: Học sinh "${student.name}" đã đồng bộ khuôn mặt lên HANET Cloud (Person ID: ${student.person_id}).\nBạn có chắc chắn muốn xóa khỏi hệ thống quản lý?`;
    }

    if (!confirm(confirmMsg)) return;

    try {
      await apiClient.delete(`/students/${student.id}`);
      setStudents((prev) => prev.filter((s) => s.id !== student.id));
      setBannerMessage({ type: 'success', text: `Đã xóa học sinh "${student.name}" thành công` });
      onClassUpdated?.();
    } catch (err: any) {
      alert(err.message || 'Không thể xóa học sinh');
    }
  };

  const handleReset = async (student: ClassStudentItem) => {
    if (!confirm(`Bạn có chắc chắn muốn đặt lại trạng thái học sinh "${student.name}" về Chưa nộp (empty)?`)) return;

    try {
      await apiClient.post(`/students/${student.id}/reset`);
      setStudents((prev) =>
        prev.map((s) => (s.id === student.id ? { ...s, status: 'empty', local_image_path: null, face_url: null } : s))
      );
      setBannerMessage({ type: 'success', text: `Đã hoàn trả học sinh "${student.name}" về trạng thái empty` });
      onClassUpdated?.();
    } catch (err: any) {
      alert(err.message || 'Không thể đặt lại trạng thái');
    }
  };

  const handleRequeuePending = async () => {
    if (!classItem) return;
    setIsRequeuing(true);
    try {
      const res = await apiClient.post<{
        success: boolean;
        message: string;
        requeuedCount: number;
        resetCount: number;
      }>(`/classes/${classItem.id}/requeue-pending`);

      setBannerMessage({
        type: 'success',
        text: res.message || 'Đã nạp lại các học sinh pending vào hàng đợi xử lý ngay.',
      });
      await fetchStudents();
      onClassUpdated?.();
    } catch (err: any) {
      alert(err.message || 'Không thể nạp lại hàng đợi');
    } finally {
      setIsRequeuing(false);
    }
  };

  const handleRetry = async (student: ClassStudentItem) => {
    setRetryingStudentId(student.id);
    try {
      const res = await apiClient.post<{ success: boolean; message: string }>(`/students/${student.id}/retry`);
      setBannerMessage({
        type: 'success',
        text: res.message || `Đã nạp học sinh "${student.name}" vào hàng đợi xử lý ngay.`,
      });
      await fetchStudents();
      onClassUpdated?.();
    } catch (err: any) {
      alert(err.message || 'Không thể thử lại học sinh này');
    } finally {
      setRetryingStudentId(null);
    }
  };

  const filteredStudents = useMemo(() => {
    if (!search.trim()) return students;
    const q = search.toLowerCase();
    return students.filter((s) => s.name.toLowerCase().includes(q) || s.alias_id.toLowerCase().includes(q));
  }, [students, search]);

  const stats = useMemo(() => {
    const total = students.length;
    const success = students.filter((s) => s.status === 'success').length;
    const pending = students.filter((s) => s.status === 'pending').length;
    const review = students.filter((s) => s.status === 'manual_review').length;
    const error = students.filter((s) => s.status === 'error').length;
    const empty = students.filter((s) => s.status === 'empty').length;
    const pctSuccess = total > 0 ? Math.round((success / total) * 100) : 0;
    return { total, success, pending, review, error, empty, pctSuccess };
  }, [students]);

  if (!classItem) return null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-4xl -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl max-h-[92vh] flex flex-col">
          {/* Header */}
          <div className="flex items-start justify-between border-b pb-4">
            <div>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600 font-bold text-lg">
                  {classItem.code}
                </div>
                <div>
                  <Dialog.Title className="text-xl font-bold text-gray-900">
                    Quản Lý Học Sinh — {classItem.name}
                  </Dialog.Title>
                  <p className="text-xs text-gray-500">
                    GVCN: <span className="font-medium text-gray-700">{classItem.teacher_name || 'Chưa cập nhật'}</span> | 
                    Mã PIN: <span className="font-mono font-semibold text-gray-700">{classItem.token}</span>
                  </p>
                </div>
              </div>
            </div>

            <button
              onClick={() => onOpenChange(false)}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Quick Stats & Progress Bar */}
          <div className="my-3 rounded-xl bg-gray-50 p-3.5 border border-gray-100 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-4 text-xs font-medium">
              <span className="text-gray-600">
                Sĩ số: <strong className="text-gray-900 text-sm">{stats.total}</strong>
              </span>
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                Hoàn tất: <strong>{stats.success}</strong>
              </span>
              <span className="inline-flex items-center gap-1 text-amber-700">
                <span className="h-2 w-2 rounded-full bg-amber-400" />
                Đang chờ: <strong>{stats.pending}</strong>
              </span>
              <span className="inline-flex items-center gap-1 text-orange-700">
                <span className="h-2 w-2 rounded-full bg-orange-500" />
                Cần duyệt: <strong>{stats.review}</strong>
              </span>
              <span className="inline-flex items-center gap-1 text-rose-700">
                <span className="h-2 w-2 rounded-full bg-rose-500" />
                Lỗi: <strong>{stats.error}</strong>
              </span>
              <span className="inline-flex items-center gap-1 text-gray-500">
                <span className="h-2 w-2 rounded-full bg-gray-300" />
                Chưa nộp: <strong>{stats.empty}</strong>
              </span>
            </div>

            <div className="flex items-center gap-2 min-w-[180px]">
              <div className="h-2 flex-1 rounded-full bg-gray-200 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${stats.pctSuccess}%` }}
                />
              </div>
              <span className="text-xs font-bold text-emerald-600">{stats.pctSuccess}%</span>
            </div>
          </div>

          {/* Action Banner for Stuck Pending Students */}
          {stats.pending > 0 && (
            <div className="mb-3 flex items-center justify-between rounded-xl bg-amber-50 border border-amber-200 px-4 py-2.5 text-xs text-amber-900 shadow-sm">
              <div className="flex items-center gap-2">
                <span className="flex h-2.5 w-2.5 rounded-full bg-amber-500 animate-pulse" />
                <span>
                  Phát hiện <strong>{stats.pending}</strong> học sinh đang ở trạng thái chờ (pending).
                </span>
              </div>
              <button
                onClick={handleRequeuePending}
                disabled={isRequeuing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold px-3 py-1.5 shadow-sm transition disabled:opacity-50"
              >
                <Zap className="h-3.5 w-3.5" />
                <span>{isRequeuing ? 'Đang nạp lại...' : 'Xử lý ngay toàn bộ'}</span>
              </button>
            </div>
          )}

          {/* Global Alert Banner */}
          {bannerMessage && (
            <div
              className={`mb-3 flex items-center justify-between rounded-lg px-3.5 py-2 text-xs font-medium ${
                bannerMessage.type === 'success'
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                  : 'bg-rose-50 text-rose-800 border border-rose-200'
              }`}
            >
              <span>{bannerMessage.text}</span>
              <button onClick={() => setBannerMessage(null)} className="opacity-70 hover:opacity-100">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Nav Tabs */}
          <div className="flex border-b border-gray-200 gap-1 text-sm font-semibold">
            <button
              onClick={() => setActiveTab('list')}
              className={`flex items-center gap-1.5 px-4 py-2.5 border-b-2 transition ${
                activeTab === 'list'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <Users className="h-4 w-4" />
              Danh sách ({stats.total})
            </button>

            <button
              onClick={() => setActiveTab('single')}
              className={`flex items-center gap-1.5 px-4 py-2.5 border-b-2 transition ${
                activeTab === 'single'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <Plus className="h-4 w-4" />
              Thêm 1 Học Sinh
            </button>

            <button
              onClick={() => setActiveTab('bulk')}
              className={`flex items-center gap-1.5 px-4 py-2.5 border-b-2 transition ${
                activeTab === 'bulk'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <FileSpreadsheet className="h-4 w-4" />
              Nhập Hàng Loạt (Bulk Paste)
            </button>
          </div>

          {/* Tab Content Container */}
          <div className="flex-1 overflow-y-auto pt-4 min-h-[300px]">
            {/* TAB 1: DANH SÁCH HỌC SINH */}
            {activeTab === 'list' && (
              <div className="space-y-3">
                {/* Search */}
                <div className="relative max-w-sm">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Tìm theo họ tên hoặc AliasID..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 pl-9 pr-4 py-2 text-xs focus:border-blue-500 focus:outline-none"
                  />
                </div>

                {isLoading ? (
                  <div className="flex items-center justify-center py-12 text-gray-400 text-sm">
                    <Loader2 className="h-6 w-6 animate-spin mr-2" />
                    Đang tải danh sách học sinh...
                  </div>
                ) : filteredStudents.length === 0 ? (
                  <div className="rounded-xl border border-dashed py-12 text-center text-gray-400 text-sm">
                    {search ? 'Không tìm thấy học sinh phù hợp.' : 'Lớp chưa có học sinh nào. Hãy thêm học sinh mới!'}
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-gray-200">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-gray-50/80 uppercase text-[11px] font-semibold text-gray-500 border-b">
                        <tr>
                          <th className="px-3 py-2.5">Ảnh</th>
                          <th className="px-3 py-2.5">Họ và tên</th>
                          <th className="px-3 py-2.5">Mã AliasID</th>
                          <th className="px-3 py-2.5">Trạng thái</th>
                          <th className="px-3 py-2.5 text-right">Thao tác</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {filteredStudents.map((s) => (
                          <tr key={s.id} className="hover:bg-gray-50/60">
                            {/* Avatar */}
                            <td className="px-3 py-2">
                              <div className="h-8 w-8 overflow-hidden rounded-full border bg-gray-100 flex items-center justify-center">
                                <img
                                  src={
                                    s.face_url ||
                                    (s.alias_id
                                      ? `/images/${s.alias_id}.jpg`
                                      : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="%23ccc" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/></svg>')
                                  }
                                  alt={s.name}
                                  className="h-full w-full object-cover"
                                  onError={(e) => {
                                    (e.target as HTMLImageElement).src =
                                      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="%23ccc" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/></svg>';
                                  }}
                                />
                              </div>
                            </td>

                            {/* Tên & Inline edit */}
                            <td className="px-3 py-2 font-semibold text-gray-900">
                              {editingId === s.id ? (
                                <div className="flex items-center gap-1.5">
                                  <input
                                    type="text"
                                    value={editingName}
                                    onChange={(e) => setEditingName(e.target.value)}
                                    className="rounded border border-blue-400 px-2 py-1 text-xs focus:outline-none"
                                    autoFocus
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') handleSaveEdit(s.id);
                                      if (e.key === 'Escape') setEditingId(null);
                                    }}
                                  />
                                  <button
                                    onClick={() => handleSaveEdit(s.id)}
                                    disabled={editingSubmitting}
                                    className="rounded bg-emerald-600 p-1 text-white hover:bg-emerald-700"
                                    title="Lưu"
                                  >
                                    <Check className="h-3 w-3" />
                                  </button>
                                  <button
                                    onClick={() => setEditingId(null)}
                                    className="rounded bg-gray-200 p-1 text-gray-600 hover:bg-gray-300"
                                    title="Hủy"
                                  >
                                    <X className="h-3 w-3" />
                                  </button>
                                </div>
                              ) : (
                                <span className="hover:text-blue-600 cursor-pointer" onClick={() => handleStartEdit(s)}>
                                  {s.name}
                                </span>
                              )}
                            </td>

                            {/* AliasID */}
                            <td className="px-3 py-2 font-mono text-[11px] text-gray-500">
                              <div className="flex items-center gap-1">
                                <span>{s.alias_id}</span>
                                <button
                                  onClick={() => handleCopyAlias(s.alias_id)}
                                  className="text-gray-400 hover:text-gray-700"
                                  title="Sao chép AliasID"
                                >
                                  {copiedAlias === s.alias_id ? (
                                    <Check className="h-3 w-3 text-emerald-600" />
                                  ) : (
                                    <Copy className="h-3 w-3" />
                                  )}
                                </button>
                              </div>
                            </td>

                            {/* Status badge */}
                            <td className="px-3 py-2">
                              <span
                                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                  s.status === 'success'
                                    ? 'bg-emerald-50 text-emerald-700'
                                    : s.status === 'pending'
                                    ? 'bg-amber-50 text-amber-700'
                                    : s.status === 'manual_review'
                                    ? 'bg-orange-50 text-orange-700'
                                    : s.status === 'error'
                                    ? 'bg-rose-50 text-rose-700'
                                    : 'bg-gray-100 text-gray-600'
                                }`}
                              >
                                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                                {s.status}
                              </span>
                            </td>

                            {/* Actions */}
                            <td className="px-3 py-2 text-right">
                              <div className="flex items-center justify-end gap-1">
                                {(s.status === 'pending' || s.status === 'manual_review' || s.status === 'error') && (
                                  <button
                                    onClick={() => handleRetry(s)}
                                    disabled={retryingStudentId === s.id}
                                    className="rounded p-1 text-amber-600 hover:bg-amber-100 hover:text-amber-800 disabled:opacity-50"
                                    title="Thử lại / Đồng bộ ngay từ ảnh trên server"
                                  >
                                    <Play className={`h-3.5 w-3.5 fill-current ${retryingStudentId === s.id ? 'animate-spin' : ''}`} />
                                  </button>
                                )}

                                <button
                                  onClick={() => handleStartEdit(s)}
                                  className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-blue-600"
                                  title="Sửa tên học sinh"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>

                                {s.status !== 'empty' && (
                                  <button
                                    onClick={() => handleReset(s)}
                                    className="rounded p-1 text-gray-500 hover:bg-amber-50 hover:text-amber-600"
                                    title="Reset về Chưa nộp (empty)"
                                  >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                  </button>
                                )}

                                <button
                                  onClick={() => handleDelete(s)}
                                  className="rounded p-1 text-gray-500 hover:bg-red-50 hover:text-red-600"
                                  title="Xóa học sinh"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: THÊM ĐƠN LẺ */}
            {activeTab === 'single' && (
              <form onSubmit={handleCreateSingle} className="max-w-md mx-auto space-y-4 py-4">
                {singleError && (
                  <div className="flex items-center gap-2 rounded-lg bg-rose-50 p-3 text-xs text-rose-700 border border-rose-200">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{singleError}</span>
                  </div>
                )}

                {singleSuccess && (
                  <div className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-700 border border-emerald-200">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>{singleSuccess}</span>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Họ và tên học sinh <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    placeholder="VD: Nguyễn Hoàng Long"
                    value={singleName}
                    onChange={(e) => setSingleName(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    autoFocus
                  />
                  <p className="mt-1 text-[11px] text-gray-400">
                    Mã AliasID sẽ được tự động tạo theo định dạng chuẩn: <code className="font-mono">STU_{classItem.code}_XXXXXX</code>
                  </p>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab('list')}
                    className="rounded-lg px-4 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-100"
                  >
                    Hủy
                  </button>
                  <button
                    type="submit"
                    disabled={singleSubmitting || !singleName.trim()}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {singleSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Thêm Học Sinh
                  </button>
                </div>
              </form>
            )}

            {/* TAB 3: NHẬP HÀNG LOẠT (BULK PASTE) */}
            {activeTab === 'bulk' && (
              <div className="space-y-4 py-2 max-w-2xl mx-auto">
                {bulkError && (
                  <div className="flex items-center gap-2 rounded-lg bg-rose-50 p-3 text-xs text-rose-700 border border-rose-200">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{bulkError}</span>
                  </div>
                )}

                {bulkSuccess && (
                  <div className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-700 border border-emerald-200">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>{bulkSuccess}</span>
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-semibold text-gray-700">
                      Dán danh sách học sinh (mỗi dòng một học sinh)
                    </label>
                    <span className="text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
                      Đã nhận diện: {parsedBulkNames.length} học sinh
                    </span>
                  </div>

                  <textarea
                    rows={8}
                    placeholder={`1. Nguyễn Hoàng Long\n2. Trần Minh Quân\n3. Lê Thị Thu Thảo\n04 - Phạm Đức Trọng\n5/ Vũ Mai Phương`}
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                    className="w-full rounded-xl border border-gray-300 p-3 text-xs font-mono focus:border-blue-500 focus:outline-none"
                  />
                  <p className="mt-1 text-[11px] text-gray-400">
                    💡 <strong>Smart Sanitizer:</strong> Tự động bóc tách số thứ tự đầu dòng (1., 02 -, 3/...) và cắt khoảng trắng thừa.
                  </p>
                </div>

                {/* Duplicate Warning */}
                {duplicateWarning && (
                  <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 border border-amber-200">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
                    <div>
                      <span className="font-semibold">Lưu ý tên có thể đã tồn tại trong lớp:</span>{' '}
                      {duplicateWarning.slice(0, 3).join(', ')}
                      {duplicateWarning.length > 3 && ` và ${duplicateWarning.length - 3} bạn khác`}
                    </div>
                  </div>
                )}

                {/* Preview Box */}
                {parsedBulkNames.length > 0 && (
                  <div className="rounded-xl border bg-gray-50/60 p-3 text-xs">
                    <div className="font-bold text-gray-700 mb-2">
                      Xem trước danh sách sẽ tạo ({parsedBulkNames.length}):
                    </div>
                    <div className="max-h-28 overflow-y-auto space-y-1">
                      {parsedBulkNames.map((name, i) => (
                        <div key={i} className="flex items-center gap-2 text-gray-600">
                          <span className="w-5 text-gray-400 font-mono text-[10px]">{i + 1}.</span>
                          <span className="font-medium text-gray-800">{name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab('list')}
                    className="rounded-lg px-4 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-100"
                  >
                    Hủy
                  </button>
                  <button
                    onClick={handleCreateBulk}
                    disabled={bulkSubmitting || parsedBulkNames.length === 0}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 shadow-sm"
                  >
                    {bulkSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Tạo {parsedBulkNames.length} Học Sinh
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t pt-3 flex justify-end">
            <button
              onClick={() => onOpenChange(false)}
              className="rounded-lg bg-gray-100 px-4 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-200 transition"
            >
              Đóng
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
