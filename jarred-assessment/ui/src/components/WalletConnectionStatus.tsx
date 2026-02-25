import React, { useState } from 'react';
import { useWalletConnect } from '../context/WalletConnectProvider';

export function WalletConnectionStatus() {
  const { isConnected, isLoading, getWalletAddress, uri, error, connect, clearError } = useWalletConnect();
  const [showQR, setShowQR] = useState(false);

  const formatAddress = (address: string | null) => {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  const handleConnect = async () => {
    clearError();
    await connect();
    setShowQR(true);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const walletDeepLinks = (uri: string) => [
    { name: 'MetaMask', url: `https://metamask.app.link/wc?uri=${encodeURIComponent(uri)}` },
    { name: 'Trust Wallet', url: `https://link.trustwallet.com/wc?uri=${encodeURIComponent(uri)}` },
    { name: 'Rainbow', url: `https://rnbwapp.com/wc?uri=${encodeURIComponent(uri)}` },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            backgroundColor: isConnected ? '#10B981' : error ? '#F59E0B' : '#EF4444',
          }}
          title={isConnected ? 'Wallet Connected' : error ? 'Connection Error' : 'Wallet Disconnected'}
        />
        {isConnected ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, color: '#10B981', fontWeight: 'bold' }}>
              {formatAddress(getWalletAddress())}
            </span>
            <button
              type="button"
              onClick={() => copyToClipboard(getWalletAddress() ?? '')}
              style={{ background: 'none', border: '1px solid #ccc', borderRadius: 4, padding: '2px 6px', cursor: 'pointer', fontSize: 12 }}
              title="Copy address"
            >
              Copy
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, color: '#6B7280' }}>
              {isLoading ? 'Connecting...' : 'Wallet not connected'}
            </span>
            {!isLoading && (
              <button
                type="button"
                onClick={handleConnect}
                style={{
                  backgroundColor: '#3B82F6',
                  color: 'white',
                  border: 'none',
                  borderRadius: 4,
                  padding: '4px 8px',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                Connect Wallet
              </button>
            )}
          </div>
        )}
      </div>
      {error && (
        <div
          style={{
            backgroundColor: '#FEF3C7',
            border: '1px solid #F59E0B',
            borderRadius: 4,
            padding: '8px 12px',
            fontSize: 12,
            color: '#92400E',
            maxWidth: 300,
            wordWrap: 'break-word',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{error}</span>
            <button
              type="button"
              onClick={clearError}
              style={{ background: 'none', border: 'none', color: '#92400E', cursor: 'pointer', fontSize: 14, marginLeft: 8 }}
              title="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}
      {showQR && uri && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 1000,
          }}
          onClick={() => setShowQR(false)}
          onKeyDown={(e) => e.key === 'Escape' && setShowQR(false)}
          role="button"
          tabIndex={0}
          aria-label="Close modal"
        >
          <div
            style={{
              backgroundColor: 'white',
              padding: 20,
              borderRadius: 8,
              maxWidth: 400,
              width: '90%',
            }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>Connect Your Wallet</h3>
            <div style={{ marginBottom: 20 }}>
              <p>Scan with your wallet app or use a link below:</p>
              <code style={{ display: 'block', wordBreak: 'break-all', fontSize: 10, fontFamily: 'monospace', backgroundColor: '#f5f5f5', padding: 10, borderRadius: 4 }}>
                {uri}
              </code>
            </div>
            <div style={{ marginBottom: 20 }}>
              {walletDeepLinks(uri).map((w) => (
                <div key={w.name} style={{ marginBottom: 8 }}>
                  <a href={w.url} target="_blank" rel="noopener noreferrer" style={{ display: 'block', padding: '8px 12px', backgroundColor: '#f0f0f0', textDecoration: 'none', borderRadius: 4, color: '#333' }}>
                    Connect with {w.name} →
                  </a>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={() => copyToClipboard(uri)} style={{ flex: 1, padding: 8, backgroundColor: '#6B7280', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                Copy URI
              </button>
              <button type="button" onClick={() => setShowQR(false)} style={{ flex: 1, padding: 8, backgroundColor: '#EF4444', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
