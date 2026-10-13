import React, { useState, useEffect, useMemo } from 'react';
import { apiClient } from '../../api/client';
import type {
  ParsedCloudResult,
  CloudInspectorResponse,
  CloudErrorCode,
  DataDriftReport,
} from '@thanh-giuse/shared-types';
import {
  Cloud,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Download,
  Search,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  Sparkles,
  Database,
  ShieldAlert,
} from 'lucide-react';
import { SyncProgressDrawer } from './SyncProgressDrawer';
import { ManualReviewModal, ConflictItem } from './ManualReviewModal';
import { BatchSeedModal } from './BatchSeedModal';

const ERROR_BADGE_MAP: Record<CloudErrorCode, { label: string; color: string }> = {
  ERR_EMPTY_ALIAS: { label: 'Trống mã', color: 'bg-rose-100 text-rose-800 border-rose-300' },
  ERR_PARTS_COUNT: { label: 'Sai số phần', color: 'bg-amber-100 text-amber-800 border-amber-300' },
  ERR_EMPTY_SEGMENT: { label: 'Khuyết phần', color: 'bg-orange-100 text-orange-800 border-orange-300' },
  ERR_INVALID_SECTOR: { label: 'Tiền tố lạ', color: 'bg-red-100 text-red-800 border-red-300' },
  ERR_UNKNOWN_CLASS: { label: 'Ngoài từ điển', color: 'bg-purple-100 text-purple-800 border-purple-300' },
  ERR_SECTOR_MISMATCH: { label: 'Lệch sector', color: 'bg-pink-100 text-pink-800 border-pink-300' },
};

export const CloudFaceInspectorTab: React.FC = () => {
  const [data, setData] = useState<CloudInspectorResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sectorFilter, setSectorFilter] = useState<'ALL' | 'TN' | 'LG' | 'ERROR'>('ALL');
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ errors: true });
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [driftData, setDriftData] = useState<DataDriftReport | null>(null);
  const [driftLoading, setDriftLoading] = useState(false);
  const [showDriftModal, setShowDriftModal] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reconcileLoading, setReconcileLoading] = useState(false);
  const [manualReviewOpen, setManualReviewOpen] = useState(false);
  const [isBatchSeedOpen, setIsBatchSeedOpen] = useState(false);
  const [conflictsList, setConflictsList] = useState<ConflictItem[]>([]);
  const [selectedPersonIds, setSelectedPersonIds] = useState<Set<string>>(new Set());

  const toggleSelectPerson = (personID: string) => {
    setSelectedPersonIds((prev) => {
      const next = new Set(prev);
      if (next.has(personID)) {
        next.delete(personID);
      } else {
        next.add(personID);
      }
      return next;
    });
  };

  const toggleSelectGroup = (groupItems: ParsedCloudResult[], checkAll: boolean) => {
    setSelectedPersonIds((prev) => {
      const next = new Set(prev);
      if (checkAll) {
        groupItems.forEach((i) => next.add(i.personID));
      } else {
        groupItems.forEach((i) => next.delete(i.personID));
      }
      return next;
    });
  };

  const fetchDriftData = async () => {
    setDriftLoading(true);
    try {
      const res = await apiClient.get<{ success: boolean; data: DataDriftReport }>('/hanet/data-drift');
      if (res.success && res.data) {
        setDriftData(res.data);
        setShowDriftModal(true);
      }
    } catch (err: any) {
      alert(`Lỗi đối soát dữ liệu: ${err.message || 'Không thể kết nối'}`);
    } finally {
      setDriftLoading(false);
    }
  };

  const fetchData = async (forceRefresh = false) => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await apiClient.get<{ success: boolean; data: CloudInspectorResponse }>(
        `/hanet/cloud-faces${forceRefresh ? '?refresh=true' : ''}`
      );
      if (res.success && res.data) {
        setData(res.data);
        const groupKeys = Object.keys(res.data.summaryByGroup);
        if (groupKeys.length > 0 && groupKeys[0]) {
          setOpenGroups((prev) => ({ ...prev, [groupKeys[0]!]: true }));
        }
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Lỗi tải dữ liệu Cloud');
    } finally {
      setLoading(false);
    }
  };

  const handleReconcileCloud = async () => {
    setReconcileLoading(true);
    try {
      const res = await apiClient.post<{ success: boolean; message: string }>('/reconcile-cloud');
      if (res.success) {
        alert(res.message);
        fetchData(true);
      }
    } catch (err: any) {
      alert(`Lỗi đối soát Cloud: ${err.message || 'Không thể kết nối'}`);
    } finally {
      setReconcileLoading(false);
    }
  };

  // Cấp độ 1: Đồng bộ 1 người lẻ
  const handleSyncSinglePerson = async (person: ParsedCloudResult) => {
    const isConfirm = window.confirm(
      `Đồng bộ chuẩn hóa 1 nhân sự lên HANET Cloud?\n\n` +
      `• Họ tên: ${person.name}\n` +
      `• Mã cũ: ${person.rawAliasID}\n` +
      `• Mã chuẩn hóa mới: ${person.aliasChuanHoaDuKien}\n` +
      `• PersonID: ${person.personID}`
    );
    if (!isConfirm) return;

    try {
      const res = await apiClient.post<{
        success: boolean;
        batchId: string;
        queuedCount: number;
        message: string;
      }>('/hanet/sync-cloud-aliases', { person_ids: [person.personID] });
      if (res.success && res.batchId) {
        setBatchId(res.batchId);
        setDrawerOpen(true);
      } else {
        alert(res.message || 'Không có bản ghi nào cần đồng bộ');
      }
    } catch (err: any) {
      alert(`Lỗi kích hoạt đồng bộ: ${err.message || 'Thất bại'}`);
    }
  };

  // Cấp độ 2: Đồng bộ nhóm chọn lọc (qua checkbox)
  const handleSyncSelectedPersons = async () => {
    const count = selectedPersonIds.size;
    if (count === 0) return;
    const isConfirm = window.confirm(
      `Xác nhận bắt đầu đồng bộ chuẩn hóa ${count} nhân sự đã chọn lên HANET Cloud?\n\n` +
      `• Quy trình 2 bước: updateAliasID -> Delay 120ms -> addPersonToDepartment\n` +
      `• Rate Limit Giãn cách an toàn: 3 giây/người\n` +
      `• Thời gian ước tính: ~${Math.ceil((count * 3.5) / 60)} phút\n\n` +
      `Bạn có muốn tiếp tục?`
    );
    if (!isConfirm) return;

    try {
      const res = await apiClient.post<{
        success: boolean;
        batchId: string;
        queuedCount: number;
        message: string;
      }>('/hanet/sync-cloud-aliases', { person_ids: Array.from(selectedPersonIds) });
      if (res.success && res.batchId) {
        setBatchId(res.batchId);
        setDrawerOpen(true);
        setSelectedPersonIds(new Set());
      } else {
        alert(res.message || 'Không có bản ghi nào cần đồng bộ');
      }

    } catch (err: any) {
      alert(`Lỗi kích hoạt chuẩn hóa nhóm chọn: ${err.message || 'Thất bại'}`);
    }
  };

  // Cấp độ 3: Đồng bộ toàn bộ (độc lập với selection, gửi body rỗng)
  const handleSyncAllCloudAliases = async () => {
    const totalCount = data?.total || 137;
    const isConfirm = window.confirm(
      `Xác nhận bắt đầu tiến trình chuẩn hóa toàn bộ ${totalCount} Face ID trên HANET Cloud lên chuẩn 9 ký tự?\n\n` +
      `• Quy trình 2 bước: updateAliasID -> Delay 120ms -> addPersonToDepartment\n` +
      `• Rate Limit Giãn cách an toàn: 3 giây/người (tần suất ~20 req/phút)\n` +
      `• Ước tính thời gian: ~7 - 8 phút\n\n` +
      `Bạn có muốn tiếp tục?`
    );
    if (!isConfirm) return;

    try {
      const res = await apiClient.post<{
        success: boolean;
        batchId: string;
        queuedCount: number;
        message: string;
      }>('/hanet/sync-cloud-aliases', {});
      if (res.success && res.batchId) {
        setBatchId(res.batchId);
        setDrawerOpen(true);
      } else {
        alert(res.message || 'Không có bản ghi nào cần đồng bộ');
      }
    } catch (err: any) {
      alert(`Lỗi kích hoạt chuẩn hóa Cloud: ${err.message || 'Thất bại'}`);
    }
  };

  const handleSyncClass = async (classId?: number) => {
    try {
      const res = await apiClient.post<{
        success: boolean;
        batchId: string;
        queuedCount: number;
        message: string;
      }>('/sync-alias', classId ? { class_id: classId } : {});
      if (res.success && res.batchId) {
        setBatchId(res.batchId);
        setDrawerOpen(true);
      } else {
        alert(res.message || 'Không có học sinh nào cần đồng bộ');
      }
    } catch (err: any) {
      alert(`Lỗi kích hoạt đồng bộ: ${err.message || 'Thất bại'}`);
    }
  };

  const handleOpenManualReview = () => {
    if (driftData) {
      const items: ConflictItem[] = driftData.driftItems
        .filter((d) => d.type === 'ALIAS_MISMATCH' || d.type === 'DB_ORPHAN')
        .map((d, index) => ({
          id: index + 1,
          aliasId: d.aliasID,
          cloudPersonId: d.personID,
          cloudAliasId: d.aliasID,
          cloudName: d.cloudName || d.studentName,
          conflictType: d.type,
          status: 'pending_review',
          createdAt: new Date().toISOString(),
        }));
      setConflictsList(items);
    }
    setManualReviewOpen(true);
  };

  useEffect(() => {
    fetchData();
  }, []);

  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText(null), 1500);
  };

  // Lọc dữ liệu theo search và filter chips
  const filteredItems = useMemo(() => {
    if (!data) return [];
    return data.items.filter((item) => {
      const matchText =
        item.name.toLowerCase().includes(search.toLowerCase()) ||
        item.rawAliasID.toLowerCase().includes(search.toLowerCase()) ||
        item.personID.includes(search) ||
        (item.aliasChuanHoaDuKien &&
          item.aliasChuanHoaDuKien.toLowerCase().includes(search.toLowerCase()));

      let matchFilter = true;
      if (sectorFilter === 'ERROR') matchFilter = item.isError;
      else if (sectorFilter === 'TN') matchFilter = !item.isError && item.nhom1_nganh === 'TN';
      else if (sectorFilter === 'LG')
        matchFilter = !item.isError && (item.nhom1_nganh === 'LG' || item.nhom1_nganh === 'LM');

      return matchText && matchFilter;
    });
  }, [data, search, sectorFilter]);

  // Nhóm các items hợp lệ theo mã lớp (nhom2_lop)
  const groupedValidItems = useMemo(() => {
    const groups: Record<string, ParsedCloudResult[]> = {};
    filteredItems
      .filter((i) => !i.isError && i.nhom2_lop)
      .forEach((item) => {
        const key = item.nhom2_lop!.toLowerCase();
        if (!groups[key]) groups[key] = [];
        groups[key]!.push(item);
      });
    return groups;
  }, [filteredItems]);

  const errorItems = useMemo(() => filteredItems.filter((i) => i.isError), [filteredItems]);

  const exportCSV = () => {
    if (!data) return;
    let csv =
      '\uFEFFSTT,PersonID,Họ và tên,AliasID Gốc,Số phần,Ngành,Mã nhóm gốc,Tên lớp tiếng Việt,Mã chuẩn hóa,Alias chuẩn hóa dự kiến,Trạng thái,Mã lỗi,Lý do lỗi\n';

    data.items.forEach((item, idx) => {
      csv += `"${idx + 1}","${item.personID}","${item.name}","${item.rawAliasID}","${item.partsCount}","${item.nhom1_nganh || ''}","${item.nhom2_lop || ''}","${item.tenLopTiengViet || ''}","${item.maLopChuanHoa || ''}","${item.aliasChuanHoaDuKien || ''}","${item.isError ? 'LỖI' : 'HỢP LỆ'}","${item.errorCode || ''}","${item.errorReason || ''}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `hanet_cloud_${data.total}_faces_audit_${Date.now()}.csv`;
    link.click();
  };

  const legioTotal = (data?.sectorCounts?.LG || 0) + (data?.sectorCounts?.LM || 0);

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <Cloud className="h-6 w-6 text-blue-600" />
              Tra Cứu & Bóc Tách Face ID Cloud {data ? `(${data.total} Bản Ghi)` : ''}
            </h2>

            {data?.isLiveCloud ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-sm">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                Đang kết nối: HANET Cloud Trực Tiếp (Nhà thờ thánh Giuse - ID: {data.placeID || '998577'})
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                <span className="h-2 w-2 rounded-full bg-indigo-500" />
                Chế độ: Mock Server Giả Lập
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Phân tích cú pháp <code>nhóm1_nhóm2_nhóm3</code> và dự phóng migration map sang{' '}
            <code>TênLớp_MãNhậnDạng</code>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setIsBatchSeedOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-xs font-semibold text-white shadow-sm transition"
          >
            <span>⚡</span>
            <span>Nạp Hàng Loạt Giai Đoạn 1 (1.200 em)</span>
          </button>
          <button
            onClick={handleReconcileCloud}
            disabled={reconcileLoading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-indigo-300 bg-indigo-50 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 shadow-sm disabled:opacity-50"
          >
            <Sparkles className={`h-4 w-4 ${reconcileLoading ? 'animate-spin' : ''}`} />
            Nạp đối soát Cloud (10p)
          </button>
          <button
            onClick={handleSyncAllCloudAliases}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-blue-600 bg-blue-600 text-xs font-semibold text-white hover:bg-blue-700 shadow-sm"
          >
            <Cloud className="h-4 w-4" />
            Đồng bộ Chuẩn Hóa Cloud (9 ký tự)
          </button>
          <button
            onClick={fetchDriftData}
            disabled={driftLoading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-purple-300 bg-purple-50 text-xs font-semibold text-purple-700 hover:bg-purple-100 shadow-sm disabled:opacity-50"
          >
            <Database className={`h-4 w-4 ${driftLoading ? 'animate-pulse' : ''}`} />
            Đối soát CSDL
          </button>
          <button
            onClick={handleOpenManualReview}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-xs font-semibold text-amber-700 hover:bg-amber-100 shadow-sm"
          >
            <AlertTriangle className="h-4 w-4" />
            Duyệt thủ công
          </button>
          <button
            onClick={() => fetchData(true)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 bg-white text-xs font-semibold text-gray-700 hover:bg-gray-50 shadow-sm disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Làm mới Cloud
          </button>
          <button
            onClick={exportCSV}
            disabled={!data}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 shadow-sm disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            Xuất file CSV
          </button>
        </div>
      </div>

      {/* Cảnh báo lỗi nếu có */}
      {errorMessage && (
        <div className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-rose-800 flex items-start gap-3 shadow-sm">
          <AlertTriangle className="h-5 w-5 text-rose-600 mt-0.5 flex-shrink-0" />
          <div>
            <span className="font-bold text-sm">Cảnh Báo Kết Nối HANET Cloud:</span>
            <p className="text-xs mt-1 text-rose-700">{errorMessage}</p>
            {errorMessage.includes('hết hạn') && (
              <p className="text-xs mt-1.5 font-medium text-rose-900 bg-rose-100 p-2 rounded">
                👉 Vui lòng cập nhật biến <code>HANET_ACCESS_TOKEN</code> mới trong file <code>.env</code> và khởi động lại server.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Cảnh báo tự phục hồi cấu hình Place ID */}
      {data?.warningMessage && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 flex items-start gap-3 shadow-sm">
          <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="text-xs space-y-1">
            <span className="font-bold text-sm text-amber-900">Lưu Ý Cấu Hình Địa Điểm HANET:</span>
            <p className="text-amber-800 leading-relaxed">{data.warningMessage}</p>
          </div>
        </div>
      )}

      {/* Cảnh báo nếu 0 bản ghi */}
      {data && data.total === 0 && (
        <div className="rounded-xl border border-rose-200 bg-rose-50/70 p-4 text-rose-900 flex items-start gap-3 shadow-sm">
          <AlertTriangle className="h-5 w-5 text-rose-600 mt-0.5 flex-shrink-0" />
          <div className="text-xs space-y-1">
            <span className="font-bold text-sm text-rose-900">Không Tìm Thấy Dữ Liệu Face ID Trên Cloud:</span>
            <p className="text-rose-800 leading-relaxed">
              HANET Cloud trả về 0 bản ghi cho Địa điểm (PlaceID: <code>{data.placeID || 'Không xác định'}</code>).
              Nếu bạn đang cấu hình nhầm mã thiết bị Camera (ví dụ: <code>C21272C248</code>) thay vì Place ID địa điểm,
              vui lòng sửa tệp <code>.env</code> thành <code>HANET_PLACE_ID=998577</code>, khởi động lại container và bấm <b>"Làm mới Cloud"</b>.
            </p>
          </div>
        </div>
      )}

      {/* Cards Thống Kê Tổng Quan */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-4 rounded-xl border border-gray-200 bg-white shadow-sm">
            <span className="text-xs font-bold uppercase text-gray-400">Tổng Face ID Cloud</span>
            <div className="text-2xl font-bold text-gray-900 mt-1">{data.total}</div>
            <span className="text-xs text-blue-600 font-medium">Hạn ngạch: {data.total} / 50.000</span>
          </div>

          <div className="p-4 rounded-xl border border-blue-200 bg-blue-50/50 shadow-sm">
            <span className="text-xs font-bold uppercase text-blue-700">Thiếu Nhi (TN)</span>
            <div className="text-2xl font-bold text-blue-800 mt-1">{data.sectorCounts.TN}</div>
            <span className="text-xs text-blue-600 font-medium">Gồm giáo lý & GLV</span>
          </div>

          <div className="p-4 rounded-xl border border-indigo-200 bg-indigo-50/50 shadow-sm">
            <span className="text-xs font-bold uppercase text-indigo-700">Lêgiô Mariae (LG/LM)</span>
            <div className="text-2xl font-bold text-indigo-800 mt-1">{legioTotal}</div>
            <span className="text-xs text-indigo-600 font-medium">Praesidium DMHCCC</span>
          </div>

          <div className="p-4 rounded-xl border border-rose-200 bg-rose-50/50 shadow-sm">
            <span className="text-xs font-bold uppercase text-rose-700">Lỗi Dị Biệt (Unparsed)</span>
            <div className="text-2xl font-bold text-rose-800 mt-1">{data.errorCount}</div>
            <span className="text-xs text-rose-600 font-medium">Cần chuẩn hóa thủ công</span>
          </div>
        </div>
      )}

      {/* Thanh Tìm Kiếm & Bộ Lọc */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-80">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Tìm theo Tên, alias cũ, alias mới, personID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-300 pl-9 pr-4 py-2 text-xs focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-1.5">
          {(['ALL', 'TN', 'LG', 'ERROR'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setSectorFilter(tab)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                sectorFilter === tab
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {tab === 'ALL' && `Tất cả (${data?.total || 0})`}
              {tab === 'TN' && `Thiếu Nhi (${data?.sectorCounts.TN || 0})`}
              {tab === 'LG' && `Lêgiô (${legioTotal})`}
              {tab === 'ERROR' && `⚠️ Lỗi cú pháp (${data?.errorCount || 0})`}
            </button>
          ))}
        </div>
      </div>

      {/* Banner Hành Động Nhóm Đã Chọn (Cấp độ 2) */}
      {selectedPersonIds.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-blue-50 border border-blue-200 rounded-xl shadow-sm text-xs animate-in fade-in duration-200">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-white font-bold text-xs">
              {selectedPersonIds.size}
            </span>
            <span className="font-semibold text-blue-900">
              Đã chọn <b>{selectedPersonIds.size}</b> nhân sự để chuẩn hóa
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSyncSelectedPersons}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 shadow-sm"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Cập nhật đã chọn ({selectedPersonIds.size} nhân sự)
            </button>
            <button
              onClick={() => setSelectedPersonIds(new Set())}
              className="px-2.5 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
            >
              Bỏ chọn tất cả
            </button>
          </div>
        </div>
      )}

      {/* KHỐI 1: BẢNG CẢNH BÁO BẢN GHI LỖI (UNPARSED) */}
      {(sectorFilter === 'ALL' || sectorFilter === 'ERROR') && errorItems.length > 0 && (
        <div className="rounded-xl border border-rose-200 bg-white overflow-hidden shadow-sm">
          <div
            onClick={() => toggleGroup('errors')}
            className="flex items-center justify-between px-4 py-3 bg-rose-50 cursor-pointer border-b border-rose-200"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-rose-600" />
              <span className="font-bold text-rose-900 text-sm">
                Danh Sách Lỗi Cú Pháp (Không khớp nhóm1_nhóm2_nhóm3) — {errorItems.length} bản ghi
              </span>
            </div>
            {openGroups['errors'] ? (
              <ChevronDown className="h-4 w-4 text-rose-600" />
            ) : (
              <ChevronRight className="h-4 w-4 text-rose-600" />
            )}
          </div>

          {openGroups['errors'] && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-rose-50/50 text-gray-500 uppercase font-semibold">
                  <tr>
                    <th className="px-4 py-2.5">Ảnh</th>
                    <th className="px-4 py-2.5">Họ và tên</th>
                    <th className="px-4 py-2.5">aliasID Gốc</th>
                    <th className="px-4 py-2.5">Số phần</th>
                    <th className="px-4 py-2.5">Phân loại lỗi</th>
                    <th className="px-4 py-2.5">PersonID</th>
                    <th className="px-4 py-2.5 text-rose-700">Chi tiết lý do</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rose-100 font-mono">
                  {errorItems.map((item) => {
                    const badgeInfo = item.errorCode ? ERROR_BADGE_MAP[item.errorCode] : null;

                    return (
                      <tr key={item.personID} className="hover:bg-rose-50/30">
                        <td className="px-4 py-2">
                          <img
                            src={item.file}
                            alt={item.name}
                            onClick={() => setPreviewImage(item.file)}
                            className="h-8 w-8 rounded-full object-cover border cursor-pointer hover:opacity-80"
                            onError={(e) => {
                              (e.target as any).src =
                                'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="%23ccc" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/></svg>';
                            }}
                          />
                        </td>
                        <td className="px-4 py-2 font-sans font-semibold text-gray-900">{item.name}</td>
                        <td className="px-4 py-2 font-bold text-rose-700 bg-rose-50/50">
                          {item.rawAliasID || '(Rỗng)'}
                        </td>
                        <td className="px-4 py-2 text-gray-600">{item.partsCount} phần</td>
                        <td className="px-4 py-2 font-sans">
                          {badgeInfo ? (
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border ${badgeInfo.color}`}
                            >
                              {badgeInfo.label}
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-gray-500">
                          <div className="flex items-center gap-1.5">
                            <span>{item.personID}</span>
                            <button
                              onClick={() => copyToClipboard(item.personID)}
                              className="text-gray-400 hover:text-gray-600"
                              title="Sao chép PersonID"
                            >
                              {copiedText === item.personID ? (
                                <Check className="h-3 w-3 text-emerald-600" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-2 font-sans text-rose-600 font-medium">
                          {item.errorReason}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* KHỐI 2: DANH SÁCH CÁC NHÓM HỢP LỆ (ACCORDION GOM NHÓM) */}
      {sectorFilter !== 'ERROR' && (
        <div className="space-y-4">
          {Object.entries(groupedValidItems).map(([groupKey, items]) => {
            const firstItem = items[0];
            if (!firstItem) return null;
            const isOpen = openGroups[groupKey];
            const allInGroupSelected =
              items.length > 0 && items.every((i) => selectedPersonIds.has(i.personID));

            return (
              <div
                key={groupKey}
                className="rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm"
              >
                <div
                  onClick={() => toggleGroup(groupKey)}
                  className="flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100/75 cursor-pointer border-b border-gray-200 transition"
                >
                  <div className="flex items-center gap-3">
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 text-gray-500" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-gray-500" />
                    )}
                    <span className="font-bold text-gray-900 text-sm">
                      {firstItem.tenLopTiengViet} ({firstItem.rawAliasID.split('_').slice(0, 2).join('_')})
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200 flex items-center gap-1">
                      <Sparkles className="h-3 w-3" /> Mã chuẩn: {firstItem.maLopChuanHoa}
                    </span>
                    <span className="text-xs text-gray-500 font-medium">
                      ({items.length} thành viên)
                    </span>
                  </div>

                  <span className="text-xs text-emerald-600 font-semibold flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" /> 100% Cú pháp hợp lệ
                  </span>
                </div>

                {isOpen && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-gray-50/50 text-gray-500 uppercase font-semibold">
                        <tr>
                          <th className="px-3 py-2.5 w-8">
                            <input
                              type="checkbox"
                              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                              checked={allInGroupSelected}
                              onChange={(e) => toggleSelectGroup(items, e.target.checked)}
                              title="Chọn toàn bộ nhóm này"
                            />
                          </th>
                          <th className="px-3 py-2.5">Ảnh</th>
                          <th className="px-4 py-2.5">Họ và tên</th>
                          <th className="px-4 py-2.5">aliasID Gốc</th>
                          <th className="px-4 py-2.5 text-blue-700 bg-blue-50/50">
                            Mã Dự Phóng Mới (TênLớp_Mã)
                          </th>
                          <th className="px-4 py-2.5">PersonID</th>
                          <th className="px-4 py-2.5 text-right">Thao tác</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 font-mono">
                        {items.map((item) => (
                          <tr key={item.personID} className="hover:bg-gray-50/50">
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                                checked={selectedPersonIds.has(item.personID)}
                                onChange={() => toggleSelectPerson(item.personID)}
                              />
                            </td>
                            <td className="px-3 py-2">
                              <img
                                src={item.file}
                                alt={item.name}
                                onClick={() => setPreviewImage(item.file)}
                                className="h-8 w-8 rounded-full object-cover border cursor-pointer hover:opacity-80"
                                onError={(e) => {
                                  (e.target as any).src =
                                    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="%23ccc" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/></svg>';
                                }}
                              />
                            </td>
                            <td className="px-4 py-2 font-sans font-semibold text-gray-900">
                              {item.name}
                            </td>
                            <td className="px-4 py-2 text-gray-600">{item.rawAliasID}</td>
                            <td className="px-4 py-2 font-bold text-blue-700 bg-blue-50/30">
                              <span className="px-2 py-0.5 rounded bg-blue-100/70 border border-blue-200">
                                {item.aliasChuanHoaDuKien}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-gray-500">
                              <div className="flex items-center gap-1.5">
                                <span>{item.personID}</span>
                                <button
                                  onClick={() => copyToClipboard(item.personID)}
                                  className="text-gray-400 hover:text-gray-600"
                                  title="Sao chép PersonID"
                                >
                                  {copiedText === item.personID ? (
                                    <Check className="h-3 w-3 text-emerald-600" />
                                  ) : (
                                    <Copy className="h-3 w-3" />
                                  )}
                                </button>
                              </div>
                            </td>
                            <td className="px-4 py-2 text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                <button
                                  onClick={() => handleSyncSinglePerson(item)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 text-[11px] font-sans font-medium transition"
                                  title={`Đồng bộ chuẩn hóa ${item.name} lên Cloud`}
                                >
                                  <Sparkles className="h-3 w-3" />
                                  Đồng bộ
                                </button>
                                <button
                                  onClick={() => setPreviewImage(item.file)}
                                  className="p-1 text-gray-500 hover:text-blue-600 rounded transition"
                                  title="Xem ảnh 1280x736"
                                >
                                  <Eye className="h-4 w-4" />
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
            );
          })}
        </div>
      )}

      {/* Modal Phóng To Ảnh 1280x736 */}
      {previewImage && (
        <div
          onClick={() => setPreviewImage(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        >
          <div
            className="relative max-w-xl w-full bg-white rounded-xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-3 border-b flex justify-between items-center bg-gray-50">
              <span className="text-xs font-bold text-gray-700">
                Ảnh Khuôn Mặt Gốc CDN Cloud (1280×736)
              </span>
              <button
                onClick={() => setPreviewImage(null)}
                className="text-gray-400 hover:text-gray-600 font-bold text-sm"
              >
                ✕
              </button>
            </div>
            <div className="aspect-[16/9] bg-black/5 flex items-center justify-center">
              <img src={previewImage} alt="Cloud Face" className="w-full h-full object-contain" />
            </div>
          </div>
        </div>
      )}
      {/* Modal Đối Soát CSDL (Data Drift) */}
      {showDriftModal && driftData && (
        <div
          onClick={() => setShowDriftModal(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        >
          <div
            className="relative max-w-3xl w-full bg-white rounded-xl overflow-hidden shadow-2xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b flex justify-between items-center bg-purple-50">
              <div className="flex items-center gap-2">
                <Database className="h-5 w-5 text-purple-700" />
                <h3 className="font-bold text-sm text-purple-900">
                  Đối Soát Dữ Liệu: Cloud HANET vs Database Nội Bộ
                </h3>
              </div>
              <button
                onClick={() => setShowDriftModal(false)}
                className="text-gray-400 hover:text-gray-600 font-bold text-sm"
              >
                ✕
              </button>
            </div>

            {/* Thống kê Drift */}
            <div className="p-4 grid grid-cols-4 gap-3 bg-gray-50 border-b">
              <div className="p-2.5 rounded-lg bg-white border text-center">
                <span className="text-[10px] text-gray-500 font-semibold block">Face ID Cloud</span>
                <span className="text-lg font-bold text-gray-900">{driftData.totalCloudFaces}</span>
              </div>
              <div className="p-2.5 rounded-lg bg-white border text-center">
                <span className="text-[10px] text-gray-500 font-semibold block">Học Sinh Trong DB</span>
                <span className="text-lg font-bold text-gray-900">{driftData.totalDbStudents}</span>
              </div>
              <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-center">
                <span className="text-[10px] text-emerald-700 font-semibold block">Khớp Hoàn Toàn</span>
                <span className="text-lg font-bold text-emerald-800">{driftData.matchedCount}</span>
              </div>
              <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-center">
                <span className="text-[10px] text-amber-700 font-semibold block">Chỉ Có Trên Cloud</span>
                <span className="text-lg font-bold text-amber-800">{driftData.cloudOnlyCount}</span>
              </div>
            </div>

            {/* Danh sách Drift */}
            <div className="p-4 overflow-y-auto flex-1">
              <h4 className="text-xs font-bold text-gray-700 uppercase mb-2">
                Chi Tiết Lệch Dữ Liệu ({driftData.driftItems.length} trường hợp)
              </h4>
              {driftData.driftItems.length === 0 ? (
                <div className="p-8 text-center text-gray-500 text-xs">
                  <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
                  Dữ liệu đồng nhất hoàn toàn giữa Cloud và Database!
                </div>
              ) : (
                <div className="space-y-2">
                  {driftData.driftItems.map((item, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded-lg border text-xs flex items-start justify-between bg-white shadow-sm"
                    >
                      <div className="flex items-start gap-2.5">
                        <ShieldAlert className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-gray-900">
                              {item.studentName || item.cloudName || 'Chưa đặt tên'}
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-gray-100 font-mono text-[10px] text-gray-700">
                              {item.aliasID}
                            </span>
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                item.type === 'CLOUD_ONLY'
                                  ? 'bg-blue-100 text-blue-800'
                                  : item.type === 'DB_ORPHAN'
                                  ? 'bg-rose-100 text-rose-800'
                                  : 'bg-purple-100 text-purple-800'
                              }`}
                            >
                              {item.type}
                            </span>
                          </div>
                          <p className="text-gray-500 mt-1">{item.message}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-3 border-t bg-gray-50 flex justify-between items-center">
              <button
                onClick={() => {
                  setShowDriftModal(false);
                  handleSyncClass();
                }}
                className="px-4 py-1.5 rounded-lg bg-indigo-600 text-xs font-semibold text-white hover:bg-indigo-700 shadow-sm"
              >
                Đồng bộ vào Hàng Đợi (BullMQ)
              </button>
              <button
                onClick={() => setShowDriftModal(false)}
                className="px-4 py-1.5 rounded-lg bg-gray-200 text-xs font-semibold text-gray-700 hover:bg-gray-300"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Drawer Giám sát tiến độ đồng bộ Short Polling 3s (ADR-004) */}
      <SyncProgressDrawer
        isOpen={drawerOpen}
        batchId={batchId}
        onClose={() => setDrawerOpen(false)}
        onCompleted={() => {
          setSelectedPersonIds(new Set());
          fetchData(true);
        }}
      />


      {/* Modal Xử lý thủ công các ca xung đột */}
      <ManualReviewModal
        isOpen={manualReviewOpen}
        conflicts={conflictsList}
        onClose={() => setManualReviewOpen(false)}
      />

      {/* Modal Nạp Hàng Loạt Giai Đoạn 1 (1.200 em) */}
      <BatchSeedModal
        isOpen={isBatchSeedOpen}
        onClose={() => setIsBatchSeedOpen(false)}
        onSuccess={() => fetchData(false)}
      />
    </div>
  );
};
