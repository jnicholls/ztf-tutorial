import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getSessions, type SessionSummary } from '../api/client';

function SessionList({ sessions, emptyMessage }: { sessions: SessionSummary[]; emptyMessage: string }) {
  if (sessions.length === 0) {
    return <p style={{ color: '#666', fontStyle: 'italic' }}>{emptyMessage}</p>;
  }
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {sessions.map((s) => (
        <li key={s.id} style={{ marginBottom: 8 }}>
          <Link
            to={`/sessions/${s.id}`}
            style={{
              display: 'block',
              padding: 12,
              background: '#f5f5f5',
              borderRadius: 4,
              textDecoration: 'none',
              color: '#333',
            }}
          >
            <span style={{ fontWeight: 500 }}>{s.id.slice(0, 8)}...</span>
            <span style={{ marginLeft: 8, color: '#666', fontSize: 14 }}>
              {s.status.replace(/_/g, ' ')} · {new Date(s.created_at).toLocaleDateString()}
            </span>
            {s.creator_ztf_user_id && (
              <span style={{ marginLeft: 8, color: '#888', fontSize: 13 }}>
                by {s.creator_ztf_user_id}
              </span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function HomePage() {
  const { token } = useAuth();
  const [owned, setOwned] = useState<SessionSummary[]>([]);
  const [participant, setParticipant] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    getSessions(token)
      .then(({ owned: o, participant: p }) => {
        setOwned(o);
        setParticipant(p);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load sessions'))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div style={{ padding: 24, maxWidth: 700 }}>
      <h1>Document Signing dApp</h1>
      <p>Multi-party document signing with VIA ZTF and WalletConnect.</p>
      <nav style={{ display: 'flex', gap: 16, marginTop: 24, marginBottom: 32 }}>
        <Link
          to="/create"
          style={{
            padding: '8px 16px',
            background: '#333',
            color: '#fff',
            textDecoration: 'none',
            borderRadius: 4,
          }}
        >
          Create & Sign Document
        </Link>
      </nav>

      {loading && <p>Loading sessions...</p>}
      {error && <p style={{ color: '#c00' }}>{error}</p>}

      {!loading && !error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
          <section>
            <h2 style={{ marginTop: 0, marginBottom: 12 }}>My Sessions</h2>
            <p style={{ color: '#666', fontSize: 14, marginBottom: 12 }}>Sessions you created</p>
            <SessionList sessions={owned} emptyMessage="No sessions yet. Create one to get started." />
          </section>
          <section>
            <h2 style={{ marginTop: 0, marginBottom: 12 }}>Invited to Sign</h2>
            <p style={{ color: '#666', fontSize: 14, marginBottom: 12 }}>Sessions you were invited to participate in</p>
            <SessionList sessions={participant} emptyMessage="No pending invitations." />
          </section>
        </div>
      )}
    </div>
  );
}
