import React, { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import { apiClient } from '../../api/client';

export interface StudentSeedInput {
  classCode: string;
  name: string;
}

export interface Stage1ExecutionResult {
  totalImported: number;
  insertedStudentsCount: number;
  skippedDuplicateCount: number;
  classesCreated: number;
  matchedCloudFaces: number;
  matchedFromExcelCount?: number;
  autoInsertedFromCloudCount?: number;
  emptyNewStudents: number;
  executionDurationMs: number;
}

interface BatchSeedModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

const sanitizeStudentName = (rawName: string): string => {
  return rawName
    .replace(/^\s*\d+[\.\-\/\)\s]\s*/, '')
    .trim()
    .replace(/\s+/g, ' ');
};

export const BatchSeedModal: React.FC<BatchSeedModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [data, setData] = useState<StudentSeedInput[]>([]);
  const [fileName, setFileName] = useState<string>('');
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<Stage1ExecutionResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const resetModalState = () => {
    setData([]);
    setFileName('');
    setErrorMsg(null);
    setResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleClose = () => {
    if (isProcessing) return;
    resetModalState();
    onClose();
  };

  // Chuẩn hóa cấu trúc cột linh hoạt (Chấp nhận: classCode/Mã lớp/Lớp, name/Họ và tên + ghép Tên Thánh nếu tách cột)
  const normalizeAndSetData = (rawList: any[]) => {
    const normalized: StudentSeedInput[] = [];

    for (const row of rawList) {
      if (!row || typeof row !== 'object') continue;

      const rawClassCode = String(
        row.classCode ??
          row.class_code ??
          row['Mã lớp'] ??
          row['Mã Lớp'] ??
          row['Ma lop'] ??
          row['Lớp'] ??
          row['Lop'] ??
          row['Class'] ??
          ''
      )
        .trim()
        .toUpperCase();

      const rawSaintName = String(
        row.saintName ??
          row['Tên Thánh'] ??
          row['Tên thánh'] ??
          row['Ten Thanh'] ??
          row['Ten thanh'] ??
          ''
      ).trim();

      const rawFullName = String(
        row.name ??
          row.full_name ??
          row['Họ và tên'] ??
          row['Họ Và Tên'] ??
          row['Họ tên'] ??
          row['Ho va ten'] ??
          row['Ho ten'] ??
          row['Tên'] ??
          row['Ten'] ??
          ''
      ).trim();

      const combinedName =
        rawSaintName &&
        rawFullName &&
        !rawFullName.toLowerCase().startsWith(rawSaintName.toLowerCase())
          ? `${rawSaintName} ${rawFullName}`
          : rawFullName;

      const cleanName = sanitizeStudentName(combinedName);

      if (rawClassCode && cleanName.length >= 2) {
        normalized.push({ classCode: rawClassCode, name: cleanName });
      }
    }

    if (normalized.length === 0) {
      setErrorMsg(
        'Không tìm thấy dữ liệu hợp lệ. Đảm bảo file có cột "Mã lớp" (hoặc classCode) và "Họ và tên" (hoặc name).'
      );
      setData([]);
    } else {
      setData(normalized);
    }
  };

  const processSelectedFile = (file: File) => {
    setErrorMsg(null);
    setResult(null);
    setFileName(file.name);

    const ext = file.name.split('.').pop()?.toLowerCase();

    if (ext === 'json') {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const parsed = JSON.parse(event.target?.result as string);
          if (Array.isArray(parsed)) {
            normalizeAndSetData(parsed);
          } else {
            setErrorMsg('File JSON phải chứa một mảng đối tượng học sinh.');
          }
        } catch {
          setErrorMsg('File JSON không đúng định dạng cú pháp.');
        }
      };
      reader.readAsText(file, 'utf-8');
    } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const buffer = new Uint8Array(event.target?.result as ArrayBuffer);
          const wb = XLSX.read(buffer, { type: 'array', codepage: 65001 });
          const firstSheetName = wb.SheetNames[0];
          if (!firstSheetName) {
            setErrorMsg('File Excel/CSV không có trang tính (sheet) nào.');
            return;
          }
          const firstSheet = wb.Sheets[firstSheetName]!;
          const rawRows: any[] = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
          normalizeAndSetData(rawRows);
        } catch {
          setErrorMsg('Không thể đọc file Excel/CSV. Vui lòng kiểm tra lại định dạng file.');
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setErrorMsg('Vui lòng chọn file có định dạng .xlsx, .xls, .csv hoặc .json');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    processSelectedFile(file);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processSelectedFile(file);
    }
  };

  // Thống kê nhanh danh sách lớp
  const uniqueClasses = Array.from(new Set(data.map((d) => d.classCode)));

  // Gọi API thực thi Transaction Giai đoạn 1 (< 100ms)
  const handleExecuteSeed = async () => {
    if (data.length === 0) return;
    setIsProcessing(true);
    setErrorMsg(null);

    try {
      const resData = await apiClient.post<{
        success: boolean;
        data: Stage1ExecutionResult;
        message?: string;
      }>('/stage1/snapshot-seed', { items: data });

      if (!resData.success) {
        throw new Error(resData.message || 'Lỗi khi thực thi Giai đoạn 1');
      }

      setResult(resData.data);
      if (onSuccess) onSuccess();
    } catch (err: any) {
      setErrorMsg(err.message || 'Lỗi hệ thống khi nạp dữ liệu Giai đoạn 1.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownloadSample = () => {
    const sample = [
      { 'Mã lớp': 'KT1A', 'Họ và tên': 'Phêrô Nguyễn Văn A' },
      { 'Mã lớp': 'KT1A', 'Họ và tên': 'Maria Trần Thị B' },
      { 'Mã lớp': 'TS2B', 'Họ và tên': 'Giuse Lê Văn C' },
    ];
    const ws = XLSX.utils.json_to_sheet(sample);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mau_Hoc_Sinh');
    XLSX.writeFile(wb, 'mau_danh_sach_hoc_sinh.xlsx');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden border border-gray-100 animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-blue-600 to-indigo-700 text-white flex justify-between items-center">
          <div>
            <h3 className="text-lg font-bold">
              Nạp Hàng Loạt 1.200 Học Sinh (Giai đoạn 1)
            </h3>
            <p className="text-xs text-blue-100">
              Tự động tạo lớp, sinh QR Token 16 ký tự và đối soát Offline với bảng staging_cloud_faces trong &lt; 100ms
            </p>
          </div>
          <button
            onClick={handleClose}
            className="text-white/80 hover:text-white p-1 rounded-lg hover:bg-white/10"
            title="Đóng"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 max-h-[78vh] overflow-y-auto">
          {errorMsg && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm flex items-start space-x-2">
              <span className="font-bold shrink-0">Lỗi:</span>
              <span>{errorMsg}</span>
            </div>
          )}

          {!result ? (
            <>
              {/* Dropzone Area */}
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all duration-200 group ${
                  isDragging
                    ? 'border-blue-600 bg-blue-50'
                    : 'border-gray-300 hover:border-blue-500 hover:bg-blue-50/50'
                }`}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                  accept=".xlsx,.xls,.csv,.json"
                  className="hidden"
                />
                <div className="mx-auto w-12 h-12 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform text-xl">
                  📁
                </div>
                <p className="text-sm font-semibold text-gray-700">
                  {fileName
                    ? `File đã chọn: ${fileName}`
                    : 'Kéo thả hoặc nhấp để tải file danh sách (.xlsx, .csv, .json)'}
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  Đọc trực tiếp trên trình duyệt (0 MB tải bộ nhớ máy chủ), hỗ trợ chống trùng Idempotent Skip
                </p>
              </div>

              <div className="flex justify-between items-center text-xs">
                <span className="text-gray-500">
                  Chỉ cần 2 cột bắt buộc: <strong>Mã lớp</strong> và <strong>Họ và tên</strong> (tự động ghép cột <em>Tên Thánh</em> nếu có).
                </span>
                <button
                  type="button"
                  onClick={handleDownloadSample}
                  className="text-blue-600 hover:underline font-semibold"
                >
                  ⬇ Tải file Excel mẫu (.xlsx)
                </button>
              </div>

              {/* Data Preview Summary */}
              {data.length > 0 && (
                <div className="bg-gray-50 rounded-lg p-4 border border-gray-200 space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Tổng số học sinh nhận diện:</span>
                    <strong className="text-blue-600 text-base">{data.length} em</strong>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Số lượng lớp phát hiện:</span>
                    <strong className="text-indigo-600">{uniqueClasses.length} lớp</strong>
                  </div>
                  <div>
                    <span className="text-xs text-gray-500 block mb-1">
                      Mã lớp tìm thấy ({uniqueClasses.length}):
                    </span>
                    <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto pr-1">
                      {uniqueClasses.map((code) => (
                        <span
                          key={code}
                          className="px-2 py-0.5 bg-white border border-gray-300 text-gray-700 rounded text-xs font-mono font-semibold"
                        >
                          {code}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="border-t border-gray-200 pt-2">
                    <span className="text-xs text-gray-500 block mb-1">
                      Xem trước 5 dòng đầu tiên:
                    </span>
                    <div className="space-y-1 text-xs text-gray-700 font-mono bg-white p-2 rounded border border-gray-100">
                      {data.slice(0, 5).map((item, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <span className="text-gray-400 w-5">{idx + 1}.</span>
                          <span className="px-1.5 py-0.2 bg-blue-50 text-blue-700 rounded font-bold">
                            {item.classCode}
                          </span>
                          <span className="font-sans font-medium text-gray-800">
                            {item.name}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            /* Execution Result State */
            <div className="bg-green-50 border border-green-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center space-x-2 text-green-800 font-bold">
                <span className="text-xl">✅</span>
                <span>Nạp Dữ Liệu & Đối Soát Offline Hoàn Tất Siêu Tốc!</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-white p-3 rounded-lg border border-green-100 shadow-sm">
                  <span className="text-gray-500 text-xs block">Thời gian Transaction</span>
                  <strong className="text-green-700 text-base font-mono">
                    {result.executionDurationMs} ms
                  </strong>
                </div>
                <div className="bg-white p-3 rounded-lg border border-green-100 shadow-sm">
                  <span className="text-gray-500 text-xs block">Học sinh thêm mới / Tổng file</span>
                  <strong className="text-blue-700 text-base">
                    {result.insertedStudentsCount} / {result.totalImported} em
                  </strong>
                  {result.skippedDuplicateCount > 0 && (
                    <span className="text-[11px] text-amber-600 block">
                      (Bỏ qua {result.skippedDuplicateCount} em đã tồn tại)
                    </span>
                  )}
                </div>
                <div className="bg-white p-3 rounded-lg border border-green-100 shadow-sm">
                  <span className="text-gray-500 text-xs block">Khớp sẵn HANET Cloud</span>
                  <strong className="text-emerald-700 text-base font-semibold">
                    {result.matchedCloudFaces} em (status: success)
                  </strong>
                </div>
                <div className="bg-white p-3 rounded-lg border border-green-100 shadow-sm">
                  <span className="text-gray-500 text-xs block">Học sinh mới cấp QR</span>
                  <strong className="text-indigo-700 text-base font-semibold">
                    {result.emptyNewStudents} em (status: empty)
                  </strong>
                </div>
              </div>
              <p className="text-xs text-gray-600 italic">
                * Đã tạo mới tự động <strong>{result.classesCreated}</strong> lớp học chưa có trong CSDL. Học sinh khớp sẵn trên Cloud đã được khóa nguyên tử để bảo toàn dữ liệu; các em mới đã được cấp mã <code>qr_token</code> 16 ký tự cố định.
              </p>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex justify-end space-x-3">
          <button
            onClick={handleClose}
            disabled={isProcessing}
            className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-100 font-medium transition"
          >
            {result ? 'Đóng' : 'Hủy bỏ'}
          </button>

          {!result && (
            <button
              onClick={handleExecuteSeed}
              disabled={data.length === 0 || isProcessing}
              className={`px-5 py-2 rounded-lg text-sm font-semibold text-white transition flex items-center space-x-2 ${
                data.length === 0 || isProcessing
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700 shadow-md shadow-blue-500/20'
              }`}
            >
              {isProcessing ? (
                <>
                  <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8H4z"
                    />
                  </svg>
                  <span>Đang xử lý Transaction...</span>
                </>
              ) : (
                <span>Bắt đầu Nạp & Đối soát Snapshot</span>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
