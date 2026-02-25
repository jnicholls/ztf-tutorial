//! JWT extraction and validation for ZTF (Keycloak) tokens.

use axum::{
    extract::FromRequestParts,
    http::{header, request::Parts, StatusCode},
};
use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::Deserialize;
use std::sync::Arc;
use tower::Layer;
use tokio::sync::RwLock;

/// Used to pass JwtValidator into the extractor via request extensions.
#[derive(Clone)]
pub struct JwtValidatorExt(pub Arc<JwtValidator>);

/// Layer that inserts JwtValidatorExt into request extensions for all routes.
#[derive(Clone)]
pub struct AuthLayer {
    validator: Arc<JwtValidator>,
}

impl AuthLayer {
    pub fn new(validator: Arc<JwtValidator>) -> Self {
        Self { validator }
    }
}

impl<S> Layer<S> for AuthLayer {
    type Service = AuthMiddleware<S>;

    fn layer(&self, inner: S) -> Self::Service {
        AuthMiddleware {
            inner,
            validator: self.validator.clone(),
        }
    }
}

#[derive(Clone)]
pub struct AuthMiddleware<S> {
    inner: S,
    validator: Arc<JwtValidator>,
}

impl<S, ReqBody> tower::Service<axum::http::Request<ReqBody>> for AuthMiddleware<S>
where
    S: tower::Service<axum::http::Request<ReqBody>> + Clone + Send,
    S::Future: Send,
    ReqBody: Send,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = S::Future;

    fn poll_ready(
        &mut self,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), S::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut req: axum::http::Request<ReqBody>) -> S::Future {
        let validator = self.validator.clone();
        req.extensions_mut().insert(JwtValidatorExt(validator));
        self.inner.call(req)
    }
}

#[derive(Clone, Debug)]
pub struct JwtConfig {
    pub issuer: String,
    pub jwks_url: String,
}

#[derive(Clone)]
pub struct JwtValidator {
    pub config: Option<JwtConfig>,
    /// Cached JWKS: map of kid -> (DecodingKey, alg)
    keys: Arc<RwLock<Vec<(String, DecodingKey)>>>,
}

impl JwtValidator {
    pub fn new(issuer: Option<String>) -> Self {
        let (config, keys) = if let Some(iss) = issuer.filter(|s| !s.is_empty()) {
            let jwks_url = format!("{}/protocol/openid-connect/certs", iss.trim_end_matches('/'));
            (
                Some(JwtConfig {
                    issuer: iss.clone(),
                    jwks_url: jwks_url.clone(),
                }),
                Arc::new(RwLock::new(Vec::new())),
            )
        } else {
            (None, Arc::new(RwLock::new(Vec::new())))
        };
        Self { config, keys }
    }

    pub async fn refresh_jwks(&self) -> anyhow::Result<()> {
        let config = match &self.config {
            Some(c) => c,
            None => return Ok(()),
        };
        let resp = reqwest::get(&config.jwks_url).await?;
        let jwks: JwksResponse = resp.json().await?;
        let mut new_keys = Vec::new();
        for key in jwks.keys {
            if key.kty != "RSA" || key.alg.as_deref() != Some("RS256") {
                continue;
            }
            let Some(n_b64) = key.n else { continue };
            let Some(e_b64) = key.e else { continue };
            let decoding_key = DecodingKey::from_rsa_components(&n_b64, &e_b64)?;
            let kid = key.kid.unwrap_or_default();
            new_keys.push((kid, decoding_key));
        }
        *self.keys.write().await = new_keys;
        Ok(())
    }

    pub async fn validate(&self, token: &str) -> anyhow::Result<JwtClaims> {
        if self.config.is_none() {
            // No JWT config: decode without verification (PoC / local dev only)
            let parts: Vec<&str> = token.splitn(3, '.').collect();
            if parts.len() != 3 {
                anyhow::bail!("Invalid JWT format");
            }
            let payload_b64 = parts[1];
            let payload_json = base64_decode_url_str(payload_b64)?;
            let claims: JwtClaims = serde_json::from_str(&payload_json)?;
            return Ok(claims);
        }
        let header = jsonwebtoken::decode_header(token)?;
        let kid = header.kid.ok_or_else(|| anyhow::anyhow!("JWT missing kid"))?;
        let keys = self.keys.read().await;
        let (_, decoding_key) = keys
            .iter()
            .find(|(k, _)| k == &kid)
            .ok_or_else(|| anyhow::anyhow!("Unknown key id: {}", kid))?;
        let mut validation = Validation::new(jsonwebtoken::Algorithm::RS256);
        validation.set_issuer(&[self.config.as_ref().unwrap().issuer.clone()]);
        validation.validate_exp = true;
        let data = decode::<JwtClaims>(token, decoding_key, &validation)?;
        Ok(data.claims)
    }
}

fn base64_decode_url(b64: &str) -> anyhow::Result<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(b64)
        .map_err(Into::into)
}

fn base64_decode_url_str(b64: &str) -> anyhow::Result<String> {
    let bytes = base64_decode_url(b64)?;
    String::from_utf8(bytes).map_err(Into::into)
}

#[derive(Debug, Deserialize)]
struct JwksResponse {
    keys: Vec<JwkKey>,
}

#[derive(Debug, Deserialize)]
struct JwkKey {
    kty: String,
    kid: Option<String>,
    alg: Option<String>,
    n: Option<String>,
    e: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct JwtClaims {
    pub sub: Option<String>,
    pub preferred_username: Option<String>,
    pub exp: Option<i64>,
}

impl JwtClaims {
    pub fn ztf_user_id(&self) -> String {
        self.preferred_username
            .clone()
            .or_else(|| self.sub.clone())
            .unwrap_or_else(|| "unknown".to_string())
    }
}

pub struct AuthUser(pub JwtClaims);

impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
{
    type Rejection = (StatusCode, String);

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        let auth = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|s| s.to_string());
        let validator = parts.extensions.get::<JwtValidatorExt>().cloned();
        async move {
            let auth = auth.ok_or_else(|| {
                (
                    StatusCode::UNAUTHORIZED,
                    "Missing or invalid Authorization header".to_string(),
                )
            })?;
            let validator = validator.ok_or_else(|| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Auth not configured".to_string(),
                )
            })?;
            let claims = validator
                .0
                .validate(&auth)
                .await
                .map_err(|e| (StatusCode::UNAUTHORIZED, format!("Invalid token: {}", e)))?;
            Ok(AuthUser(claims))
        }
    }
}
