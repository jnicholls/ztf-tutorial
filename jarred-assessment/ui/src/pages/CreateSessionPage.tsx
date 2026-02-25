import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDocumentSign } from '../context/DocumentSignService';
import { useWalletConnect } from '../context/WalletConnectProvider';
import { useAuth } from '../context/AuthContext';
import { createSession } from '../api/client';
import { sha256Hex } from '../utils/hash';

export function CreateSessionPage() {
  const navigate = useNavigate();
  const { token } = useAuth();
  const { signDocumentHash, isLoading: signing } = useDocumentSign();
  const { getWalletAddress, isConnected } = useWalletConnect();
  const [file, setFile] = useState<File | null>(null);
  const [signerEmails, setSignerEmails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [documentHashForDisplay, setDocumentHashForDisplay] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setDocumentHashForDisplay(null);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return f.type.startsWith('image/') || f.type === 'application/pdf'
          ? URL.createObjectURL(f)
          : null;
      });
      f.arrayBuffer()
        .then((bytes) => sha256Hex(bytes))
        .then((hash) => setDocumentHashForDisplay(hash.startsWith('0x') ? hash : `0x${hash}`))
        .catch(() => setDocumentHashForDisplay(null));
    } else {
      setDocumentHashForDisplay(null);
    }
  };

  const handleSubmit = async (e: React.SubmitEvent) => {
    e.preventDefault();
    setError(null);
    setSessionId(null);
    if (!file) {
      setError('Please select a document');
      return;
    }
    const walletAddress = getWalletAddress();
    if (!walletAddress) {
      setError('Wallet not connected');
      return;
    }
    if (!token) {
      setError('Not authenticated');
      return;
    }
    try {
      const bytes = await file.arrayBuffer();
      const documentHash = await sha256Hex(bytes);
      const signature = await signDocumentHash(documentHash);
      if (!signature) {
        setError('Signing was rejected or failed');
        return;
      }
      const signerIds = signerEmails
        .split(/[\s,]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const result = await createSession(token, file, {
        document_hash: documentHash,
        creator_signature: signature,
        creator_wallet_address: walletAddress,
        signer_ztf_user_ids: signerIds,
        document_content_type: file.type || undefined,
      });
      setSessionId(result.session_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 600 }}>
      <h1>Create & Sign Document</h1>
      {!isConnected && (
        <p style={{ color: '#c00' }}>Wallet not connected. You must be logged in with ZTF and have WalletConnect session.</p>
      )}
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label>Document</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
            onChange={handleFileChange}
            style={{ display: 'block', marginTop: 4 }}
          />
          {previewUrl && (
            <div style={{ marginTop: 8 }}>
              {file?.type === 'application/pdf' ? (
                <iframe src={previewUrl} title="Preview" width="100%" height="300" style={{ border: '1px solid #ccc' }} />
              ) : file?.type.startsWith('image/') ? (
                <img src={previewUrl} alt="Preview" style={{ maxWidth: '100%', maxHeight: 200 }} />
              ) : null}
            </div>
          )}
        </div>
        {documentHashForDisplay && (
          <div style={{ padding: 12, background: '#f0f4ff', borderRadius: 4, border: '1px solid #c5d0e8', color: '#333' }}>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
              Document hash (compare with VIA wallet when signing)
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
              {documentHashForDisplay}
            </code>
          </div>
        )}
        <div>
          <label>Signer emails (comma-separated)</label>
          <input
            type="text"
            placeholder="user2@example.com, user3@example.com"
            value={signerEmails}
            onChange={(e) => setSignerEmails(e.target.value)}
            style={{ width: '100%', padding: 8, marginTop: 4 }}
          />
        </div>
        {error && <p style={{ color: '#c00' }}>{error}</p>}
        <button type="submit" disabled={!file || !isConnected || signing} style={{ padding: 10, cursor: signing ? 'wait' : 'pointer' }}>
          {signing ? 'Signing...' : 'Sign & Create Session'}
        </button>
      </form>
      {sessionId && (
        <div style={{ marginTop: 24, padding: 16, background: '#e8f5e9', borderRadius: 4, color: '#333' }}>
          <p><strong>Session created!</strong></p>
          <p>Share this URL:</p>
          <code style={{ display: 'block', wordBreak: 'break-all', background: '#fff', padding: 8 }}>
            {window.location.origin}/sessions/{sessionId}
          </code>
          <button
            type="button"
            onClick={() => navigate(`/sessions/${sessionId}`)}
            style={{ marginTop: 8, padding: '8px 16px' }}
          >
            Open Session
          </button>
        </div>
      )}
    </div>
  );
}
