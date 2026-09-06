//! Minimal PayPal REST client - just the two calls a checkout needs.
//!
//! Flow: the browser asks us to create an order, PayPal shows its approval
//! window, then the browser asks us to capture it. The secret never leaves this
//! process, and we only trust the capture response - never the browser's word
//! that a payment succeeded.

use base64::Engine;
use serde::Deserialize;

#[derive(Debug)]
pub enum PayPalError {
    Http(String),
    Api { status: u16, body: String },
    Shape(&'static str),
}

impl std::fmt::Display for PayPalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PayPalError::Http(e) => write!(f, "could not reach PayPal: {e}"),
            PayPalError::Api { status, body } => write!(f, "PayPal returned {status}: {body}"),
            PayPalError::Shape(w) => write!(f, "unexpected PayPal response: missing {w}"),
        }
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

pub struct PayPal {
    pub base: String,
    pub client_id: String,
    pub secret: String,
    pub http: reqwest::Client,
}

impl PayPal {
    /// OAuth2 client-credentials token. Cheap enough to fetch per operation;
    /// a checkout is two calls, not a hot loop.
    async fn token(&self) -> Result<String, PayPalError> {
        let basic = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", self.client_id, self.secret));

        let res = self
            .http
            .post(format!("{}/v1/oauth2/token", self.base))
            .header("Authorization", format!("Basic {basic}"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body("grant_type=client_credentials")
            .send()
            .await
            .map_err(|e| PayPalError::Http(e.to_string()))?;

        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(PayPalError::Api { status: status.as_u16(), body: text });
        }
        let parsed: TokenResponse =
            serde_json::from_str(&text).map_err(|_| PayPalError::Shape("access_token"))?;
        Ok(parsed.access_token)
    }

    /// Create an order for a fixed price. Returns the PayPal order id.
    pub async fn create_order(
        &self,
        amount: &str,
        currency: &str,
        description: &str,
    ) -> Result<String, PayPalError> {
        let token = self.token().await?;
        let body = serde_json::json!({
            "intent": "CAPTURE",
            "purchase_units": [{
                "description": description,
                "amount": { "currency_code": currency, "value": amount }
            }],
            "application_context": {
                "shipping_preference": "NO_SHIPPING",
                "user_action": "PAY_NOW",
                "brand_name": "Velox Downloader"
            }
        });

        let res = self
            .http
            .post(format!("{}/v2/checkout/orders", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|e| PayPalError::Http(e.to_string()))?;

        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(PayPalError::Api { status: status.as_u16(), body: text });
        }
        let v: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| PayPalError::Shape("order body"))?;
        v.get("id")
            .and_then(|i| i.as_str())
            .map(|s| s.to_string())
            .ok_or(PayPalError::Shape("id"))
    }

    /// Capture an approved order. Returns (status, amount_paid).
    /// Only a status of COMPLETED should ever result in a licence key.
    pub async fn capture_order(&self, order_id: &str) -> Result<(String, String), PayPalError> {
        let token = self.token().await?;
        let res = self
            .http
            .post(format!("{}/v2/checkout/orders/{}/capture", self.base, order_id))
            .bearer_auth(token)
            .header("Content-Type", "application/json")
            .body("{}")
            .send()
            .await
            .map_err(|e| PayPalError::Http(e.to_string()))?;

        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(PayPalError::Api { status: status.as_u16(), body: text });
        }
        let v: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| PayPalError::Shape("capture body"))?;

        let order_status = v
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("UNKNOWN")
            .to_string();

        let amount = v
            .pointer("/purchase_units/0/payments/captures/0/amount/value")
            .and_then(|a| a.as_str())
            .unwrap_or("0.00")
            .to_string();

        Ok((order_status, amount))
    }
}
