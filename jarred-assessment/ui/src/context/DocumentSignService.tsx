import React, { createContext, useContext, useState, type ReactNode } from 'react';
import { ethers } from 'ethers';
import { useWalletConnect } from './WalletConnectProvider';

interface DocumentSignState {
  signDocumentHash: (documentHashHex: string) => Promise<string | null>;
  isLoading: boolean;
  error: string | null;
  clearError: () => void;
}

const DocumentSignContext = createContext<DocumentSignState | null>(null);

interface DocumentSignProviderProps {
  children: ReactNode;
}

export const DocumentSignProvider: React.FC<DocumentSignProviderProps> = ({ children }) => {
  const { client, session } = useWalletConnect();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signDocumentHash = async (documentHashHex: string): Promise<string | null> => {
    if (!client || !session) {
      setError('WalletConnect not connected');
      return null;
    }
    try {
      setIsLoading(true);
      setError(null);
      const activeSessions = client.session.getAll();
      if (!activeSessions.some((s) => s.topic === session.topic)) {
        throw new Error('Session expired. Please reconnect your wallet.');
      }
      let accounts: string[] = [];
      let namespaceConfig: { methods?: string[] } | null = null;
      if (session.namespaces?.viasecurechain?.accounts?.length) {
        accounts = session.namespaces.viasecurechain.accounts as string[];
        namespaceConfig = session.namespaces.viasecurechain;
      } else {
        for (const config of Object.values(session.namespaces ?? {})) {
          const c = config as { accounts?: string[]; methods?: string[] };
          if (c?.accounts?.length) {
            accounts = c.accounts;
            namespaceConfig = c;
            break;
          }
        }
      }
      if (!accounts.length) throw new Error('No accounts found');
      const fullAccount = accounts[0];
      const fromAccount = fullAccount.split(':')[2];
      const chainId = fullAccount.split(':').slice(0, 2).join(':');
      const methods = namespaceConfig?.methods ?? [];
      if (!methods.includes('personal_sign')) {
        throw new Error('personal_sign not available. Please reconnect your wallet.');
      }
      const msgHex = documentHashHex.startsWith('0x') ? documentHashHex : `0x${documentHashHex}`;
      const params = [ethers.utils.hexlify(ethers.utils.toUtf8Bytes(msgHex)), fromAccount];
      const signature = (await client.request({
        topic: session.topic,
        chainId,
        request: { method: 'personal_sign', params },
      })) as string;
      return signature;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Signing failed';
      setError(msg);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const value: DocumentSignState = {
    signDocumentHash,
    isLoading,
    error,
    clearError: () => setError(null),
  };

  return (
    <DocumentSignContext.Provider value={value}>
      {children}
    </DocumentSignContext.Provider>
  );
};

export const useDocumentSign = (): DocumentSignState => {
  const ctx = useContext(DocumentSignContext);
  if (!ctx) throw new Error('useDocumentSign must be used within DocumentSignProvider');
  return ctx;
};
