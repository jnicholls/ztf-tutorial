import React, { createContext, useContext, useState, type ReactNode } from 'react';

interface ConfigState {
  isInitialized: boolean;
  userInfo: Record<string, unknown> | null;
  walletConnectInfo: Record<string, unknown> | null;
  publicKey: string | null;
  userType: string | null;
  error: string | null;
}

interface ConfigContextType extends ConfigState {
  loadAppConfig: (keycloak: { token?: string }) => Promise<void>;
}

const ConfigContext = createContext<ConfigContextType | null>(null);

interface ConfigProviderProps {
  children: ReactNode;
}

export const ConfigProvider: React.FC<ConfigProviderProps> = ({ children }) => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [userInfo, setUserInfo] = useState<Record<string, unknown> | null>(null);
  const [walletConnectInfo, setWalletConnectInfo] = useState<Record<string, unknown> | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [userType, setUserType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAppConfig = async (keycloak: { token?: string }) => {
    try {
      if (!keycloak?.token) {
        throw new Error('No Keycloak token available');
      }
      const userInfoUrl = 'https://auth.solvewithvia.com/auth/realms/ztf_demo/protocol/openid-connect/userinfo';
      const response = await fetch(userInfoUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${keycloak.token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch user info: ${response.status} ${response.statusText}`);
      }
      const userInfoData = (await response.json()) as Record<string, unknown>;
      setUserInfo(userInfoData);
      let decodedWalletConnectInfo: Record<string, unknown> | null = null;
      if (userInfoData.walletConnectSessionInfo) {
        try {
          const decodedString = atob(userInfoData.walletConnectSessionInfo as string);
          decodedWalletConnectInfo = JSON.parse(decodedString) as Record<string, unknown>;
        } catch (decodeError) {
          console.error('Failed to decode walletConnectSessionInfo:', decodeError);
        }
      }
      const userPublicKey = (userInfoData.public_key as string) ?? null;
      const dataItemId = (userInfoData.data_item_id as string) ?? null;

      if (userPublicKey) localStorage.setItem('publicKey', userPublicKey);
      if (userInfoData.organization_name) localStorage.setItem('orgName', String(userInfoData.organization_name));
      if (userInfoData.user_type) sessionStorage.setItem('userType', String(userInfoData.user_type));
      if (dataItemId) sessionStorage.setItem('dataItemId', dataItemId);

      setWalletConnectInfo(decodedWalletConnectInfo);
      setPublicKey(userPublicKey);
      setUserType(userInfoData.user_type ? String(userInfoData.user_type) : null);
    } catch (err) {
      console.error('Error loading app config:', err);
      setError(err instanceof Error ? err.message : 'Unknown error loading config');
    } finally {
      setIsInitialized(true);
    }
  };

  const value: ConfigContextType = {
    isInitialized,
    userInfo,
    walletConnectInfo,
    publicKey,
    userType,
    error,
    loadAppConfig,
  };

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
};

export const useConfig = (): ConfigContextType => {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error('useConfig must be used within ConfigProvider');
  }
  return context;
};
