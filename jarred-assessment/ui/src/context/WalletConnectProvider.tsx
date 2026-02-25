import React, { createContext, useContext, useState, type ReactNode } from 'react';
import SignClient from '@walletconnect/sign-client';
import type { SessionTypes } from '@walletconnect/types';
import type { IKeyValueStorage } from '@walletconnect/keyvaluestorage';

class WalletConnectStorageService implements IKeyValueStorage {
  keyPrefix = 'wc@2:';
  private restoredData: Record<string, string> = {};
  private useLocalStorage = true;

  private sanitizeWalletConnectData(data: unknown, _key: string): unknown {
    if (data === null || data === undefined) {
      return Array.isArray(data) ? [] : {};
    }
    if (Array.isArray(data)) {
      return data.map((item, index) => this.sanitizeWalletConnectData(item, `${_key}[${index}]`));
    }
    if (typeof data === 'object') {
      const sanitized = { ...data } as Record<string, unknown>;
      const arrayProperties = [
        'cached', 'messages', 'history', 'subscriptions', 'events',
        'topics', 'pairings', 'sessions', 'proposals', 'expiries',
        'methods', 'events', 'accounts', 'chains',
      ];
      Object.keys(sanitized).forEach((prop) => {
        if (sanitized[prop] === null && arrayProperties.includes(prop)) {
          sanitized[prop] = [];
        } else if (typeof sanitized[prop] === 'object') {
          sanitized[prop] = this.sanitizeWalletConnectData(sanitized[prop], `${_key}.${prop}`);
        }
      });
      return sanitized;
    }
    return data;
  }

  async storeWcInfo(sessionInfo: Record<string, unknown>): Promise<void> {
    const wcKeys = [
      'wc@2:client:0.3//session',
      'wc@2:core:0.3//subscription',
      'wc@2:core:0.3//messages',
      'wc@2:client:0.3//proposal',
      'wc@2:core:0.3//keychain',
      'wc@2:core:0.3//pairing',
      'wc@2:core:0.3//history',
      'wc@2:core:0.3//expirer',
    ];
    wcKeys.forEach((key) => {
      if (sessionInfo[key] !== undefined) {
        let dataToStore = sessionInfo[key];
        if (key === 'wc@2:client:0.3//session' && typeof dataToStore === 'object' && dataToStore !== null) {
          const transformedSessions: Record<string, unknown> = {};
          Object.entries(dataToStore as Record<string, unknown>).forEach(([sessionKey, sessionData]) => {
            const sd = sessionData as Record<string, unknown> | null;
            if (sd?.topic) {
              transformedSessions[sd.topic as string] = sessionData;
            } else {
              transformedSessions[sessionKey] = sessionData;
            }
          });
          dataToStore = transformedSessions;
        }
        const jsonData = typeof dataToStore === 'object' ? JSON.stringify(dataToStore) : String(dataToStore);
        this.restoredData[key] = jsonData;
        if (key === 'wc@2:client:0.3//session') {
          this.restoredData['wc@2:client:session'] = jsonData;
        }
      }
    });
  }

  async getItem<T = unknown>(key: string): Promise<T | undefined> {
    if (this.restoredData[key] !== undefined) {
      const jsonValue = this.restoredData[key];
      try {
        const parsedValue = JSON.parse(jsonValue);
        return this.sanitizeWalletConnectData(parsedValue, key) as T;
      } catch {
        return jsonValue as T;
      }
    }
    if (this.useLocalStorage) {
      const value = localStorage.getItem(key);
      if (value) {
        try {
          const parsedValue = JSON.parse(value);
          return this.sanitizeWalletConnectData(parsedValue, key) as T;
        } catch {
          return value as T;
        }
      }
    }
    return undefined;
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
    if (this.useLocalStorage) localStorage.setItem(key, valueStr);
    this.restoredData[key] = valueStr;
  }

  async removeItem(key: string): Promise<void> {
    if (this.useLocalStorage) localStorage.removeItem(key);
    delete this.restoredData[key];
  }

  async getKeys(): Promise<string[]> {
    const keys: string[] = [];
    Object.keys(this.restoredData).forEach((k) => {
      if (k?.startsWith(this.keyPrefix)) keys.push(k);
    });
    if (this.useLocalStorage) {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(this.keyPrefix)) keys.push(k);
      }
    }
    return [...new Set(keys)];
  }

  async getEntries<T = unknown>(): Promise<[string, T][]> {
    const keys = await this.getKeys();
    const entries: [string, T][] = [];
    for (const key of keys) {
      const value = await this.getItem<T>(key);
      if (value !== undefined) entries.push([key, value]);
    }
    return entries;
  }
}

interface WalletConnectState {
  client: InstanceType<typeof SignClient> | null;
  session: SessionTypes.Struct | null;
  isConnected: boolean;
  isLoading: boolean;
  uri: string | null;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  clearError: () => void;
  initializeWithSessionInfo: (sessionInfo: Record<string, unknown> | null) => Promise<void>;
  getWalletAddress: () => string | null;
}

const WalletConnectContext = createContext<WalletConnectState | null>(null);

interface WalletConnectProviderProps {
  children: ReactNode;
  onSessionDisconnected?: () => void;
}

export const WalletConnectProvider: React.FC<WalletConnectProviderProps> = ({ children, onSessionDisconnected }) => {
  const [client, setClient] = useState<SignClient | null>(null);
  const [session, setSession] = useState<SessionTypes.Struct | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageService] = useState(() => new WalletConnectStorageService());
  const isConnected = !!session;
  const clearError = () => setError(null);

  const getWalletAddress = (): string | null => {
    if (!session?.namespaces) return null;
    const ns = session.namespaces.viasecurechain ?? Object.values(session.namespaces)[0];
    const accounts = ns?.accounts;
    if (!accounts?.length) return null;
    const full = accounts[0] as string;
    return full.split(':')[2] ?? null;
  };

  const initWalletConnect = async (storage?: WalletConnectStorageService) => {
    try {
      const signClient = await SignClient.init({
        projectId: 'f54e2cf5d6e7a0f8ac954656ff5591b6',
        relayUrl: 'wss://relay.wallet.solvewithvia.com',
        storage: storage ?? storageService,
        metadata: {
          name: 'Document Signing dApp',
          description: 'Multi-party document signing with VIA ZTF',
          url: window.location.origin,
          icons: [`${window.location.origin}/favicon.ico`],
        },
      });
      setClient(signClient);
      signClient.on('session_update', (args) => {
        setSession(signClient.session.get(args.topic));
      });
      signClient.on('session_delete', () => {
        setSession(null);
        onSessionDisconnected?.();
      });
      return signClient;
    } catch (err) {
      console.error('Failed to initialize WalletConnect:', err);
      setError('Failed to initialize WalletConnect');
      throw err;
    }
  };

  const connect = async () => {
    let c = client;
    if (!c) {
      c = await initWalletConnect(storageService);
    }
    if (!c) return;
    try {
      setIsLoading(true);
      setUri(null);
      clearError();
      const { uri: connectionUri, approval } = await c.connect({
        optionalNamespaces: {
          viasecurechain: {
            methods: ['personal_sign'],
            chains: ['viasecurechain:mainnet'],
            events: [],
          },
        },
      });
      if (connectionUri) setUri(connectionUri);
      const newSession = await Promise.race([
        approval(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout after 5 minutes')), 300000)
        ),
      ]);
      setSession(newSession);
      setUri(null);
      setError(null);
      localStorage.setItem(
        'walletconnect_session',
        JSON.stringify({ topic: newSession.topic, expiry: newSession.expiry, timestamp: Date.now() })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setUri(null);
    } finally {
      setIsLoading(false);
    }
  };

  const disconnect = async () => {
    if (!client || !session) return;
    try {
      await client.disconnect({ topic: session.topic, reason: { code: 6000, message: 'User disconnected' } });
    } catch (err) {
      console.error('Failed to disconnect WalletConnect:', err);
    } finally {
      setSession(null);
      localStorage.removeItem('walletconnect_session');
    }
  };

  const initializeWalletConnectCore = async (signClient: SignClient) => {
    try {
      signClient.session?.getAll();
      signClient.pairing?.getAll();
      const sess = signClient as { session?: { restore?: () => Promise<void>; init?: () => Promise<void>; core?: { storage?: { getItem: (k: string) => Promise<unknown> } }; store?: { getAll?: () => unknown }; storagePrefix?: string } };
      if (sess.session?.init) await sess.session.init();
      if (sess.session?.restore) await sess.session.restore();
      if (sess.session?.core?.storage) {
        try {
          const sessionKey = (sess.session.storagePrefix ?? 'wc@2:client:0.3//') + 'session';
          const sessionData = await sess.session.core.storage.getItem(sessionKey);
          if (sessionData && typeof sessionData === 'object') {
            for (const [topic, sessionInfo] of Object.entries(sessionData as Record<string, unknown>)) {
              const si = sessionInfo as Record<string, unknown> | null;
              const valid = si?.topic && si?.expiry && si?.acknowledged && (si.expiry as number) * 1000 > Date.now();
              if (valid) {
                try {
                  await (signClient.session as { set: (t: string, s: unknown) => Promise<void> }).set(topic, sessionInfo);
                } catch {
                  /* skip invalid session */
                }
              }
            }
          }
        } catch {
          /* ignore */
        }
      }
      if (sess.session?.restore) await sess.session.restore();
    } catch {
      /* ignore */
    }
  };

  const checkWalletConnectState = async (signClient: SignClient) => {
    const sessions = signClient.session.getAll();
    const valid = sessions
      .filter((s: { expiry?: number }) => (s.expiry ?? 0) * 1000 > Date.now())
      .sort((a: { expiry?: number }, b: { expiry?: number }) => (b.expiry ?? 0) - (a.expiry ?? 0));
    if (valid.length === 0) return;
    const active = valid[0] as SessionTypes.Struct;
    try {
      await signClient.ping({ topic: active.topic });
      setSession(active);
      setError(null);
      localStorage.setItem(
        'walletconnect_session',
        JSON.stringify({ topic: active.topic, expiry: active.expiry, timestamp: Date.now() })
      );
    } catch {
      setError('Session verification failed');
    }
  };

  const initializeWithSessionInfo = async (sessionInfo: Record<string, unknown> | null) => {
    try {
      if (sessionInfo) await storageService.storeWcInfo(sessionInfo);
      const signClient = await initWalletConnect(storageService);
      await initializeWalletConnectCore(signClient);
      await checkWalletConnectState(signClient);
    } catch (err) {
      console.error('WalletConnect init failed:', err);
      setError('Failed to initialize WalletConnect');
    }
  };

  const value: WalletConnectState = {
    client,
    session,
    isConnected,
    isLoading,
    uri,
    error,
    connect,
    disconnect,
    clearError,
    initializeWithSessionInfo,
    getWalletAddress,
  };

  return (
    <WalletConnectContext.Provider value={value}>
      {children}
    </WalletConnectContext.Provider>
  );
};

export const useWalletConnect = (): WalletConnectState => {
  const ctx = useContext(WalletConnectContext);
  if (!ctx) throw new Error('useWalletConnect must be used within WalletConnectProvider');
  return ctx;
};
