import React, { useState, useEffect } from 'react';
import { apiClient } from '../../api/client';
import { ShieldAlert, Download, Search } from 'lucide-react';
import { format, parseISO } from 'date-fns';

interface LogItem {
  id: number;
  alias_id: string;
  class_code: string;
  action: string;
  result_code: string;
  result_message: string;
  ip: string;
  created_at: string;
}

export const LogsTab: React.FC = () => {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [isMaintenance, setIsMaintenance] = useState(false);

  const fetchLogs = async () => {
    try {
      const res = await apiClient.get<{ success: boolean; data: { items: LogItem[]; total?: number } }>('/logs', {
        page,
        limit: 25,
        action: action || undefined,
        search: search || undefined,
      });
      if (res.success) setLogs(res.data.items);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchSettings = async () => {
    try {
      const res = await apiClient.get<{ success: boolean; data: any }>('/dashboard/stats');
      if (res.success) setIsMaintenance(res.data.system_status.is_maintenance);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [page, action, search]);

  useEffect(() => {
    fetchSettings();
  }, []);

  const exportLogsCSV = () => {
    let csv = 'Thời gian,AliasID,Lớp,Action,Result Code,Thông điệp,IP\n';
    logs.forEach(l => {
      csv += `"${l.created_at}","${l.alias_id}","${l.class_code || ''}","${l.action}","${l.result_code}","${l.result_message?.replace(/"/g, '""')}","${l.ip}"\n`;
    });
    const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `system_logs_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      {/* 1. Global Kill Switch Status (Read-Only Status Line) */}
      <div className={`rounded-xl border p-4 shadow-sm transition ${
        isMaintenance ? 'border-red-200 bg-red-50/50' : 'border-gray-200 bg-white'
      }`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <ShieldAlert className={`h-5 w-5 shrink-0 ${isMaintenance ? 'text-red-600' : 'text-emerald-600'}`} />
            <div>
              <span className="font-bold text-gray-900 text-xs">Trạng thái Cổng Tiếp Nhận: </span>
              <span className={`text-xs font-semibold ${isMaintenance ? 'text-red-700' : 'text-emerald-700'}`}>
                {isMaintenance ? 'Đang tạm dừng bảo trì (Kill Switch BẬT)' : 'Đang mở tiếp nhận bình thường'}
              </span>
            </div>
          </div>
          <span className="text-[11px] text-gray-500 italic">
            * Nút gạt điều khiển Kill Switch tập trung tại tab "Cài đặt"
          </span>
        </div>
      </div>

      {/* 2. Logs Filter & Export */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="relative w-64">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Lọc AliasID hoặc nội dung..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="w-full rounded-lg border border-gray-300 pl-9 pr-4 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <select
            value={action}
            onChange={(e) => { setAction(e.target.value); setPage(1); }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="">Tất cả Action</option>
            <option value="REGISTER">REGISTER</option>
            <option value="UPDATE_PHOTO">UPDATE_PHOTO</option>
            <option value="MANUAL_OVERRIDE">MANUAL_OVERRIDE</option>
            <option value="RETRY">RETRY</option>
            <option value="UNLOCK_STUDENT">UNLOCK_STUDENT</option>
            <option value="WEBHOOK_DEFERRED">WEBHOOK_DEFERRED</option>
          </select>
        </div>
        <button
          onClick={exportLogsCSV}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 shadow-sm"
        >
          <Download className="h-4 w-4" />
          Xuất CSV Logs
        </button>
      </div>

      {/* 3. Log Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-100 bg-gray-50/75 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3">Thời gian</th>
              <th className="px-4 py-3">AliasID</th>
              <th className="px-4 py-3">Lớp</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Mã KQ</th>
              <th className="px-4 py-3">Nội dung</th>
              <th className="px-4 py-3">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 font-mono text-xs">
            {logs.map((log) => (
              <tr key={log.id} className="hover:bg-gray-50/50">
                <td className="px-4 py-2.5 text-gray-500">
                  {format(parseISO(log.created_at), 'HH:mm:ss dd/MM')}
                </td>
                <td className="px-4 py-2.5 font-bold text-gray-800">{log.alias_id || '—'}</td>
                <td className="px-4 py-2.5 text-gray-600">{log.class_code || '—'}</td>
                <td className="px-4 py-2.5">
                  <span className="rounded bg-gray-100 px-2 py-0.5 font-semibold text-gray-700">
                    {log.action}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className={`font-bold ${log.result_code === '1' || log.result_code === 'SUCCESS' ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {log.result_code}
                  </span>
                </td>
                <td className="px-4 py-2.5 font-sans text-gray-600 max-w-xs truncate" title={log.result_message || ''}>
                  {log.result_message}
                </td>
                <td className="px-4 py-2.5 text-gray-400">{log.ip || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between border-t border-gray-200 pt-3">
        <span className="text-xs text-gray-500">Trang {page}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-lg border px-3 py-1 text-xs font-medium disabled:opacity-40"
          >
            Trang trước
          </button>
          <button
            onClick={() => setPage(p => p + 1)}
            disabled={logs.length < 25}
            className="rounded-lg border px-3 py-1 text-xs font-medium disabled:opacity-40"
          >
            Trang sau
          </button>
        </div>
      </div>
    </div>
  );
};
