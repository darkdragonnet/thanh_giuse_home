import React, { useEffect, useState } from 'react';
import { apiClient } from '../../api/client';
import { X, CheckCircle2, AlertCircle, Loader2, ArrowRight } from 'lucide-react';

export interface SyncBatchStatus {
  batchId: string;
  total: number;
  processed: number;
  success: number;
  failed: number;
  isDone: boolean;
  createdAt?: string;
}

interface SyncProgressDrawerProps {
  batchId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onCompleted?: () => void;
}

export const SyncProgressDrawer: React.FC<SyncProgressDrawerProps> = ({
  batchId,
  isOpen,
  onClose,
  onCompleted,
}) => {
  const [status, setStatus] = useState<SyncBatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasTriggeredCompletedRef = React.useRef(false);

  useEffect(() => {
    if (!isOpen || !batchId) {
      setStatus(null);
      setError(null);
      hasTriggeredCompletedRef.current = false;
      return;
    }

    let intervalId: any = null;

    const fetchStatus = async () => {
      try {
        const res = await apiClient.get<{ success: boolean; data: SyncBatchStatus }>(
          `/sync-batches/${batchId}/status`
        );
        if (res.success && res.data) {
          setStatus(res.data);
          const isFinished = res.data.isDone || (res.data.total > 0 && res.data.processed >= res.data.total);
          if (isFinished) {
            if (intervalId) {
              clearInterval(intervalId);
              intervalId = null;
            }
            if (!hasTriggeredCompletedRef.current) {
              hasTriggeredCompletedRef.current = true;
              if (onCompleted) {
                onCompleted();
              }
            }
          }
        }
      } catch (err: any) {
        setError(err.message || 'Không thể lấy thông tin tiến độ');
      }
    };

    // Polling ban đầu ngay khi mở
    fetchStatus();

    // Short Polling chu kỳ 3.000 ms (ADR-004)
    intervalId = setInterval(() => {
      // Chỉ poll khi tab đang hiển thị
      if (document.visibilityState === 'visible') {
        fetchStatus();
      }
    }, 3000);

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [isOpen, batchId, onCompleted]);

  if (!isOpen) return null;

  const total = status?.total || 0;
  const processed = status?.processed || 0;
  const success = status?.success || 0;
  const failed = status?.failed || 0;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const isDone = status?.isDone || (total > 0 && processed >= total);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm transition-opacity">
      <div className="w-full max-w-md bg-white shadow-2xl h-full flex flex-col justify-between animate-in slide-in-from-right duration-300">
        {/* Header */}
        <div className="p-5 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
          <div>
            <h3 className="font-semibold text-gray-900 text-lg flex items-center gap-2">
              {!isDone ? (
                <Loader2 className="w-5 h-5 text-indigo-600 animate-spin" />
              ) : (
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              )}
              Tiến Độ Đồng Bộ AliasID
            </h3>
            <p className="text-xs text-gray-500 font-mono mt-0.5">Mã Batch: {batchId || 'N/A'}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 flex-1 overflow-y-auto space-y-6">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Progress Bar */}
          <div className="space-y-2">
            <div className="flex justify-between items-center text-sm">
              <span className="font-medium text-gray-700">Tiến trình hàng đợi BullMQ</span>
              <span className="font-bold text-indigo-600">{percent}%</span>
            </div>
            <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  isDone ? 'bg-emerald-500' : 'bg-indigo-600'
                }`}
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-500">
              <span>Đã xử lý: {processed}/{total}</span>
              <span>{isDone ? 'Đã hoàn tất lô' : 'Đang xử lý tuần tự (Concurrency: 1)'}</span>
            </div>
          </div>

          {/* Metrics Grid */}
          <div className="grid grid-cols-3 gap-3">
            <div className="p-4 rounded-xl bg-gray-50 border border-gray-100 text-center">
              <p className="text-xs text-gray-500 font-medium">Tổng số job</p>
              <p className="text-xl font-bold text-gray-900 mt-1">{total}</p>
            </div>
            <div className="p-4 rounded-xl bg-emerald-50/70 border border-emerald-100 text-center">
              <p className="text-xs text-emerald-700 font-medium">Thành công</p>
              <p className="text-xl font-bold text-emerald-700 mt-1">{success}</p>
            </div>
            <div className="p-4 rounded-xl bg-rose-50/70 border border-rose-100 text-center">
              <p className="text-xs text-rose-700 font-medium">Cần duyệt</p>
              <p className="text-xl font-bold text-rose-700 mt-1">{failed}</p>
            </div>
          </div>

          {/* Quy chuẩn an toàn */}
          <div className="p-4 rounded-xl bg-blue-50/50 border border-blue-100 text-xs text-blue-900 space-y-1.5">
            <p className="font-semibold flex items-center gap-1.5">
              <ArrowRight className="w-3.5 h-3.5 text-blue-600" />
              Bảo vệ Tài nguyên VPS 3GB:
            </p>
            <p className="text-blue-700 leading-relaxed">
              Các tác vụ được xử lý tuần tự từng người một (Rate limit HANET 30 req/phút). Dữ liệu đối soát tự động đồng bộ hai chiều giữa Cloud và Postgres.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-gray-100 bg-gray-50 flex items-center justify-between">
          <span className="text-xs text-gray-500">HTTP Polling 3s (ADR-004)</span>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium rounded-xl transition"
          >
            {isDone ? 'Đóng cửa sổ' : 'Ẩn tiến trình'}
          </button>
        </div>
      </div>
    </div>
  );
};
