import React, { useState, useEffect, useMemo } from 'react';
import { apiClient } from '../../api/client';
import { differenceInHours, parseISO, format } from 'date-fns';
import { Inbox, CheckCircle2, RefreshCw } from 'lucide-react';

interface AdminRequest {
  id: number;
  alias_id: string;
  student_name: string;
  image_path: string;
  note: string;
  status: 'new' | 'processing' | 'done';
  created_at: string;
}

export const RequestsTab: React.FC = () => {
  const [requests, setRequests] = useState<AdminRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRequests = async () => {
    try {
      setLoading(true);
      const res = await apiClient.get<{ success: boolean; data: { items: AdminRequest[] } | AdminRequest[] }>('/requests', { status: 'new' });
      if (res.success) {
        const items = Array.isArray(res.data) ? res.data : (res.data.items || []);
        setRequests(items);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRequests();
  }, []);

  // Smart Grouping: Gộp yêu cầu cùng alias_id trong 1 giờ
  const groupedRequests = useMemo(() => {
    const groups: { [key: string]: { latest: AdminRequest; count: number; items: AdminRequest[] } } = {};

    requests.forEach((req) => {
      const key = req.alias_id;
      if (!groups[key]) {
        groups[key] = { latest: req, count: 1, items: [req] };
      } else {
        const lastDate = parseISO(groups[key].latest.created_at);
        const currDate = parseISO(req.created_at);
        if (Math.abs(differenceInHours(currDate, lastDate)) <= 1) {
          groups[key].count += 1;
          groups[key].items.push(req);
        }
      }
    });

    return Object.values(groups);
  }, [requests]);

  const updateStatus = async (id: number, status: string) => {
    try {
      await apiClient.patch(`/requests/${id}/status`, { status });
      setRequests(prev => prev.filter(r => r.id !== id));
    } catch {
      alert('Không thể cập nhật trạng thái yêu cầu');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-gray-800">
          Danh sách Yêu cầu Hỗ trợ Chờ Duyệt ({groupedRequests.length})
        </h3>
        <button
          onClick={fetchRequests}
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Làm mới
        </button>
      </div>

      {groupedRequests.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed text-gray-400">
          <Inbox className="h-8 w-8 stroke-1" />
          <p className="mt-2 text-sm">Hiện không có yêu cầu hỗ trợ nào mới.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {groupedRequests.map(({ latest, count }) => (
            <div key={latest.id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-bold text-gray-900">{latest.student_name}</h4>
                  <span className="font-mono text-xs text-gray-400">Alias: {latest.alias_id}</span>
                </div>
                {count > 1 && (
                  <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-bold text-amber-700 border border-amber-200">
                    Gửi lại {count} lần trong 1h
                  </span>
                )}
              </div>

              {/* Ảnh học sinh đính kèm */}
              <div className="aspect-[16/9] w-full overflow-hidden rounded-lg bg-gray-100 border">
                <img
                  src={`/images/${latest.alias_id}.jpg`}
                  alt="Ảnh yêu cầu"
                  className="h-full w-full object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60" viewBox="0 0 24 24" fill="none" stroke="%23ccc" stroke-width="1"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>'; }}
                />
              </div>

              {latest.note && (
                <div className="rounded-lg bg-gray-50 p-2.5 text-xs text-gray-600">
                  <span className="font-semibold text-gray-800">Ghi chú:</span> {latest.note}
                </div>
              )}

              <div className="flex items-center justify-between border-t pt-3 text-xs text-gray-400">
                <span>{format(parseISO(latest.created_at), 'HH:mm dd/MM/yyyy')}</span>
                <button
                  onClick={() => updateStatus(latest.id, 'done')}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-700"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Đánh dấu Hoàn tất
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
