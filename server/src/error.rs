use std::fmt;

// Any failure: a database error (with what PostgreSQL adds to it), a refused request, or an I/O error.
// `status` is the HTTP status of a route that fails with it (400 when unset).
#[derive(Debug, Clone, Default)]
pub struct Error {
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    pub code: Option<String>,
    // 1-based character position in the statement (PostgreSQL)
    pub position: Option<i64>,
    pub status: Option<u16>,
    // the connection is unusable afterwards (I/O error, protocol error)
    pub fatal: bool,
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Error { message: message.into(), ..Default::default() }
    }
    pub fn status(message: impl Into<String>, status: u16) -> Self {
        Error { message: message.into(), status: Some(status), ..Default::default() }
    }
    pub fn fatal(message: impl Into<String>) -> Self {
        Error { message: message.into(), fatal: true, ..Default::default() }
    }
    // The error with what PostgreSQL adds to it, for the chat's tools
    pub fn full_text(&self) -> String {
        let mut parts = vec![self.message.clone()];
        if let Some(d) = self.detail.as_deref().filter(|d| !d.is_empty()) {
            parts.push(format!("Detail: {d}"));
        }
        if let Some(h) = self.hint.as_deref().filter(|h| !h.is_empty()) {
            parts.push(format!("Hint: {h}"));
        }
        parts.join("\n")
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::fatal(e.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::new(e.to_string())
    }
}
