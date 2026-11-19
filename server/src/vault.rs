// Encryption of the saved connections (passwords included) with a secret kept outside the data folder.
// File format: JSON { v: 1, salt, iv, tag, data } (base64), AES-256-GCM with a key derived from the secret by scrypt
// (N = 16384, r = 8, p = 1: Node's defaults, which wrote the first files).

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize)]
pub struct Sealed {
    pub v: u8,
    pub salt: String,
    pub iv: String,
    pub tag: String,
    pub data: String,
}

fn key_of(secret: &str, salt: &[u8]) -> [u8; 32] {
    let params = scrypt::Params::new(14, 8, 1, 32).expect("scrypt parameters");
    let mut key = [0u8; 32];
    scrypt::scrypt(secret.as_bytes(), salt, &params, &mut key).expect("scrypt output length");
    key
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("no random source");
    b
}

pub fn seal(plain: &str, secret: &str) -> String {
    let salt = random::<16>();
    let iv = random::<12>();
    let cipher = Aes256Gcm::new(&key_of(secret, &salt).into());
    let mut data = cipher.encrypt(Nonce::from_slice(&iv), plain.as_bytes()).expect("AES-GCM encryption");
    let tag = data.split_off(data.len() - 16);
    let sealed = Sealed { v: 1, salt: B64.encode(salt), iv: B64.encode(iv), tag: B64.encode(tag), data: B64.encode(data) };
    serde_json::to_string(&sealed).expect("JSON")
}

pub fn is_sealed(v: &Value) -> bool {
    v.get("v").and_then(Value::as_u64) == Some(1) && v.get("data").is_some_and(Value::is_string)
}

// Fails if the secret is wrong or the file was altered (GCM authentication).
pub fn unseal(sealed: &Value, secret: &str) -> Result<String, String> {
    let err = || "Cannot decrypt the connections file: wrong WEBGRIP_SECRET or altered file".to_string();
    let field = |k: &str| sealed.get(k).and_then(Value::as_str).and_then(|s| B64.decode(s).ok()).ok_or_else(err);
    let (salt, iv, tag, mut data) = (field("salt")?, field("iv")?, field("tag")?, field("data")?);
    if iv.len() != 12 {
        return Err(err());
    }
    data.extend_from_slice(&tag);
    let cipher = Aes256Gcm::new(&key_of(secret, &salt).into());
    let plain = cipher.decrypt(Nonce::from_slice(&iv), data.as_slice()).map_err(|_| err())?;
    String::from_utf8(plain).map_err(|_| err())
}
