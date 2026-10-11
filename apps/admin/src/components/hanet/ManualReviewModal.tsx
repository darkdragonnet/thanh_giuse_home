import React from 'react';
import { AlertTriangle, CheckCircle2, X, RefreshCw } from 'lucide-react';

export interface ConflictItem {
  id: number;
  studentId?: number;
  aliasId: string;
  cloudPersonId?: string | null;
  cloudAliasId?: string | null;
  cloudName?: string | null;
  conflictType: string;
  status: string;
  createdAt: string;
}

interface ManualReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  conflicts: ConflictItem[];
  onResolve?: (id: number) => void;
}

export const ManualReviewModal: React.FC<ManualReviewModalProps> = ({
  isOpen,
  onClose,
  conflicts,
  onResolve,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="relative max-w-2xl w-full bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="p-5 border-b border-gray-100 bg-amber-50/60 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-amber-100 rounded-xl text-amber-700">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-gray-900 text-base">
                Đối Soát Thủ Công (Manual Review)
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Các bản ghi xung đột (-9005) hoặc không tìm thấy PersonID (-5011) cần Admin xác thực
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* List */}
        <div className="p-5 overflow-y-auto space-y-3 flex-1">
          {conflicts.length === 0 ? (
            <div className="text-center py-10 text-gray-400 space-y-2">
              <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto" />
              <p className="text-sm font-medium text-gray-600">
                Không có hồ sơ nào cần can thiệp thủ công!
              </p>
              <p className="text-xs text-gray-400">
                Mọi tác vụ đồng bộ đều khớp hoàn toàn với dữ liệu HANET Cloud.
              </p>
            </div>
          ) : (
            conflicts.map((item) => (
              <div
                key={item.id}
                className="p-4 border border-gray-200 rounded-xl bg-gray-50/50 space-y-2 hover:border-gray-300 transition"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-sm text-gray-900">
                      {item.aliasId}
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">
                      {item.conflictType}
                    </span>
                  </div>
                  <span className="text-[11px] text-gray-400">
                    {new Date(item.createdAt).toLocaleString('vi-VN')}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs text-gray-600 bg-white p-2.5 rounded-lg border border-gray-100">
                  <div>
                    <span className="text-gray-400 block text-[10px]">Cloud PersonID</span>
                    <span className="font-mono font-medium">{item.cloudPersonId || 'Trống'}</span>
                  </div>
                  <div>
                    <span className="text-gray-400 block text-[10px]">Cloud Alias</span>
                    <span className="font-mono font-medium text-rose-600">{item.cloudAliasId || 'Trống'}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-gray-400 block text-[10px]">Họ tên trên Cloud</span>
                    <span className="font-medium">{item.cloudName || 'N/A'}</span>
                  </div>
                </div>

                <div className="pt-1 flex justify-end gap-2">
                  {onResolve && (
                    <button
                      onClick={() => onResolve(item.id)}
                      className="px-3 py-1.5 bg-gray-900 hover:bg-gray-800 text-white rounded-lg text-xs font-medium transition flex items-center gap-1.5"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Đánh dấu Đã xử lý
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-100 bg-gray-50 flex items-center justify-between text-xs text-gray-500">
          <span>Quy tắc: Tuyệt đối không xóa person_id ngoài ý muốn.</span>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 font-medium rounded-xl transition"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
};
