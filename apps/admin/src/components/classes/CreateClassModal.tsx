import React, { useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { apiClient } from '../../api/client';
import {
  Plus,
  Dices,
  Loader2,
  AlertCircle,
  CheckCircle2,
  X,
  GraduationCap,
  Users,
  Sparkles,
} from 'lucide-react';
import { CATECHISM_GROUPS, SPECIAL_UNITS } from '@thanh-giuse/shared-types';

interface CreateClassModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

type ClassMode = 'catechism' | 'special';

const LEVELS = [1, 2, 3] as const;
const SECTIONS = ['A', 'B', 'C', 'D'] as const;

export const CreateClassModal: React.FC<CreateClassModalProps> = ({
  open,
  onOpenChange,
  onSuccess,
}) => {
  const [mode, setMode] = useState<ClassMode>('catechism');

  // Chế độ Thiếu Nhi Giáo Lý
  const [selectedGroup, setSelectedGroup] = useState<string>(CATECHISM_GROUPS[0].code);
  const [selectedLevel, setSelectedLevel] = useState<number>(1);
  const [selectedSection, setSelectedSection] = useState<string>('A');

  // Chế độ Ban Ngành / Giới
  const [selectedUnit, setSelectedUnit] = useState<string>(SPECIAL_UNITS[0].code);

  // Thông tin chung
  const [teacherName, setTeacherName] = useState('');
  const [pinSuffix, setPinSuffix] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Sinh ngẫu nhiên 4 ký tự Hex cho PIN
  const generateRandomSuffix = () => {
    return Math.random().toString(16).substring(2, 6).toUpperCase();
  };

  const handleRollDicePin = () => {
    setPinSuffix(generateRandomSuffix());
  };

  // Khởi tạo pinSuffix ban đầu khi mở modal
  useEffect(() => {
    if (open && !pinSuffix) {
      setPinSuffix(generateRandomSuffix());
    }
  }, [open, pinSuffix]);

  // Tính toán Mã Lớp (code), Tên Lớp (name), và Mã PIN (token)
  let code = '';
  let name = '';

  if (mode === 'catechism') {
    const group = CATECHISM_GROUPS.find((g) => g.code === selectedGroup) || CATECHISM_GROUPS[0];
    code = `${group.code}${selectedLevel}${selectedSection}`;
    name = `Lớp ${group.name} ${selectedLevel}${selectedSection}`;
  } else {
    const unit = SPECIAL_UNITS.find((u) => u.code === selectedUnit) || SPECIAL_UNITS[0];
    code = unit.code;
    name = unit.name;
  }

  const token = `PIN_${code}_${pinSuffix || 'A1B2'}`;

  const resetForm = () => {
    setMode('catechism');
    setSelectedGroup(CATECHISM_GROUPS[0].code);
    setSelectedLevel(1);
    setSelectedSection('A');
    setSelectedUnit(SPECIAL_UNITS[0].code);
    setTeacherName('');
    setPinSuffix(generateRandomSuffix());
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    setIsSubmitting(true);
    try {
      await apiClient.post('/classes', {
        code,
        name,
        teacher_name: teacherName.trim() || null,
        token,
      });

      setSuccessMessage(`Đã tạo thành công: ${code} - ${name}!`);
      onSuccess();
      setTimeout(() => {
        resetForm();
        onOpenChange(false);
      }, 700);
    } catch (err: any) {
      if (err.message && (err.message.includes('409') || err.message.toLowerCase().includes('đã tồn tại'))) {
        setErrorMessage(`Mã '${code}' đã tồn tại trong hệ thống. Vui lòng chọn phân lớp khác!`);
      } else {
        setErrorMessage(err.message || 'Có lỗi xảy ra khi tạo lớp học');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) resetForm();
        onOpenChange(isOpen);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl max-h-[92vh] overflow-y-auto">
          {/* Header */}
          <div className="flex items-center justify-between border-b pb-3">
            <Dialog.Title className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <div className="rounded-lg bg-blue-50 p-1.5 text-blue-600">
                <Plus className="h-5 w-5" />
              </div>
              Tạo Lớp / Đơn Vị Mới
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>

          {errorMessage && (
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 border border-rose-200">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {successMessage && (
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700 border border-emerald-200">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{successMessage}</span>
            </div>
          )}

          {/* Mode Switcher Tabs */}
          <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-gray-100 p-1">
            <button
              type="button"
              onClick={() => {
                setMode('catechism');
                setErrorMessage(null);
              }}
              className={`flex items-center justify-center gap-2 rounded-lg py-2 text-xs font-semibold transition-all ${
                mode === 'catechism'
                  ? 'bg-white text-blue-600 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              <GraduationCap className="h-4 w-4" />
              Thiếu Nhi Giáo Lý (45 Lớp)
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('special');
                setErrorMessage(null);
              }}
              className={`flex items-center justify-center gap-2 rounded-lg py-2 text-xs font-semibold transition-all ${
                mode === 'special'
                  ? 'bg-white text-indigo-600 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              <Users className="h-4 w-4" />
              Ban Ngành / Giới (7 Đơn Vị)
            </button>
          </div>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {/* PHẦN 1: TÙY CHỌN THEO CHẾ ĐỘ */}
            {mode === 'catechism' ? (
              <div className="space-y-3.5 rounded-xl border border-blue-100 bg-blue-50/40 p-3.5">
                {/* Chọn Khối */}
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-600 mb-1.5">
                    1. Khối Giáo Lý
                  </label>
                  <div className="grid grid-cols-5 gap-1.5">
                    {CATECHISM_GROUPS.map((g) => {
                      const isSelected = selectedGroup === g.code;
                      return (
                        <button
                          key={g.code}
                          type="button"
                          onClick={() => setSelectedGroup(g.code)}
                          className={`rounded-lg border px-2 py-2 text-center transition-all ${
                            isSelected
                              ? 'border-blue-600 bg-blue-600 text-white shadow-sm font-semibold'
                              : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                          }`}
                        >
                          <div className="text-xs font-bold">{g.code}</div>
                          <div className="text-[10px] truncate opacity-90">{g.name}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Chọn Cấp & Phân lớp */}
                <div className="grid grid-cols-2 gap-3">
                  {/* Cấp */}
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-600 mb-1.5">
                      2. Cấp
                    </label>
                    <div className="grid grid-cols-3 gap-1 rounded-lg bg-white p-1 border border-gray-200">
                      {LEVELS.map((lvl) => (
                        <button
                          key={lvl}
                          type="button"
                          onClick={() => setSelectedLevel(lvl)}
                          className={`rounded-md py-1.5 text-xs font-bold transition-all ${
                            selectedLevel === lvl
                              ? 'bg-blue-600 text-white shadow-sm'
                              : 'text-gray-600 hover:text-gray-900'
                          }`}
                        >
                          Cấp {lvl}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Phân Lớp */}
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-600 mb-1.5">
                      3. Phân Lớp
                    </label>
                    <div className="grid grid-cols-4 gap-1 rounded-lg bg-white p-1 border border-gray-200">
                      {SECTIONS.map((sec) => (
                        <button
                          key={sec}
                          type="button"
                          onClick={() => setSelectedSection(sec)}
                          className={`rounded-md py-1.5 text-xs font-bold transition-all ${
                            selectedSection === sec
                              ? 'bg-blue-600 text-white shadow-sm'
                              : 'text-gray-600 hover:text-gray-900'
                          }`}
                        >
                          {sec}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2 rounded-xl border border-indigo-100 bg-indigo-50/40 p-3.5">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-600 mb-1.5">
                  Chọn Ban Ngành / Giới Hội Đoàn
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {SPECIAL_UNITS.map((u) => {
                    const isSelected = selectedUnit === u.code;
                    return (
                      <button
                        key={u.code}
                        type="button"
                        onClick={() => setSelectedUnit(u.code)}
                        className={`flex items-center gap-2 rounded-lg border p-2 text-left transition-all ${
                          isSelected
                            ? 'border-indigo-600 bg-indigo-600 text-white shadow-sm font-semibold'
                            : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                        }`}
                      >
                        <span className="rounded bg-black/10 px-1.5 py-0.5 text-[10px] font-mono font-bold">
                          {u.code}
                        </span>
                        <span className="text-xs truncate">{u.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* PREVIEW TỰ ĐỘNG CHUẨN HÓA (READONLY) */}
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 space-y-2.5">
              <div className="flex items-center justify-between text-xs font-semibold text-gray-500">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                  Chuẩn Hóa Tự Động (Chống phân mảnh dữ liệu)
                </span>
                <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                  Khóa chỉnh sửa
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-1">
                  <span className="text-[10px] font-semibold uppercase text-gray-400">Mã Lớp</span>
                  <div className="mt-0.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-mono text-sm font-bold text-blue-700 shadow-inner">
                    {code}
                  </div>
                </div>
                <div className="col-span-2">
                  <span className="text-[10px] font-semibold uppercase text-gray-400">Tên Hiển Thị Lớp</span>
                  <div className="mt-0.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 shadow-inner truncate">
                    {name}
                  </div>
                </div>
              </div>

              {/* Mã PIN Bypass Token kèm nút xúc xắc */}
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase text-gray-400">
                    Mã PIN Token (Bypass Rate Limit)
                  </span>
                  <button
                    type="button"
                    onClick={handleRollDicePin}
                    className="flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:text-blue-800"
                    title="Sinh mã PIN ngẫu nhiên khác"
                  >
                    <Dices className="h-3.5 w-3.5" />
                    Đổi PIN khác 🎲
                  </button>
                </div>
                <div className="mt-0.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-mono text-xs text-gray-700 shadow-inner">
                  {token}
                </div>
              </div>
            </div>

            {/* TRƯỜNG NHẬP TỰ DO: NGƯỜI PHỤ TRÁCH */}
            <div>
              <label className="block text-xs font-semibold uppercase text-gray-600 mb-1">
                Người Phụ Trách / GLV Chủ Nhiệm (Tùy chọn)
              </label>
              <input
                type="text"
                placeholder={
                  mode === 'catechism'
                    ? 'VD: Thầy Nguyễn Văn An, Cô Trần Thị Bình...'
                    : 'VD: Trưởng ban hoặc Đại diện liên lạc...'
                }
                value={teacherName}
                onChange={(e) => setTeacherName(e.target.value)}
                maxLength={100}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {/* ACTION BUTTONS */}
            <div className="mt-6 flex justify-end gap-2 pt-2 border-t">
              <button
                type="button"
                onClick={() => {
                  resetForm();
                  onOpenChange(false);
                }}
                disabled={isSubmitting}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
              >
                Hủy bỏ
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Đang lưu...
                  </>
                ) : (
                  `Tạo ${code}`
                )}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
