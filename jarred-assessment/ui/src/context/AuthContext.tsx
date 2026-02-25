import React, { createContext, useContext, useState, type ReactNode } from 'react';
import type Keycloak from 'keycloak-js';

interface AuthContextType {
  keycloak: Keycloak | null;
  setKeycloak: (k: Keycloak | null) => void;
  token: string | null;
  setToken: (t: string | null) => void;
  userEmail: string | null;
  setUserEmail: (e: string | null) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [keycloak, setKeycloak] = useState<Keycloak | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  return (
    <AuthContext.Provider value={{ keycloak, setKeycloak, token, setToken, userEmail, setUserEmail }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
