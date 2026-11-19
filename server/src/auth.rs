// A single shared password. A successful login sets a signed cookie (expiry + HMAC): no server-side session,
// so it survives API restarts; changing the password or the secret invalidates every cookie.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;

pub const COOKIE: &str = "webgrip_session";
const MAX_AGE: u64 = 30 * 24 * 3600; // seconds
const MAX_FAILURES: usize = 10; // per minute, all clients together

type HmacSha256 = Hmac<Sha256>;

pub fn cookie_value(header: Option<&str>, name: &str) -> Option<String> {
    for part in header.unwrap_or("").split(';') {
        if let Some((k, v)) = part.split_once('=') {
            if !k.is_empty() && k.trim() == name {
                return Some(percent_decode(v.trim()));
            }
        }
    }
    None
}

// decodeURIComponent, keeping malformed sequences as they are
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() {
            let hex = |c: u8| (c as char).to_digit(16).unwrap() as u8;
            out.push(hex(b[i + 1]) * 16 + hex(b[i + 2]));
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

pub fn set_cookie(value: &str, max_age: u64) -> String {
    format!("{COOKIE}={value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age={max_age}")
}

pub enum Attempt {
    Ok(String),
    TooMany,
    Wrong,
}

pub struct Auth {
    key: Vec<u8>,
    password_hash: [u8; 32],
    failures: Mutex<Vec<Instant>>,
    now: Box<dyn Fn() -> u64 + Send + Sync>, // ms since the epoch
}

impl Auth {
    pub fn new(password: &str, secret: &str) -> Self {
        Self::with_clock(password, secret, Box::new(|| SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64))
    }

    pub fn with_clock(password: &str, secret: &str, now: Box<dyn Fn() -> u64 + Send + Sync>) -> Self {
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC key");
        mac.update(format!("webgrip-session\0{password}").as_bytes());
        Auth {
            key: mac.finalize().into_bytes().to_vec(),
            password_hash: Sha256::digest(password.as_bytes()).into(),
            failures: Mutex::new(Vec::new()),
            now,
        }
    }

    fn sign(&self, exp: u64) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC key");
        mac.update(exp.to_string().as_bytes());
        B64URL.encode(mac.finalize().into_bytes())
    }

    pub fn token(&self) -> String {
        let exp = (self.now)() / 1000 + MAX_AGE;
        format!("{exp}.{}", self.sign(exp))
    }

    pub fn valid(&self, value: Option<&str>) -> bool {
        let Some((exp, mac)) = value.and_then(|v| v.split_once('.')) else { return false };
        let Ok(exp_n) = exp.parse::<u64>() else { return false };
        if mac.is_empty() || exp_n.saturating_mul(1000) < (self.now)() {
            return false;
        }
        let expected = self.sign(exp_n);
        // the signature is checked against the number as written, like the first version did (Number(exp))
        exp_n.to_string() == exp && bool::from(expected.as_bytes().ct_eq(mac.as_bytes()))
    }

    pub fn check(&self, given: &str) -> bool {
        let h: [u8; 32] = Sha256::digest(given.as_bytes()).into();
        bool::from(h.ct_eq(&self.password_hash))
    }

    // Sets the session cookie when `given` is the password; failures are slowed down and limited.
    pub async fn attempt(&self, given: Option<&str>) -> Attempt {
        {
            let mut f = self.failures.lock().unwrap();
            let minute_ago = Instant::now().checked_sub(Duration::from_secs(60));
            f.retain(|t| minute_ago.is_none_or(|m| *t > m));
            if f.len() >= MAX_FAILURES {
                return Attempt::TooMany;
            }
        }
        if given.is_some_and(|g| self.check(g)) {
            return Attempt::Ok(set_cookie(&self.token(), MAX_AGE));
        }
        self.failures.lock().unwrap().push(Instant::now());
        tokio::time::sleep(Duration::from_millis(500)).await; // slows down guessing
        Attempt::Wrong
    }

    pub fn session_ok(&self, cookie_header: Option<&str>) -> bool {
        self.valid(cookie_value(cookie_header, COOKIE).as_deref())
    }
}

pub fn logout_cookie() -> String {
    set_cookie("", 0)
}
