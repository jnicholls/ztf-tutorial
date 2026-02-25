# Document Signing dApp (jarred-assessment)

Multi-party document signing PoC using VIA ZTF (Keycloak), WalletConnect, and a Rust backend.

## Video Walkthrough

https://drive.google.com/file/d/1likzQsYnHT49fgM8V9O_t3gBr4_Hpc9f/view?usp=sharing

## Architecture: Centralized Signing Service

This app is a **centralized** document-signing service. The API (Rust, Axum) is the single source of truth for sessions, signer lists, and signature records. It uses:

- **PostgreSQL** — Stores session metadata, document hash, creator and signer rows, and signature data. All mutable state lives here.
- **RustFS (S3-compatible)** — Stores the actual document bytes. The API uploads the file when a session is created and serves it via a dedicated document endpoint. Only the object key is stored in the DB; the blob is not.
- **Rust API** — Handles auth (ZTF/Keycloak JWT), session CRUD, document upload/download, and signature verification. It checks that the signer is in the session’s signer list, that they haven’t already signed, and that the provided signature recovers to the claimed wallet for the session’s `document_hash`.

Users log in with ZTF and link a wallet via WalletConnect. Signing is done in the wallet (i.e. `personal_sign` over the document hash); the backend only verifies the signature and records it. Trust is in the operator: they control the API and database and could alter or censor data.

## Alternative: Decentralized Design (Smart Contracts + IPFS)

The same workflow could be implemented in a **decentralized** way:

- **Smart contracts (e.g. on Ethereum or an L2)** — A contract could represent a “signing session”: document hash (or IPFS CID), creator, list of signer addresses, and a mapping of address → signature. Methods: `createSession(documentHash, signerAddresses)`, `sign(sessionId)` (submit signature), and view functions to read session state and who has signed. Status (“fully signed”) would be derived on-chain from the number of recorded signatures. No central server holds the source of truth; the chain does.
- **IPFS** — Documents could be stored on IPFS instead of RustFS. The content-addressed CID would be the commitment: the contract (or off-chain metadata) would store the CID; anyone could fetch the file from IPFS and verify its hash matches. No single storage operator; replication and availability depend on the IPFS network and pinning.

## Data Model

The backend uses PostgreSQL for all session and identity data. Sessions are tracked as follows.

- **`user_wallets`** — Maps ZTF identity to a wallet address: `ztf_user_id` (e.g. email) is the primary key; `wallet_address` is the Ethereum-style address used for signing. Used to associate signers with their wallet for verification and display.

- **`signing_sessions`** — One row per signing session. `id` is a UUID (v7). `document_hash` is the canonical SHA-256 hash of the document (hex); all signers must sign this exact value. `document_storage_key` is the object key in RustFS (S3) where the raw file is stored (e.g. `sessions/<uuid>/document`). `document_content_type` stores the optional MIME type for the document. `creator_ztf_user_id` and `creator_wallet` identify who created the session and signed first; `creator_signature` is that signature. `status` is `partially_signed` or `fully_signed`; it is updated when signers complete their signatures. `created_at` is set on insert.

- **`signing_session_signers`** — One row per signer per session. Composite primary key `(session_id, ztf_user_id)`. The creator is inserted with `wallet_address`, `signed_at`, and `signature` set; invited signers are inserted with those fields null. When a signer calls the sign endpoint, the backend verifies their signature against the session’s `document_hash`, then sets `wallet_address`, `signed_at`, and `signature` for that row. This table defines who is allowed to sign (invite list) and who has already signed, and stores the signature for each.

Listing “my sessions” uses `creator_ztf_user_id`; listing “sessions I’m invited to” uses a join on `signing_session_signers` where `ztf_user_id` is the current user and `creator_ztf_user_id` is not (so they did not create the session).

## Design Rationale: Signature Format

**What is signed:** The SHA-256 hash of the raw document bytes, formatted as a hex string (e.g. `0x` + 64 hex chars). Signers use `personal_sign` (EIP-191) over this message, and the backend supports `personal_sign` verification as the primary format.

**Why hash-of-document:** Signing the hash ensures a fixed, deterministic payload regardless of file size. It provides integrity: any change to the document produces a different hash and invalidates signatures.

**Same-version proof:** The backend stores a single canonical `document_hash` per session. All signers must sign that exact hash. The API rejects signatures that do not recover to the expected wallet address or that are for a different hash.

**Third-party verification:** To verify: (1) fetch the session from the API to obtain `document_hash` and the list of signers with their `wallet_address` and `signature`; (2) for each signature, reconstruct the EIP-191 prefixed message hash from the hex string and use `ecrecover` (or equivalent) to recover the signer address; (3) compare the recovered address to the stored `wallet_address` for that signer.

**Why not EIP-712?:** If the VIA Wallet exposes `eth_signTypedData_v4`, the same hash can be wrapped in an EIP-712 struct (e.g. `DocumentSignRequest` with `documentHash`, `sessionId`, `version`) for clearer wallet UX and domain separation. But, I just went with `personal_sign` because:

1. `eth_signTypedData_v4` is not supported afaik. I attemped to request that method and it was not available.
2. This is not an onchain smart contract.
3. The only data being signed is the document hash, so that can be presented in both the wallet and the UI for the user to compare and ensure that's the piece of information they are about to sign. If there were more structured data, then we'd want to prefer `eth_signTypedData_v4` so the user can see the data they're about to sign in a more human-readable format.

## Rust and TypeScript Code

The code quality is low and error handling is verbose and ugly, as I aimed for speed over idiomatic approaches and clean code architecture. The fact is, I have over 11 years experience with Rust and know full well how to write clean, idiomatic Rust including well-defined types, proper layering and organization, and robust error types and error handling. I'm happy to prove that some other time when time allows.

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Node.js 18+ (for local UI development)
- Rust 1.93+ (for local backend development)

### Run with Docker

```bash
cd jarred-assessment
docker compose up --build
```

- **Backend API:** http://localhost:8080
- **PostgreSQL:** localhost:5432 (ztf/ztf, db: jarred_assessment)
- **RustFS:** localhost:9000
- **UI:** http://localhost

The default `docker compose` includes the UI service on port 80 (served by nginx, proxying /api to localhost:8080).

### Run Locally (Development)

1. **Start infrastructure:**
   ```bash
   docker compose up postgres rustfs -d
   ```

2. **Backend:**
   ```bash
   cd backend
   export DATABASE_URL="postgres://ztf:ztf@localhost:5432/jarred_assessment"
   export RUSTFS_ENDPOINT="http://localhost:9000"
   export RUSTFS_BUCKET="documents"
   export RUSTFS_ACCESS_KEY="viaadmin"
   export RUSTFS_SECRET_KEY="viaadmin"
   cargo run -p api
   ```

3. **UI:**
   ```bash
   cd ui
   npm install
   npm run dev
   ```

   The Vite server proxies `/api` to the backend. Open http://localhost:5173.

### Keycloak Configuration

The app uses the ZTF demo realm (`ztf_demo`) at `https://auth.solvewithvia.com/auth`. Ensure the `localhost-app` client has redirect URIs for your dev URL (e.g. `http://localhost:5173/*`).

