import React, { useState, useEffect } from 'react';
import { apiClient } from '../api/client';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Activity,
  Search,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  ChevronLeft,
  ChevronRight,
  X,
  FileCode,
  SlidersHorizontal,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';

export interface WebhookEventItem {
  id: number;
  received_at: string;
  hanet_event_id: string | null;
  data_type: string | null;
  action_type: string | null;
  person_id: string | null;
  device_id: string | null;
  place_id: string | null;
  place_name: string | null;
  person_name: string | null;
  device_name: string | null;
  alias_id: string | null;
  student_id: number | null;
  class_id: number | null;
  hash_valid: boolean | null;
  disposition: 'applied' | 'deferred' | 'invalid_hash' | 'ignored' | 'failed';
  kill_switch_active: boolean;
  error_message: string | null;
  payload: any;
  student_name?: string | null;
  class_code?: string | null;
  class_name?: string | null;
}

export const WebhookEvents: React.FC = () => {
  const [events, setEvents] = useState<WebhookEventItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [limit] = useState<number>(20);
  const [loading, setLoading] = useState<boolean>(false);

  // Filters
  const [dataType, setDataType] = useState<string>('');
  const [actionType, setActionType] = useState<string>('');
  const [disposition, setDisposition] = useState<string>('');
  const [search, setSearch] = useState<string>('');

  // Modal detail
  const [selectedEvent, setSelectedEvent] = useState<WebhookEventItem | null>(null);
  const [fetchingDetail, setFetchingDetail] = useState<boolean>(false);

  const fetchEvents = async () => {
    try {
      setLoading(true);
      const res = await apiClient.get<{
        success: boolean;
        data: { items: WebhookEventItem[]; total: number };
      }>('/webhook-events', {
        page,
        limit,
        data_type: dataType || undefined,
        action_type: actionType || undefined,
        disposition: disposition || undefined,
        q: search.trim() || undefined,
      });

      if (res.success && res.data) {
        setEvents(res.data.items || []);
        setTotal(res.data.total || 0);
      }
    } catch (err) {
      console.error('Lỗi tải danh sách sự kiện webhook:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
  }, [page, dataType, actionType, disposition, search]);

  const handleRowClick = async (item: WebhookEventItem) => {
    try {
      setFetchingDetail(true);
      setSelectedEvent(item);
      const res = await apiClient.get<{ success: boolean; data: WebhookEventItem }>(
        `/webhook-events/${item.id}`
      );
      if (res.success && res.data) {
        setSelectedEvent(res.data);
      }
    } catch (err) {
      console.error('Lỗi tải chi tiết sự kiện webhook:', err);
    } finally {
      setFetchingDetail(false);
    }
  };

  const getDispositionBadge = (disp: string) => {
    switch (disp) {
      case 'applied':
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
            <CheckCircle2 className="h-3 w-3" />
            applied
          </span>
        );
      case 'deferred':
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
            <Clock className="h-3 w-3" />
            deferred
          </span>
        );
      case 'invalid_hash':
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-xs font-semibold text-rose-700">
            <XCircle className="h-3 w-3" />
            invalid_hash
          </span>
        );
      case 'ignored':
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-700">
            Chưa xử lý — chỉ ghi nhận
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-700">
            <AlertTriangle className="h-3 w-3" />
            failed
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs font-medium text-gray-600">
            {disp}
          </span>
        );
    }
  };

  const getTargetLabel = (item: WebhookEventItem) => {
    if (item.data_type === 'person') {
      const id = item.person_id || item.alias_id || '—';
      const name = item.person_name ? ` (${item.person_name})` : '';
      return `${id}${name}`;
    }
    if (item.data_type === 'device') {
      const id = item.device_id || '—';
      const name = item.device_name ? ` (${item.device_name})` : '';
      return `${id}${name}`;
    }
    if (item.data_type === 'place') {
      const id = item.place_id || '—';
      const name = item.place_name ? ` (${item.place_name})` : '';
      return `${id}${name}`;
    }
    return item.person_id || item.device_id || item.place_id || item.alias_id || '—';
  };

  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div className="space-y-6">
      {/* 1. Header Banner */}
      <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-blue-600 p-2 text-white">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-gray-900">
                Nhật Ký Sự Kiện Webhook Push HANET Cloud
              </h2>
              <p className="text-xs text-gray-600">
                Ghi nhận và đối soát mọi sự kiện push từ máy chủ HANET (Face, Device, Place) — Chế độ chỉ xem an toàn.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchEvents()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Làm mới
            </button>
          </div>
        </div>
      </div>

      {/* 2. Thanh lọc Filter & Search */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
          <SlidersHorizontal className="h-4 w-4 text-gray-400" />
          <span>Bộ lọc:</span>
        </div>

        {/* data_type Filter */}
        <select
          value={dataType}
          onChange={(e) => {
            setDataType(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-xs focus:border-blue-500 focus:outline-none"
        >
          <option value="">Loại dữ liệu: Tất cả</option>
          <option value="person">person (Face Data)</option>
          <option value="device">device (Thiết bị)</option>
          <option value="place">place (Địa điểm)</option>
        </select>

        {/* action_type Filter */}
        <select
          value={actionType}
          onChange={(e) => {
            setActionType(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-xs focus:border-blue-500 focus:outline-none"
        >
          <option value="">Thao tác: Tất cả</option>
          <option value="add">add</option>
          <option value="update">update</option>
          <option value="delete">delete</option>
        </select>

        {/* disposition Filter */}
        <select
          value={disposition}
          onChange={(e) => {
            setDisposition(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-xs focus:border-blue-500 focus:outline-none"
        >
          <option value="">Kết quả: Tất cả</option>
          <option value="applied">applied (Đã áp dụng)</option>
          <option value="deferred">deferred (Hoãn - Kill Switch)</option>
          <option value="invalid_hash">invalid_hash (Sai chữ ký)</option>
          <option value="ignored">ignored (Chưa xử lý — chỉ ghi nhận)</option>
          <option value="failed">failed (Lỗi xử lý)</option>
        </select>

        {/* Search input q */}
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-gray-400" />
          <input
            type="text"
            placeholder="Tìm person_id, device_id, place_id, alias, tên..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="w-full rounded-lg border border-gray-300 pl-9 pr-3 py-2 text-xs focus:border-blue-500 focus:outline-none"
          />
        </div>

        {(dataType || actionType || disposition || search) && (
          <button
            onClick={() => {
              setDataType('');
              setActionType('');
              setDisposition('');
              setSearch('');
              setPage(1);
            }}
            className="text-xs font-medium text-blue-600 hover:text-blue-800"
          >
            Xóa lọc
          </button>
        )}
      </div>

      {/* 3. Bảng danh sách sự kiện */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-gray-100 bg-gray-50/75 uppercase text-gray-500 font-semibold">
            <tr>
              <th className="px-4 py-3">Thời gian nhận</th>
              <th className="px-4 py-3">Loại dữ liệu</th>
              <th className="px-4 py-3">Thao tác</th>
              <th className="px-4 py-3">Đối tượng (ID / Tên)</th>
              <th className="px-4 py-3">Kết quả (Disposition)</th>
              <th className="px-4 py-3 text-center">Hash MD5</th>
              <th className="px-4 py-3 text-center">Kill Switch</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 font-mono">
            {events.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center font-sans text-gray-500">
                  {loading ? 'Đang tải dữ liệu sự kiện...' : 'Không có sự kiện webhook nào phù hợp.'}
                </td>
              </tr>
            ) : (
              events.map((event) => (
                <tr
                  key={event.id}
                  onClick={() => handleRowClick(event)}
                  className="cursor-pointer transition hover:bg-blue-50/40"
                >
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {format(parseISO(event.received_at), 'HH:mm:ss dd/MM/yyyy')}
                  </td>
                  <td className="px-4 py-3 font-semibold text-gray-800 font-sans">
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-[11px] font-mono text-gray-700">
                      {event.data_type || '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-700 font-sans">
                    <span
                      className={`inline-block rounded px-2 py-0.5 text-[11px] font-mono font-bold ${
                        event.action_type === 'add'
                          ? 'bg-emerald-50 text-emerald-700'
                          : event.action_type === 'delete'
                          ? 'bg-rose-50 text-rose-700'
                          : 'bg-blue-50 text-blue-700'
                      }`}
                    >
                      {event.action_type || '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900 max-w-xs truncate font-sans">
                    {getTargetLabel(event)}
                  </td>
                  <td className="px-4 py-3 font-sans">{getDispositionBadge(event.disposition)}</td>
                  <td className="px-4 py-3 text-center font-sans">
                    {event.hash_valid ? (
                      <span className="inline-flex items-center gap-1 font-semibold text-emerald-600">
                        <CheckCircle2 className="h-4 w-4" />
                        ✓
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 font-semibold text-rose-600">
                        <XCircle className="h-4 w-4" />
                        ✗
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center font-sans">
                    {event.kill_switch_active ? (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">
                        ON
                      </span>
                    ) : (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
                        OFF
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {/* 4. Thanh phân trang */}
        <div className="flex flex-wrap items-center justify-between border-t border-gray-100 bg-gray-50/50 px-4 py-3 text-xs text-gray-600">
          <div>
            Tổng số: <span className="font-bold text-gray-900">{total}</span> sự kiện | Trang{' '}
            <span className="font-bold text-gray-900">{page}</span> / {totalPages}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 font-semibold text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Trước
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 font-semibold text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-40"
            >
              Sau
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* 5. Modal chi tiết Payload */}
      <Dialog.Root open={!!selectedEvent} onOpenChange={(open) => !open && setSelectedEvent(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm transition-opacity" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl focus:outline-none max-h-[90vh] overflow-y-auto">
            {selectedEvent && (
              <div className="space-y-5">
                <div className="flex items-center justify-between border-b border-gray-100 pb-3">
                  <div className="flex items-center gap-2">
                    <div className="rounded-lg bg-blue-100 p-2 text-blue-700">
                      <FileCode className="h-5 w-5" />
                    </div>
                    <div>
                      <Dialog.Title className="text-base font-bold text-gray-900">
                        Chi tiết Sự kiện Webhook #{selectedEvent.id}
                      </Dialog.Title>
                      <Dialog.Description className="text-xs text-gray-500 font-mono">
                        Nhận lúc: {format(parseISO(selectedEvent.received_at), 'HH:mm:ss dd/MM/yyyy')}
                        {selectedEvent.hanet_event_id && ` | Hanet Event ID: ${selectedEvent.hanet_event_id}`}
                      </Dialog.Description>
                    </div>
                  </div>
                  <button
                    onClick={() => setSelectedEvent(null)}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>

                {/* Metadata badges */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 rounded-xl bg-gray-50 p-4 text-xs">
                  <div>
                    <span className="block text-gray-500">Loại dữ liệu:</span>
                    <span className="font-bold text-gray-900 font-mono">{selectedEvent.data_type || '—'}</span>
                  </div>
                  <div>
                    <span className="block text-gray-500">Thao tác:</span>
                    <span className="font-bold text-gray-900 font-mono">{selectedEvent.action_type || '—'}</span>
                  </div>
                  <div>
                    <span className="block text-gray-500">Kết quả xử lý:</span>
                    <div className="mt-0.5">{getDispositionBadge(selectedEvent.disposition)}</div>
                  </div>
                  <div>
                    <span className="block text-gray-500">Kill Switch:</span>
                    <span
                      className={`font-bold ${
                        selectedEvent.kill_switch_active ? 'text-red-600' : 'text-gray-700'
                      }`}
                    >
                      {selectedEvent.kill_switch_active ? 'BẬT (Hoãn xử lý)' : 'TẮT'}
                    </span>
                  </div>
                </div>

                {/* Liên kết học sinh / Lớp học nếu có */}
                {(selectedEvent.student_id || selectedEvent.student_name || selectedEvent.class_code) && (
                  <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-4 text-xs">
                    <span className="font-bold text-blue-900">Hồ sơ Học sinh Liên kết:</span>
                    <div className="mt-1 grid grid-cols-2 gap-2 text-blue-800">
                      <div>
                        Học sinh:{' '}
                        <span className="font-bold">
                          {selectedEvent.student_name || `ID #${selectedEvent.student_id}`}
                        </span>
                      </div>
                      <div>
                        Lớp học:{' '}
                        <span className="font-bold">
                          {selectedEvent.class_code || selectedEvent.class_name || `ID #${selectedEvent.class_id}`}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Lỗi nếu có */}
                {selectedEvent.error_message && (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">
                    <span className="font-bold">Thông điệp lỗi:</span>
                    <pre className="mt-1 whitespace-pre-wrap font-mono">{selectedEvent.error_message}</pre>
                  </div>
                )}

                {/* Toàn bộ Payload JSON */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-bold text-gray-700">Payload nhận được (JSON):</span>
                    <span className="text-[11px] text-gray-500 italic">
                      * Keycode đã được làm sạch bảo mật (null)
                    </span>
                  </div>
                  <pre className="max-h-96 overflow-x-auto rounded-xl bg-gray-900 p-4 text-xs font-mono text-emerald-400">
                    {fetchingDetail
                      ? 'Đang tải payload...'
                      : JSON.stringify(selectedEvent.payload, null, 2)}
                  </pre>
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    onClick={() => setSelectedEvent(null)}
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
