import React from 'react';
import { AuthProvider } from './contexts/AuthContext';
import { AdminLayout } from './layouts/AdminLayout';

export const App: React.FC = () => (
  <AuthProvider>
    <AdminLayout />
  </AuthProvider>
);
