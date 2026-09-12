//! The token the app carries between requests.
//!
//! A short-lived bearer for one key on one machine. It is re-issued on every
//! heartbeat, so a leaked token is superseded within the heartbeat interval
//! rather than living as long as the licence does.
//!
//! The secret is the same file the Node server uses (`data/.jwt-secret`, 0600),
//! generated on first run if it is not there. Sharing it is deliberate: while
//! both servers are up, a token from either is accepted by the other, which is
//! what makes a cutover — and a rollback — invisible to customers.

use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub key: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(default)]
    pub email: Option<String>,
    pub exp: i64,
}

/// An admin session. Nothing about a licence: it says only that whoever holds
/// this cookie signed in with the panel password, and when that stops being
/// true.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminClaims {
    pub role: String,
    pub u: String,
    pub exp: i64,
}

/// How long a panel session lasts. Short enough that a forgotten browser on
/// someone else's machine stops being a way in by the end of the day.
pub const ADMIN_TTL_SECONDS: i64 = 12 * 3600;

pub struct Tokens {
    encoding: EncodingKey,
    decoding: DecodingKey,
    ttl_hours: i64,
}

impl Tokens {
    pub fn new(secret: &str, ttl_hours: i64) -> Self {
        Self {
            encoding: EncodingKey::from_secret(secret.as_bytes()),
            decoding: DecodingKey::from_secret(secret.as_bytes()),
            ttl_hours: ttl_hours.max(1),
        }
    }

    /// Reads the shared secret, writing one the first time. The file is the
    /// licence system's root of trust: anyone holding it can mint a token for
    /// any key, so it is created 0600 and never logged.
    pub fn from_data_dir(dir: &Path, ttl_hours: i64) -> std::io::Result<Self> {
        let file = dir.join(".jwt-secret");
        let secret = if file.exists() {
            std::fs::read_to_string(&file)?.trim().to_string()
        } else {
            use rand::Rng;
            let mut bytes = [0u8; 48];
            rand::thread_rng().fill(&mut bytes[..]);
            let secret = base64_url(&bytes);
            std::fs::create_dir_all(dir)?;
            std::fs::write(&file, &secret)?;
            restrict(&file);
            secret
        };
        Ok(Self::new(&secret, ttl_hours))
    }

    pub fn issue(&self, key: &str, device_id: &str, email: Option<&str>) -> Option<String> {
        let exp = crate::model::now_ms() / 1000 + self.ttl_hours * 3600;
        let claims = Claims {
            key: key.to_string(),
            device_id: device_id.to_string(),
            email: email.map(str::to_string),
            exp,
        };
        encode(&Header::new(Algorithm::HS256), &claims, &self.encoding).ok()
    }

    pub fn verify(&self, token: &str) -> Option<Claims> {
        let mut rules = Validation::new(Algorithm::HS256);
        // The Node server signs no audience or issuer, so neither is required
        // here; the expiry is what matters and is checked by default.
        rules.required_spec_claims.clear();
        decode::<Claims>(token, &self.decoding, &rules).ok().map(|data| data.claims)
    }

    pub fn ttl_seconds(&self) -> i64 {
        self.ttl_hours * 3600
    }

    /// Signed with the same secret as a licence token, and deliberately a
    /// different shape: a licence token has no role, so it can never be
    /// presented as an admin session, and an admin cookie names no key, so it
    /// can never be spent as a licence.
    pub fn issue_admin(&self, user: &str) -> Option<String> {
        let claims = AdminClaims {
            role: "admin".to_string(),
            u: user.to_string(),
            exp: crate::model::now_ms() / 1000 + ADMIN_TTL_SECONDS,
        };
        encode(&Header::new(Algorithm::HS256), &claims, &self.encoding).ok()
    }

    pub fn verify_admin(&self, token: &str) -> Option<AdminClaims> {
        let mut rules = Validation::new(Algorithm::HS256);
        rules.required_spec_claims.clear();
        let claims = decode::<AdminClaims>(token, &self.decoding, &rules).ok()?.claims;
        (claims.role == "admin").then_some(claims)
    }
}

fn base64_url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        let take = chunk.len() + 1;
        for i in 0..take {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {
    // Windows inherits the data directory's ACL; the server runs on Linux.
}
