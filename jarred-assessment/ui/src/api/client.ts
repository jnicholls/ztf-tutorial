const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export interface SessionSummary {
  id: string;
  status: string;
  created_at: string;
  creator_ztf_user_id?: string;
}

export interface ListSessionsResponse {
  owned: SessionSummary[];
  participant: SessionSummary[];
}

export async function getSessions(token: string): Promise<ListSessionsResponse> {
  const res = await fetch(`${API_BASE}/api/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error((err as { message?: string }).message || 'Failed to fetch sessions');
  }
  return res.json();
}

export async function getSession(sessionId: string, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error((err as { message?: string }).message || 'Failed to fetch session');
  }
  return res.json();
}

export async function getSessionDocument(
  sessionId: string,
  token: string
): Promise<{ blob: Blob; contentType: string | null }> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/document`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Failed to fetch document');
  const blob = await res.blob();
  const contentType = res.headers.get('Content-Type');
  return { blob, contentType };
}

export async function createSession(
  token: string,
  document: File,
  metadata: {
    document_hash: string;
    creator_signature: string;
    creator_wallet_address: string;
    signer_ztf_user_ids: string[];
    document_content_type?: string;
  }
) {
  const form = new FormData();
  form.append('document', document);
  form.append('metadata', JSON.stringify(metadata));
  const res = await fetch(`${API_BASE}/api/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error((err as { message?: string }).message || 'Failed to create session');
  }
  return res.json() as Promise<{ session_id: string }>;
}

export async function signSession(
  sessionId: string,
  token: string,
  payload: { wallet_address: string; signature: string }
) {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/sign`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error((err as { message?: string }).message || 'Failed to sign');
  }
}
