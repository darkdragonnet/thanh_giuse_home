import React, { useState, useEffect } from 'react';
import { apiClient } from '../api/client';
import * as Dialog from '@radix-ui/react-dialog';
import { ShieldAlert, AlertOctagon, RefreshCw, CheckCircle2, Info, Server, Cpu } from 'lucide-react';

export const SystemSettings: React.FC = () => {
  const [isMaintenance, setIsMaintenance] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [statsData, setStatsData] = useState<any>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const fetchSystemStatus = async () => {
    try {
      setLoading(true);
      const res = await apiClient.get<{ success: boolean; data: any }>('/dashboard/stats');
      if (res.success) {
        setIsMaintenance(res.data.system_status.is_maintenance);
        setStatsData(res.data);
      }
    } catch (err: any) {
      console.error('Lỗi khi lấy thông tin hệ thống:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSystemStatus();
  }, []);

  const handleToggleKillSwitch = async () => {
    try {
      setToggling(true);
      const newEnabled = isMaintenance; // Nếu đang bảo trì (true) -> bật lại hệ thống (enabled = true)
      const res = await apiClient.post<{ success: boolean; message: string; requeued_count?: number }>(
        '/settings/kill-switch',
        { enabled: newEnabled }
      );

      setIsMaintenance(!isMaintenance);
      setShowConfirm(false);
      setFeedback(res.message || (newEnabled ? 'Hệ thống đã mở lại tiếp nhận ảnh.' : 'Hệ thống đã bật chế độ bảo trì.'));
      setTimeout(() => setFeedback(null), 5000);
      await fetchSystemStatus();
    } catch (err: any) {
      alert(err.message || 'Không thể thay đổi cờ bảo trì');
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold text-gray-900">Cài đặt Hệ thống & Chốt chặn Khẩn cấp</h3>
          <p className="mt-1 text-xs text-gray-500">
            Quản trị chốt an toàn toàn trường (Global Kill Switch), giám sát hàng đợi và thông điệp bảo trì hệ thống.
          </p>
        </div>

        <button
          onClick={fetchSystemStatus}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 shadow-sm disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Làm mới trạng thái
        </button>
      </div>

      {/* Feedback Message */}
      {feedback && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs font-medium text-blue-900">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-blue-600" />
          <span>{feedback}</span>
        </div>
      )}

      {/* 1. Global Kill Switch Card */}
      <div
        className={`rounded-xl border p-6 shadow-sm transition ${
          isMaintenance ? 'border-red-300 bg-red-50/50' : 'border-emerald-200 bg-emerald-50/20'
        }`}
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-start gap-4">
            <div
              className={`rounded-xl p-3 ${
                isMaintenance ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
              }`}
            >
              <ShieldAlert className="h-7 w-7 shrink-0" />
            </div>

            <div>
              <div className="flex items-center gap-2.5">
                <h4 className="text-base font-bold text-gray-900">Chốt chặn Khẩn cấp Toàn trường (Global Kill Switch)</h4>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-bold border ${
                    isMaintenance
                      ? 'bg-red-100 text-red-800 border-red-200'
                      : 'bg-emerald-100 text-emerald-800 border-emerald-200'
                  }`}
                >
                  {isMaintenance ? 'ĐANG BẢO TRÌ (HÀNG ĐỢI TẠM DỪNG)' : 'HOẠT ĐỘNG BÌNH THƯỜNG'}
                </span>
              </div>

              <p className="mt-2 text-xs text-gray-600 leading-relaxed max-w-2xl">
                Khi kích hoạt bảo trì, toàn bộ link nộp ảnh học sinh toàn trường sẽ bị chặn tiếp nhận (HTTP 403), hàng đợi BullMQ tạm dừng nạp mới và các Webhook từ HANET sẽ được hoãn (deferred). Mở lại hệ thống sẽ kích hoạt tái lập học sinh kẹt lỗi token.
              </p>
            </div>
          </div>

          <button
            onClick={() => setShowConfirm(true)}
            className={`shrink-0 rounded-lg px-5 py-2.5 text-xs font-bold shadow transition ${
              isMaintenance
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-red-600 text-white hover:bg-red-700'
            }`}
          >
            {isMaintenance ? 'Mở lại Tiếp nhận Đăng ký' : 'Kích hoạt Chế độ Bảo trì'}
          </button>
        </div>
      </div>

      {/* 2. Maintenance Message Notice Card */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-3">
        <div className="flex items-center gap-2 text-gray-900 font-bold text-sm">
          <Info className="h-4 w-4 text-blue-600" />
          <span>Thông điệp Bảo trì Hệ thống</span>
        </div>

        <p className="text-xs text-gray-500">
          Thông điệp hiển thị cho học sinh và phụ huynh khi truy cập cổng nộp ảnh trong thời gian bảo trì.
        </p>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Nội dung thông điệp bảo trì hiện tại
          </label>
          <input
            type="text"
            readOnly
            disabled
            value="Hệ thống đang tạm khóa để bảo trì kết nối máy chủ"
            className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-2 text-xs text-gray-600 cursor-not-allowed"
          />
          <p className="mt-1 text-[11px] text-gray-400 italic">
            * Backend API hiện tại đang cố định thông điệp mặc định chuẩn; chưa hỗ trợ endpoint tuỳ biến thông điệp (chỉ hiển thị theo thiết kế).
          </p>
        </div>
      </div>

      {/* 3. System Constraints & VPS Overview */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-2">
          <div className="flex items-center gap-2 font-bold text-gray-900 text-sm">
            <Cpu className="h-4 w-4 text-indigo-600" />
            <span>Ràng buộc Phần cứng & Hạ tầng VPS</span>
          </div>
          <ul className="text-xs text-gray-600 space-y-1.5 list-disc list-inside">
            <li>Hạ tầng: VPS Ubuntu 3 vCPU, 3.0 GB RAM, 2.0 GB Swap</li>
            <li>Giới hạn bộ nhớ Docker Container: Max 2.112 MB</li>
            <li>Độ song song BullMQ Worker Concurrency: Cố định 1 luồng</li>
            <li>Giới hạn Nginx Payload: Tối đa 5MB / ảnh</li>
          </ul>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-2">
          <div className="flex items-center gap-2 font-bold text-gray-900 text-sm">
            <Server className="h-4 w-4 text-emerald-600" />
            <span>Tình trạng Hạn ngạch & Khẩn cấp</span>
          </div>
          <div className="text-xs text-gray-600 space-y-1.5">
            <div>
              Hạn ngạch khuôn mặt đã dùng:{' '}
              <span className="font-bold text-gray-900">
                {statsData?.face_quota?.used ?? 0} / {statsData?.face_quota?.limit ?? 50000} ({statsData?.face_quota?.percent ?? 0}%)
              </span>
            </div>
            <div>
              Cảnh báo khẩn cấp:{' '}
              {statsData?.system_status?.emergency_alert ? (
                <span className="font-bold text-rose-600">
                  [{statsData.system_status.emergency_alert.result_code}] {statsData.system_status.emergency_alert.result_message}
                </span>
              ) : (
                <span className="font-semibold text-emerald-600">Không có cảnh báo nghiêm trọng (-103/-9008)</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Confirmation Dialog */}
      <Dialog.Root open={showConfirm} onOpenChange={setShowConfirm}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-2xl">
            <div className="flex items-center gap-3 text-red-600">
              <AlertOctagon className="h-6 w-6 shrink-0" />
              <Dialog.Title className="text-lg font-bold">
                Xác nhận thay đổi chế độ hệ thống
              </Dialog.Title>
            </div>
            <Dialog.Description className="mt-3 text-xs text-gray-600 leading-relaxed">
              {isMaintenance
                ? 'Bạn có chắc chắn muốn TẮT BẢO TRÌ và mở lại toàn bộ cổng nộp ảnh cho học sinh? Hệ thống sẽ phục hồi hàng đợi và tự động nạp lại các học sinh bị lỗi token trước đó.'
                : 'CẢNH BÁO: Bật chế độ bảo trì sẽ lập tức chặn học sinh toàn trường nộp ảnh mới (HTTP 403), tạm dừng hàng đợi BullMQ và hoãn xử lý webhook từ Cloud HANET.'}
            </Dialog.Description>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                disabled={toggling}
                className="rounded-lg bg-gray-100 px-4 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-200"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={handleToggleKillSwitch}
                disabled={toggling}
                className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {toggling ? 'Đang thực hiện...' : 'Xác nhận thực hiện'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
};
