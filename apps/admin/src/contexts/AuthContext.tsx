import React, { createContext, useContext, useState, useEffect } from 'react';
import { apiClient, AUTH_UNAUTHORIZED_EVENT } from '../api/client';
import { LoginDialog } from '../components/auth/LoginDialog';

interface AuthContextType {
  isAuthenticated: boolean;
  login: (token: string) => Promise<boolean>;
  logout: () => void;
  openLoginModal: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    return Boolean(localStorage.getItem('admin_token'));
  });
  const [isModalOpen, setIsModalOpen] = useState(!isAuthenticated);

  useEffect(() => {
    const handleUnauthorized = () => {
      setIsAuthenticated(false);
      setIsModalOpen(true);
    };

    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized);
  }, []);

  const login = async (token: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/admin/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) return false;

      apiClient.setToken(token);
      setIsAuthenticated(true);
      setIsModalOpen(false);
      return true;
    } catch {
      return false;
    }
  };

  const logout = () => {
    apiClient.clearToken();
    setIsAuthenticated(false);
    setIsModalOpen(true);
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, login, logout, openLoginModal: () => setIsModalOpen(true) }}>
      {children}
      <LoginDialog isOpen={isModalOpen} onLogin={login} />
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth phải được sử dụng trong AuthProvider');
  return context;
};
