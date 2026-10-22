import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { DashboardTab } from '../components/dashboard/DashboardTab';
import { ClassesTab } from '../components/classes/ClassesTab';
import { StudentsTab } from '../components/students/StudentsTab';
import { RequestsTab } from '../components/requests/RequestsTab';
import { LogsTab } from '../components/logs/LogsTab';
import { CloudFaceInspectorTab } from '../components/hanet/CloudFaceInspectorTab';
import { ManualReviewApproval } from '../pages/ManualReviewApproval';
import { SystemSettings } from '../pages/SystemSettings';
import { LayoutDashboard, Users, UserCheck, Inbox, ScrollText, LogOut, Cloud, ShieldAlert, Settings } from 'lucide-react';

export const AdminLayout: React.FC = () => {
  const { logout } = useAuth();
  const [activeTab, setActiveTab] = useState('dashboard');

  const navItems = [
    { id: 'dashboard', label: 'Tổng quan', icon: LayoutDashboard },
    { id: 'classes', label: 'Lớp học', icon: Users },
    { id: 'students', label: 'Học sinh', icon: UserCheck },
    { id: 'manual_review', label: 'Rà soát thủ công', icon: ShieldAlert },
    { id: 'cloud_faces', label: 'Face ID Cloud', icon: Cloud },
    { id: 'requests', label: 'Yêu cầu xử lý', icon: Inbox },
    { id: 'settings', label: 'Cài đặt', icon: Settings },
    { id: 'logs', label: 'Nhật ký', icon: ScrollText },
  ];

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-bold text-lg text-gray-900 tracking-tight">HANET Face Manager</span>
            <span className="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
              Admin Portal
            </span>
          </div>

          <button
            onClick={logout}
            className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-red-600 transition"
          >
            <LogOut className="h-4 w-4" />
            <span>Đăng xuất</span>
          </button>
        </div>

        <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex space-x-8">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`flex items-center gap-2 py-3 border-b-2 text-sm font-medium transition ${
                  isActive
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {activeTab === 'dashboard' && <DashboardTab />}
        {activeTab === 'classes' && <ClassesTab />}
        {activeTab === 'students' && <StudentsTab />}
        {activeTab === 'manual_review' && <ManualReviewApproval />}
        {activeTab === 'cloud_faces' && <CloudFaceInspectorTab />}
        {activeTab === 'requests' && <RequestsTab />}
        {activeTab === 'settings' && <SystemSettings />}
        {activeTab === 'logs' && <LogsTab />}
      </main>
    </div>
  );
};
