use std::{env, net::SocketAddr, sync::Arc};

use aws_config::BehaviorVersion;
use aws_sdk_s3::{Client as S3Client, config::Credentials, primitives::ByteStream};
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, put},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info, warn};
use uuid::Uuid;

use auth::{AuthLayer, AuthUser, JwtValidator};
use signature::{normalize_address, recover_signer};

mod auth;
mod signature;

#[derive(Clone)]
struct AppState {
    db: PgPool,
    s3: S3Client,
    bucket: String,
}

#[derive(Serialize)]
struct HealthResponse {
    status: String,
}

#[derive(Deserialize)]
struct CreateSessionMetadata {
    document_hash: String,
    creator_signature: String,
    creator_wallet_address: String,
    signer_ztf_user_ids: Vec<String>,
    document_content_type: Option<String>,
}

#[derive(Serialize)]
struct CreateSessionResponse {
    session_id: Uuid,
}

#[derive(Serialize)]
struct SignerInfo {
    ztf_user_id: String,
    wallet_address: Option<String>,
    signed_at: Option<DateTime<Utc>>,
    signature: Option<String>,
}

#[derive(Serialize)]
struct SessionSummary {
    id: Uuid,
    status: String,
    created_at: DateTime<Utc>,
    creator_ztf_user_id: Option<String>,
}

#[derive(Serialize)]
struct ListSessionsResponse {
    owned: Vec<SessionSummary>,
    participant: Vec<SessionSummary>,
}

#[derive(Serialize)]
struct SessionDetail {
    id: Uuid,
    document_hash: String,
    status: String,
    creator_ztf_user_id: String,
    creator_wallet: String,
    signers: Vec<SignerInfo>,
}

#[derive(Deserialize)]
struct SignSessionRequest {
    wallet_address: String,
    signature: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    message: String,
}

async fn run_migrations(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS user_wallets (
            ztf_user_id TEXT PRIMARY KEY,
            wallet_address TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS signing_sessions (
            id UUID PRIMARY KEY,
            document_hash TEXT NOT NULL,
            document_content_type TEXT,
            document_storage_key TEXT NOT NULL,
            creator_ztf_user_id TEXT NOT NULL,
            creator_wallet TEXT NOT NULL,
            creator_signature TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS signing_session_signers (
            session_id UUID NOT NULL REFERENCES signing_sessions(id) ON DELETE CASCADE,
            ztf_user_id TEXT NOT NULL,
            wallet_address TEXT,
            signed_at TIMESTAMPTZ,
            signature TEXT,
            PRIMARY KEY (session_id, ztf_user_id)
        );
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn ensure_bucket(s3: &S3Client, bucket: &str) -> anyhow::Result<()> {
    match s3.head_bucket().bucket(bucket).send().await {
        Ok(_) => Ok(()),
        Err(e) => {
            let code = e.raw_response().map(|r| r.status().as_u16());
            if code == Some(404) {
                s3.create_bucket().bucket(bucket).send().await?;
                info!("Created bucket {}", bucket);
            } else {
                return Err(e.into());
            }
            Ok(())
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let database_url =
        env::var("DATABASE_URL").expect("DATABASE_URL environment variable must be set");
    let rustfs_endpoint =
        env::var("RUSTFS_ENDPOINT").expect("RUSTFS_ENDPOINT environment variable must be set");
    let rustfs_region = env::var("RUSTFS_REGION").unwrap_or_else(|_| "us-east-1".to_string());
    let bucket = env::var("RUSTFS_BUCKET").unwrap_or_else(|_| "documents".to_string());
    let jwt_issuer = env::var("JWT_ISSUER").ok();

    let db = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    run_migrations(&db).await?;

    let credentials = Credentials::new(
        env::var("RUSTFS_ACCESS_KEY").unwrap_or_else(|_| "viaadmin".to_string()),
        env::var("RUSTFS_SECRET_KEY").unwrap_or_else(|_| "viaadmin".to_string()),
        None,
        None,
        "static",
    );
    let aws_config = aws_config::defaults(BehaviorVersion::latest())
        .endpoint_url(&rustfs_endpoint)
        .credentials_provider(credentials)
        .region(aws_config::Region::new(rustfs_region))
        .load()
        .await;
    let mut s3_config = aws_sdk_s3::config::Builder::from(&aws_config);
    s3_config.set_force_path_style(Some(true));
    let s3 = S3Client::from_conf(s3_config.build());

    ensure_bucket(&s3, &bucket).await?;

    let jwt_validator = Arc::new(JwtValidator::new(jwt_issuer));
    if jwt_validator.config.is_some() {
        if let Err(e) = jwt_validator.refresh_jwks().await {
            warn!(
                "Initial JWKS fetch failed: {} (will retry on first request)",
                e
            );
        }
    }

    let state = Arc::new(AppState {
        db,
        s3,
        bucket: bucket.clone(),
    });

    let auth_layer = AuthLayer::new(jwt_validator);

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/sessions", get(list_sessions).post(create_session))
        .route("/api/sessions/{id}", get(get_session))
        .route("/api/sessions/{id}/document", get(get_session_document))
        .route("/api/sessions/{id}/sign", put(sign_session))
        .layer(auth_layer)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state);

    let addr: SocketAddr = "0.0.0.0:8080".parse()?;
    info!("Starting API server on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let db_ok = sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&state.db)
        .await
        .is_ok();
    let status = if db_ok { "ok" } else { "degraded" }.to_string();
    Json(HealthResponse { status })
}

async fn list_sessions(State(state): State<Arc<AppState>>, auth: AuthUser) -> impl IntoResponse {
    let user_id = auth.0.ztf_user_id();

    let owned_rows = match sqlx::query_as::<_, (Uuid, String, DateTime<Utc>)>(
        r#"
        SELECT id, status, created_at
        FROM signing_sessions
        WHERE creator_ztf_user_id = $1
        ORDER BY created_at DESC
        "#,
    )
    .bind(&user_id)
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            error!("DB error listing owned sessions: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    message: "Database error".to_string(),
                }),
            )
                .into_response();
        }
    };

    let participant_rows = match sqlx::query_as::<_, (Uuid, String, DateTime<Utc>, String)>(
        r#"
        SELECT s.id, s.status, s.created_at, s.creator_ztf_user_id
        FROM signing_sessions s
        INNER JOIN signing_session_signers ss ON ss.session_id = s.id AND ss.ztf_user_id = $1
        WHERE s.creator_ztf_user_id != $1
        ORDER BY s.created_at DESC
        "#,
    )
    .bind(&user_id)
    .bind(&user_id)
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            error!("DB error listing participant sessions: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    message: "Database error".to_string(),
                }),
            )
                .into_response();
        }
    };

    let owned: Vec<_> = owned_rows
        .into_iter()
        .map(|(id, status, created_at)| SessionSummary {
            id,
            status,
            created_at,
            creator_ztf_user_id: Some(user_id.clone()),
        })
        .collect();

    let participant: Vec<_> = participant_rows
        .into_iter()
        .map(
            |(id, status, created_at, creator_ztf_user_id)| SessionSummary {
                id,
                status,
                created_at,
                creator_ztf_user_id: Some(creator_ztf_user_id),
            },
        )
        .collect();

    Json(ListSessionsResponse { owned, participant }).into_response()
}

async fn create_session(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let creator_ztf_user_id = auth.0.ztf_user_id();

    let mut document_data: Option<Bytes> = None;
    let mut metadata_json: Option<String> = None;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or_default().to_string();
        if name == "document" {
            if let Ok(data) = field.bytes().await {
                document_data = Some(data);
            }
        } else if name == "metadata" {
            if let Ok(text) = field.text().await {
                metadata_json = Some(text);
            }
        }
    }

    let metadata: CreateSessionMetadata = match metadata_json {
        Some(ref j) => match serde_json::from_str(j) {
            Ok(m) => m,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ErrorResponse {
                        message: format!("Invalid metadata JSON: {}", e),
                    }),
                )
                    .into_response();
            }
        },
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    message: "Missing metadata field".to_string(),
                }),
            )
                .into_response();
        }
    };

    let document_bytes = match document_data {
        Some(d) => d,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    message: "Missing document file".to_string(),
                }),
            )
                .into_response();
        }
    };

    // Verify document hash matches
    let hash = Sha256::digest(&document_bytes);
    let computed_hash = format!("0x{}", hex::encode(hash));
    let expected_hash = metadata
        .document_hash
        .trim_start_matches("0x")
        .to_lowercase();
    let computed_hex = computed_hash.trim_start_matches("0x").to_lowercase();
    if expected_hash != computed_hex {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Document hash mismatch".to_string(),
            }),
        )
            .into_response();
    }

    let session_id = Uuid::now_v7();
    let storage_key = format!("sessions/{}/document", session_id);

    let content_type: Option<&str> = metadata
        .document_content_type
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(String::as_str);

    if let Err(e) = state
        .s3
        .put_object()
        .bucket(&state.bucket)
        .key(&storage_key)
        .body(ByteStream::from(document_bytes.to_vec()))
        .content_type(content_type.unwrap_or("application/octet-stream"))
        .send()
        .await
    {
        error!("S3 upload failed: {}", e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                message: "Failed to store document".to_string(),
            }),
        )
            .into_response();
    }

    let mut signer_ids: Vec<String> = vec![creator_ztf_user_id.clone()];
    signer_ids.extend(metadata.signer_ztf_user_ids.iter().cloned());
    signer_ids.sort();
    signer_ids.dedup();

    let status = if signer_ids.len() == 1 {
        "fully_signed"
    } else {
        "partially_signed"
    };

    if let Err(e) = sqlx::query(
        r#"
        INSERT INTO signing_sessions (id, document_hash, document_content_type, document_storage_key, creator_ztf_user_id, creator_wallet, creator_signature, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        "#,
    )
    .bind(session_id)
    .bind(&metadata.document_hash)
    .bind(content_type)
    .bind(&storage_key)
    .bind(&creator_ztf_user_id)
    .bind(&metadata.creator_wallet_address)
    .bind(&metadata.creator_signature)
    .bind(status)
    .execute(&state.db)
    .await
    {
        error!("DB insert failed: {}", e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                message: "Failed to create session".to_string(),
            }),
        )
            .into_response();
    }

    for ztf_id in &signer_ids {
        let is_creator = ztf_id == &creator_ztf_user_id;
        let (wallet, signed_at, sig) = if is_creator {
            (
                Some(metadata.creator_wallet_address.clone()),
                Some(Utc::now()),
                Some(metadata.creator_signature.clone()),
            )
        } else {
            (None, None, None)
        };
        if let Err(e) = sqlx::query(
            r#"
            INSERT INTO signing_session_signers (session_id, ztf_user_id, wallet_address, signed_at, signature)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(session_id)
        .bind(ztf_id)
        .bind(&wallet)
        .bind(signed_at)
        .bind(&sig)
        .execute(&state.db)
        .await
        {
            error!("Signer insert failed: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    message: "Failed to create session".to_string(),
                }),
            )
                .into_response();
        }
    }

    (
        StatusCode::CREATED,
        Json(CreateSessionResponse { session_id }),
    )
        .into_response()
}

async fn get_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    let row = match sqlx::query_as::<_, (Uuid, String, String, String, String, String)>(
        r#"
        SELECT id, document_hash, document_storage_key, creator_ztf_user_id, creator_wallet, status
        FROM signing_sessions WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    message: "Session not found".to_string(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            error!("DB error: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    message: "Database error".to_string(),
                }),
            )
                .into_response();
        }
    };

    let (session_id, document_hash, _storage_key, creator_ztf_user_id, creator_wallet, status) =
        row;

    let signer_rows = match sqlx::query_as::<
        _,
        (
            String,
            Option<String>,
            Option<DateTime<Utc>>,
            Option<String>,
        ),
    >(
        r#"
        SELECT ztf_user_id, wallet_address, signed_at, signature
        FROM signing_session_signers WHERE session_id = $1
        ORDER BY ztf_user_id
        "#,
    )
    .bind(id)
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            error!("DB error: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    message: "Database error".to_string(),
                }),
            )
                .into_response();
        }
    };

    let signers: Vec<SignerInfo> = signer_rows
        .into_iter()
        .map(
            |(ztf_user_id, wallet_address, signed_at, signature)| SignerInfo {
                ztf_user_id,
                wallet_address,
                signed_at,
                signature,
            },
        )
        .collect();

    Json(SessionDetail {
        id: session_id,
        document_hash,
        status,
        creator_ztf_user_id,
        creator_wallet,
        signers,
    })
    .into_response()
}

async fn get_session_document(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    let _ = auth;

    let row = match sqlx::query_as::<_, (String, Option<String>)>(
        r#"SELECT document_storage_key, document_content_type FROM signing_sessions WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    message: "Session not found".to_string(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            error!("DB error: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    message: "Database error".to_string(),
                }),
            )
                .into_response();
        }
    };

    let (key, stored_content_type) = row;

    let obj = match state
        .s3
        .get_object()
        .bucket(&state.bucket)
        .key(&key)
        .send()
        .await
    {
        Ok(o) => o,
        Err(e) => {
            error!("S3 get failed: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    message: "Failed to retrieve document".to_string(),
                }),
            )
                .into_response();
        }
    };

    let content_type = stored_content_type
        .filter(|s| !s.is_empty())
        .or_else(|| obj.content_type().map(|s| s.to_string()))
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let body = match obj.body.collect().await {
        Ok(b) => b.into_bytes(),
        Err(e) => {
            error!("S3 body read failed: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    message: "Failed to read document".to_string(),
                }),
            )
                .into_response();
        }
    };

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", content_type)
        .body(Body::from(body))
        .unwrap()
}

async fn sign_session(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<Uuid>,
    Json(payload): Json<SignSessionRequest>,
) -> impl IntoResponse {
    let ztf_user_id = auth.0.ztf_user_id();

    if payload.signature.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "signature must not be empty".to_string(),
            }),
        )
            .into_response();
    }

    let session_row = match sqlx::query_as::<_, (String, String)>(
        r#"SELECT document_hash, status FROM signing_sessions WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    message: "Session not found".to_string(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            error!("DB error: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    message: "Database error".to_string(),
                }),
            )
                .into_response();
        }
    };

    let (document_hash, status) = session_row;
    if status == "fully_signed" {
        return (
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                message: "Session already fully signed".to_string(),
            }),
        )
            .into_response();
    }

    let (_, existing_signature) = match sqlx::query_as::<_, (String, Option<String>)>(
        r#"SELECT ztf_user_id, signature FROM signing_session_signers WHERE session_id = $1 AND ztf_user_id = $2"#,
    )
    .bind(id)
    .bind(&ztf_user_id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(row)) => row,
        Ok(None) => {
            return (
                StatusCode::FORBIDDEN,
                Json(ErrorResponse {
                    message: "Signer not in list".to_string(),
                }),
            )
                .into_response();
        }
        Err(e) => {
            error!("DB error: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    message: "Database error".to_string(),
                }),
            )
                .into_response();
        }
    };

    if existing_signature.is_some() {
        return (
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                message: "Already signed".to_string(),
            }),
        )
            .into_response();
    }

    let message_str = if document_hash.starts_with("0x") {
        document_hash.clone()
    } else {
        format!("0x{}", document_hash)
    };
    let message = message_str.as_bytes();

    let recovered = match recover_signer(message, &payload.signature) {
        Ok(a) => a,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    message: format!("Invalid signature: {}", e),
                }),
            )
                .into_response();
        }
    };

    let expected = normalize_address(&payload.wallet_address);
    let recovered_norm = normalize_address(&recovered.to_string());
    if expected != recovered_norm {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                message: "Signature does not match wallet address".to_string(),
            }),
        )
            .into_response();
    }

    let now = Utc::now();
    if let Err(e) = sqlx::query(
        r#"
        UPDATE signing_session_signers
        SET wallet_address = $1, signed_at = $2, signature = $3
        WHERE session_id = $4 AND ztf_user_id = $5
        "#,
    )
    .bind(&payload.wallet_address)
    .bind(now)
    .bind(&payload.signature)
    .bind(id)
    .bind(&ztf_user_id)
    .execute(&state.db)
    .await
    {
        error!("DB update failed: {}", e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                message: "Failed to record signature".to_string(),
            }),
        )
            .into_response();
    }

    let signed_count: (i64,) = sqlx::query_as(
        r#"SELECT COUNT(*)::bigint FROM signing_session_signers WHERE session_id = $1 AND signature IS NOT NULL"#,
    )
    .bind(id)
    .fetch_one(&state.db)
    .await
    .unwrap_or((0,));
    let total_count: (i64,) = sqlx::query_as(
        r#"SELECT COUNT(*)::bigint FROM signing_session_signers WHERE session_id = $1"#,
    )
    .bind(id)
    .fetch_one(&state.db)
    .await
    .unwrap_or((0,));

    let new_status = if signed_count.0 >= total_count.0 {
        "fully_signed"
    } else {
        "partially_signed"
    };
    let _ = sqlx::query(r#"UPDATE signing_sessions SET status = $1 WHERE id = $2"#)
        .bind(new_status)
        .bind(id)
        .execute(&state.db)
        .await;

    StatusCode::NO_CONTENT.into_response()
}
