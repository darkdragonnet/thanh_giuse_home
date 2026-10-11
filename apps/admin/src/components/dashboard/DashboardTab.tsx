import React, { useState, useCallback } from 'react';
import { apiClient } from '../../api/client';
import { usePolling } from '../../hooks/usePolling';
import { 
  AlertOctagon, AlertTriangle, Users, CheckCircle2, 
  Clock, AlertCircle, HardDrive, RefreshCw 
} from 'lucide-react';

interface DashboardStats {
  metrics: {
    total_students: number;
    total_success: number;
    total_pending: number;
    total_error: number;
    total_manual_review: number;
    total_empty: number;
  };
  total_classes: number;
  face_quota: {
    used: number;
    limit: number;
    percent: number;
  };
  system_status: {
    is_maintenance: boolean;
    emergency_alert: {
      result_code: string;
      result_message: string;
    } | null;
  };
}

export const DashboardTab: React.FC = () => {
  const [data, setData] = useState<DashboardStats | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await apiClient.get<{ success: boolean; data: DashboardStats }>('/dashboard/stats');
      if (res.success) setData(res.data);
    } catch (err) {
      console.error('Không thể tải dữ liệu dashboard:', err);
    }
  }, []);

  usePolling(fetchStats, 15000);

  if (!data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  const { metrics, face_quota, system_status } = data;
  const emergency = system_status.emergency_alert;

  return (
    <div className="space-y-6">
      {/* 1. Sticky Emergency Alerts */}
      {emergency?.result_code === '-103' && (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-red-900 shadow-sm animate-pulse">
          <AlertOctagon className="h-6 w-6 shrink-0 text-red-600 mt-0.5" />
          <div className="text-sm">
            <h4 className="font-bold">🚨 SỰ CỐ KHẨN CẤP: HANET ACCESS TOKEN HẾT HẠN (-103)</h4>
            <p className="mt-1 text-red-700">
              Worker đã tự động dừng nhận ảnh và bật chế độ bảo trì. Hãy cập nhật <code>HANET_ACCESS_TOKEN</code> mới vào file <code>.env</code> trên VPS và chạy lệnh:
            </p>
            <pre className="mt-2 rounded bg-red-950 p-2 font-mono text-xs text-red-100">
              docker compose restart api-server queue-worker
            </pre>
          </div>
        </div>
      )}

      {emergency?.result_code === '-9008' && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900 shadow-sm">
          <AlertTriangle className="h-6 w-6 shrink-0 text-amber-600 mt-0.5" />
          <div className="text-sm">
            <h4 className="font-bold">⚠️ CẢNH BÁO: HẾT HẠN NGẠCH FACE ID TRÊN HANET CLOUD (-9008)</h4>
            <p className="mt-1 text-amber-700">
              Hệ thống đã chạm ngưỡng Face ID tối đa của gói. Hãy liên hệ HANET để mua thêm gói trước khi mở lại cổng nộp ảnh.
            </p>
          </div>
        </div>
      )}

      {/* 2. Metric Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between text-gray-500">
            <span className="text-xs font-semibold uppercase">Tổng sĩ số</span>
            <Users className="h-4 w-4 text-gray-400" />
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">{metrics.total_students}</div>
          <div className="mt-1 text-xs text-gray-400">{data.total_classes} lớp học</div>
        </div>

        <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 shadow-sm">
          <div className="flex items-center justify-between text-emerald-700">
            <span className="text-xs font-semibold uppercase">Đã thành công</span>
            <CheckCircle2 className="h-4 w-4" />
          </div>
          <div className="mt-2 text-2xl font-bold text-emerald-900">{metrics.total_success}</div>
          <div className="mt-1 text-xs text-emerald-600">
            {metrics.total_students ? ((metrics.total_success / metrics.total_students) * 100).toFixed(1) : 0}% hoàn thành
          </div>
        </div>

        <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 shadow-sm">
          <div className="flex items-center justify-between text-amber-700">
            <span className="text-xs font-semibold uppercase">Đang xử lý</span>
            <Clock className="h-4 w-4" />
          </div>
          <div className="mt-2 text-2xl font-bold text-amber-900">{metrics.total_pending}</div>
          <div className="mt-1 text-xs text-amber-600">Trong hàng đợi BullMQ</div>
        </div>

        <div className="rounded-xl border border-orange-200 bg-orange-50/50 p-4 shadow-sm">
          <div className="flex items-center justify-between text-orange-700">
            <span className="text-xs font-semibold uppercase">Cần duyệt ảnh</span>
            <AlertCircle className="h-4 w-4" />
          </div>
          <div className="mt-2 text-2xl font-bold text-orange-900">{metrics.total_manual_review}</div>
          <div className="mt-1 text-xs text-orange-600">Lỗi -9006, -909 hoặc retry ≥ 3</div>
        </div>

        <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-4 shadow-sm">
          <div className="flex items-center justify-between text-rose-700">
            <span className="text-xs font-semibold uppercase">Lỗi hệ thống</span>
            <AlertOctagon className="h-4 w-4" />
          </div>
          <div className="mt-2 text-2xl font-bold text-rose-900">{metrics.total_error}</div>
          <div className="mt-1 text-xs text-rose-600">Cần admin can thiệp</div>
        </div>
      </div>

      {/* 3. Dung lượng Face ID Cloud */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HardDrive className="h-5 w-5 text-gray-500" />
            <span className="text-sm font-bold text-gray-800">Dung lượng Face ID Cloud (HANET)</span>
          </div>
          <span className="text-sm font-semibold text-gray-600">
            {face_quota.used.toLocaleString()} / {face_quota.limit.toLocaleString()} Face ID ({face_quota.percent}%)
          </span>
        </div>
        <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-gray-100">
          <div 
            className={`h-full transition-all duration-500 ${
              face_quota.percent > 90 ? 'bg-red-500' : face_quota.percent > 75 ? 'bg-amber-500' : 'bg-blue-600'
            }`}
            style={{ width: `${Math.min(face_quota.percent, 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
};
