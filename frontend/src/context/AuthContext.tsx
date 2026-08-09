import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import api from '../lib/api';

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  organizationId: string;
}

interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('ts_access_token');
    if (!token) { setIsLoading(false); return; }

    api.get('/users/me')
      .then((res) => setUser(res.data.data.user))
      .catch(() => {
        localStorage.removeItem('ts_access_token');
        localStorage.removeItem('ts_refresh_token');
      })
      .finally(() => setIsLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    const res = await api.post('/auth/login', { email, password });
    const { tokens, user: userData } = res.data;
    localStorage.setItem('ts_access_token', tokens.accessToken);
    localStorage.setItem('ts_refresh_token', tokens.refreshToken);
    setUser(userData);
  };

  const logout = () => {
    localStorage.removeItem('ts_access_token');
    localStorage.removeItem('ts_refresh_token');
    setUser(null);
    window.location.href = '/';
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout, isAuthenticated: !!user }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
