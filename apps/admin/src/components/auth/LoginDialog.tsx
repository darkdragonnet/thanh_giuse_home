import React, { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { KeyRound, AlertCircle, Loader2 } from 'lucide-react';

interface LoginDialogProps {
  isOpen: boolean;
  onLogin: (token: string) => Promise<boolean>;
}

export const LoginDialog: React.FC<LoginDialogProps> = ({ isOpen, onLogin }) => {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setError('Vui lòng nhập Token quản trị');
      return;
    }

    setLoading(true);
    setError(null);

    const success = await onLogin(token.trim());
    setLoading(false);

    if (!success) {
      setError('Mã xác thực không chính xác hoặc máy chủ từ chối.');
    }
  };

  return (
    <Dialog.Root open={isOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-2xl border border-gray-100">
          <div className="flex flex-col items-center text-center">
            <div className="mb-4 rounded-full bg-blue-50 p-3 text-blue-600">
              <KeyRound className="h-6 w-6" />
            </div>
            <Dialog.Title className="text-xl font-bold text-gray-900">
              Xác thực Quản trị viên
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-gray-500">
              Nhập mã ADMIN_SECRET_TOKEN để truy cập bảng điều khiển (Phiên làm việc 3 ngày).
            </Dialog.Description>
          </div>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <input
                type="password"
                placeholder="Nhập ADMIN_SECRET_TOKEN..."
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={loading}
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 p-2.5 rounded-lg border border-red-100">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Đang xác thực...
                </>
              ) : (
                'Xác nhận truy cập'
              )}
            </button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
