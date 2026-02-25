import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Keycloak from 'keycloak-js';
import { ConfigProvider, useConfig } from './context/ConfigService';
import { WalletConnectProvider, useWalletConnect } from './context/WalletConnectProvider';
import { DocumentSignProvider } from './context/DocumentSignService';
import { AuthProvider, useAuth } from './context/AuthContext';
import { HomePage } from './pages/HomePage';
import { CreateSessionPage } from './pages/CreateSessionPage';
import { SessionPage } from './pages/SessionPage';
import { WalletConnectionStatus } from './components/WalletConnectionStatus';

const keycloak = new Keycloak({
  url: 'https://auth.solvewithvia.com/auth',
  realm: 'ztf_demo',
  clientId: 'localhost-app',
});

const TOKEN_MIN_VALIDITY = 350;
const REFRESH_INTERVAL = 300000;

function AppContent() {
  const { isInitialized, walletConnectInfo, loadAppConfig } = useConfig();
  const { initializeWithSessionInfo } = useWalletConnect();
  const { setToken, setUserEmail } = useAuth();
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sessionInitialized, setSessionInitialized] = useState(false);

  useEffect(() => {
    if (isInitialized && walletConnectInfo && authenticated && !sessionInitialized) {
      initializeWithSessionInfo(walletConnectInfo as Record<string, unknown>);
      setSessionInitialized(true);
    }
  }, [isInitialized, walletConnectInfo, authenticated, sessionInitialized, initializeWithSessionInfo]);

  useEffect(() => {
    keycloak
      .init({
        onLoad: 'login-required',
        redirectUri: window.location.origin + '/',
        checkLoginIframe: false,
        responseMode: 'query',
        pkceMethod: 'S256',
        scope: 'openid profile email',
        flow: 'standard',
        useNonce: true,
      })
      .then(() => {
        if (!keycloak.authenticated) {
          keycloak.login().catch(console.error);
          setLoading(false);
        } else {
          setAuthenticated(true);
          setToken(keycloak.token ?? null);
          const parsed = keycloak.tokenParsed as { preferred_username?: string; sub?: string } | undefined;
          setUserEmail(parsed?.preferred_username ?? parsed?.sub ?? null);
          loadAppConfig(keycloak)
            .then(() => setLoading(false))
            .catch((err) => {
              console.error(err);
              setLoading(false);
            });
        }
      })
      .catch((err) => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const refresh = () => {
      keycloak.updateToken(TOKEN_MIN_VALIDITY).then((refreshed) => {
        if (refreshed) setToken(keycloak.token ?? null);
      }).catch(() => keycloak.login());
    };
    refresh();
    const id = setInterval(refresh, REFRESH_INTERVAL);
    return () => clearInterval(id);
  }, [authenticated, setToken]);

  const handleLogout = () => {
    keycloak.logout({ redirectUri: window.location.origin + '/' });
  };

  if (loading) return <div style={{ padding: 24 }}>Loading...</div>;
  if (!authenticated) return <div style={{ padding: 24 }}>Not authenticated</div>;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <nav style={{ display: 'flex', gap: 16, marginRight: 16 }}>
          <a href="/" style={{ fontWeight: 'bold' }}>Document Signing</a>
          <a href="/create">Create</a>
        </nav>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <WalletConnectionStatus />
          <span style={{ marginRight: 8 }}>{keycloak.tokenParsed && (keycloak.tokenParsed as { preferred_username?: string }).preferred_username}</span>
          <button type="button" onClick={handleLogout} style={{ padding: '6px 12px' }}>
            Logout
          </button>
        </div>
      </div>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/create" element={<CreateSessionPage />} />
        <Route path="/sessions/:sessionId" element={<SessionPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ConfigProvider>
          <WalletConnectProvider onSessionDisconnected={() => keycloak.logout({ redirectUri: window.location.origin + '/' })}>
            <DocumentSignProvider>
              <AppContent />
            </DocumentSignProvider>
          </WalletConnectProvider>
        </ConfigProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
