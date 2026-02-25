import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useDocumentSign } from '../context/DocumentSignService';
import { useWalletConnect } from '../context/WalletConnectProvider';
import { useAuth } from '../context/AuthContext';
import { getSession, getSessionDocument, signSession } from '../api/client';

interface SignerInfo {
  ztf_user_id: string;
  wallet_address: string | null;
  signed_at: string | null;
  signature: string | null;
}

interface SessionDetail {
  id: string;
  document_hash: string;
  status: string;
  creator_ztf_user_id: string;
  creator_wallet: string;
  signers: SignerInfo[];
}

export function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { token, userEmail } = useAuth();
  const { signDocumentHash, isLoading: signing } = useDocumentSign();
  const { getWalletAddress, isConnected } = useWalletConnect();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [docUrl, setDocUrl] = useState<string | null>(null);
  const [docType, setDocType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    getSession(sessionId, token ?? undefined)
      .then(setSession)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, [sessionId, token]);

  useEffect(() => {
    if (!sessionId || !token) return;
    getSessionDocument(sessionId, token)
      .then(({ blob, contentType }) => {
        const type = contentType || blob.type || null;
        const typedBlob = type ? new Blob([blob], { type }) : blob;
        const url = URL.createObjectURL(typedBlob);
        setDocUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        setDocType(type);
      })
      .catch(() => {
        setDocUrl(null);
        setDocType(null);
      });
    return () => {
      setDocUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [sessionId, token]);

  const mySigner = session?.signers.find((s) => s.ztf_user_id === userEmail);
  const canSign = mySigner && !mySigner.signed_at && isConnected && token;

  const handleSign = async () => {
    if (!sessionId || !token || !session) return;
    const walletAddress = getWalletAddress();
    if (!walletAddress) {
      setError('Wallet not connected');
      return;
    }
    try {
      setError(null);
      const signature = await signDocumentHash(session.document_hash);
      if (!signature) {
        setError('Signing was rejected');
        return;
      }
      await signSession(sessionId, token, { wallet_address: walletAddress, signature });
      const updated = await getSession(sessionId, token);
      setSession(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign');
    }
  };

  if (!sessionId) return <p>Invalid session</p>;
  if (error && !session) return <p style={{ color: '#c00' }}>{error}</p>;
  if (!session) return <p>Loading...</p>;

  const statusLabel =
    session.status === 'fully_signed'
      ? 'Fully Executed'
      : session.status === 'partially_signed'
        ? 'Partially Signed'
        : 'Waiting for signers';

  const downloadExtension =
    docType === 'application/pdf'
      ? 'pdf'
      : docType?.startsWith('image/')
        ? docType.replace('image/', '') || 'png'
        : 'bin';
  const downloadFilename = `document-${sessionId.slice(0, 8)}.${downloadExtension}`;

  return (
    <div style={{ padding: 24, maxWidth: 800 }}>
      <h1>Session {sessionId.slice(0, 8)}...</h1>
      <p><strong>Status:</strong> {statusLabel}</p>
      {docUrl && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Document</h3>
            <a
              href={docUrl}
              download={downloadFilename}
              style={{
                padding: '6px 12px',
                fontSize: 14,
                background: '#333',
                color: '#fff',
                textDecoration: 'none',
                borderRadius: 4,
              }}
            >
              Download
            </a>
          </div>
          {docType?.startsWith('image/') ? (
            <img src={docUrl} alt="Document" style={{ maxWidth: '100%', maxHeight: 400 }} />
          ) : (
            <iframe
              src={docUrl}
              title="Document"
              width="100%"
              height="400"
              style={{ border: '1px solid #ccc' }}
            />
          )}
        </div>
      )}
      <h3>Signers</h3>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {session.signers.map((s) => (
          <li key={s.ztf_user_id} style={{ padding: 8, marginBottom: 4, background: '#f5f5f5', color: '#333', borderRadius: 4 }}>
            {s.ztf_user_id} — {s.signed_at ? `Signed at ${new Date(s.signed_at).toLocaleString()}` : 'Pending'}
          </li>
        ))}
      </ul>
      {(canSign || session.document_hash) && (
        <div style={{ marginTop: 16, padding: 12, background: '#f0f4ff', borderRadius: 4, border: '1px solid #c5d0e8', color: '#333' }}>
          <label style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
            Document hash {canSign && '(compare with VIA wallet when signing)'}
          </label>
          <code
            style={{
              display: 'block',
              wordBreak: 'break-all',
              fontFamily: 'monospace',
              fontSize: 13,
              padding: 8,
              background: '#fff',
              borderRadius: 4,
            }}
          >
            {session.document_hash.startsWith('0x') ? session.document_hash : `0x${session.document_hash}`}
          </code>
        </div>
      )}
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      {canSign && (
        <button onClick={handleSign} disabled={signing} style={{ padding: 10, marginTop: 16 }}>
          {signing ? 'Signing...' : 'Sign Document'}
        </button>
      )}
    </div>
  );
}
