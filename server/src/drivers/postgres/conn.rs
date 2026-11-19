// A small PostgreSQL client on the wire protocol (postgres-protocol), for what the usual Rust clients do not give:
// every value as the text PostgreSQL prints (its own DateStyle, arrays, ranges, intervals… exactly as psql shows them),
// portals read a few rows at a time (the row limit, "Load more"), the column origins (table oid, column number) for
// cell editing, notices, the transaction status and the backend pid (to cancel a query).

use crate::error::{Error, Result};
use bytes::BytesMut;
use fallible_iterator::FallibleIterator;
use postgres_protocol::authentication::sasl::{ChannelBinding, ScramSha256};
use postgres_protocol::message::backend::{ErrorFields, Message};
use postgres_protocol::message::frontend;
use postgres_protocol::IsNull;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

pub type Row = Vec<Option<String>>;

#[derive(Clone, Debug)]
pub struct Field {
    pub name: String,
    pub table_oid: u32,
    pub column_id: i16,
    pub type_oid: u32,
}

// What one statement returned
#[derive(Debug, Default)]
pub struct QueryResult {
    // None: the statement returns no rows (NoData)
    pub fields: Option<Vec<Field>>,
    pub rows: Vec<Row>,
    // the command tag ("SELECT 3", "UPDATE 1", "CREATE TABLE"), None if there was none
    pub tag: Option<String>,
}

impl QueryResult {
    // The tag's command word and row count, read the way node-postgres did
    pub fn command(&self) -> (Option<String>, Option<u64>) {
        let Some(tag) = self.tag.as_deref() else { return (None, None) };
        let mut words = tag.split(' ');
        let command = words.next().filter(|w| !w.is_empty() && w.bytes().all(|c| c.is_ascii_alphabetic()));
        let numbers: Vec<u64> = tag.split(' ').skip(1).take(2).map_while(|w| w.parse().ok()).collect();
        (command.map(str::to_string), numbers.last().copied())
    }
}

pub struct Config {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub database: String,
    pub ssl: bool,
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send + Sync {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + Sync> Stream for T {}

pub struct PgConn {
    stream: Box<dyn Stream>,
    rbuf: BytesMut,
    wbuf: BytesMut,
    pub pid: i32,
    // 'I' idle, 'T' in a transaction, 'E' in a failed transaction
    pub tx_status: u8,
    pub notices: Vec<String>,
    // the connection cannot be used anymore
    pub broken: bool,
    // an exchange was started and its ReadyForQuery not read yet: if the next one starts first, the previous was
    // interrupted halfway (its future dropped) and the connection is out of step
    pending: bool,
    // the search_path set by the editor session
    pub schema: Option<String>,
}

fn db_error(fields: ErrorFields<'_>) -> Error {
    let mut e = Error::default();
    let mut fields = fields;
    while let Ok(Some(f)) = fields.next() {
        let v = String::from_utf8_lossy(f.value_bytes()).into_owned();
        match f.type_() {
            b'M' => e.message = v,
            b'D' => e.detail = Some(v),
            b'H' => e.hint = Some(v),
            b'C' => e.code = Some(v),
            b'P' => e.position = v.parse().ok(),
            _ => {}
        }
    }
    e
}

fn notice_text(fields: ErrorFields<'_>) -> String {
    let (mut severity, mut message) = (String::new(), String::new());
    let mut fields = fields;
    while let Ok(Some(f)) = fields.next() {
        match f.type_() {
            b'S' => severity = String::from_utf8_lossy(f.value_bytes()).into_owned(),
            b'M' => message = String::from_utf8_lossy(f.value_bytes()).into_owned(),
            _ => {}
        }
    }
    format!("{severity}: {message}")
}

fn proto(msg: &str) -> Error {
    Error::fatal(format!("PostgreSQL protocol error: {msg}"))
}

// TLS without certificate checks, as the first version did (rejectUnauthorized: false)
#[derive(Debug)]
struct AcceptAll(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AcceptAll {
    fn verify_server_cert(
        &self,
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> std::result::Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

static TLS: LazyLock<Arc<rustls::ClientConfig>> = LazyLock::new(|| {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("TLS versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAll(provider)))
        .with_no_client_auth();
    Arc::new(config)
});

impl PgConn {
    pub async fn connect(cfg: &Config) -> Result<PgConn> {
        match tokio::time::timeout(Duration::from_secs(10), Self::connect_inner(cfg)).await {
            Ok(r) => r,
            Err(_) => Err(Error::fatal("Connection terminated due to connection timeout")),
        }
    }

    async fn connect_inner(cfg: &Config) -> Result<PgConn> {
        let tcp = TcpStream::connect((cfg.host.as_str(), cfg.port)).await?;
        let _ = tcp.set_nodelay(true);
        let stream: Box<dyn Stream> = if cfg.ssl {
            let mut tcp = tcp;
            let mut b = BytesMut::new();
            frontend::ssl_request(&mut b);
            tcp.write_all(&b).await?;
            let mut answer = [0u8; 1];
            tcp.read_exact(&mut answer).await?;
            if answer[0] != b'S' {
                return Err(Error::fatal("The server does not support SSL connections"));
            }
            let name = rustls::pki_types::ServerName::try_from(cfg.host.clone())
                .unwrap_or_else(|_| rustls::pki_types::ServerName::try_from("localhost").unwrap());
            let tls = tokio_rustls::TlsConnector::from(TLS.clone()).connect(name, tcp).await?;
            Box::new(tls)
        } else {
            Box::new(tcp)
        };
        let mut c = PgConn {
            stream,
            rbuf: BytesMut::with_capacity(16 * 1024),
            wbuf: BytesMut::new(),
            pid: 0,
            tx_status: b'I',
            notices: Vec::new(),
            broken: false,
            pending: false,
            schema: None,
        };
        let params = [
            ("user", cfg.user.as_str()),
            ("database", cfg.database.as_str()),
            ("application_name", "webgrip"),
            ("client_encoding", "UTF8"),
        ];
        frontend::startup_message(params.iter().copied(), &mut c.wbuf)?;
        c.flush().await?;
        c.authenticate(cfg).await?;
        // until ReadyForQuery: BackendKeyData, ParameterStatus…
        loop {
            match c.read().await? {
                Message::BackendKeyData(k) => c.pid = k.process_id(),
                Message::ReadyForQuery(r) => {
                    c.tx_status = r.status();
                    return Ok(c);
                }
                Message::ErrorResponse(e) => return Err(Error { fatal: true, ..db_error(e.fields()) }),
                _ => {}
            }
        }
    }

    async fn authenticate(&mut self, cfg: &Config) -> Result<()> {
        let password =
            || cfg.password.as_deref().ok_or_else(|| Error::fatal("The server asks for a password, and the connection has none"));
        loop {
            match self.read().await? {
                Message::AuthenticationOk => return Ok(()),
                Message::AuthenticationCleartextPassword => {
                    frontend::password_message(password()?.as_bytes(), &mut self.wbuf)?;
                    self.flush().await?;
                }
                Message::AuthenticationMd5Password(b) => {
                    let hash = postgres_protocol::authentication::md5_hash(cfg.user.as_bytes(), password()?.as_bytes(), b.salt());
                    frontend::password_message(hash.as_bytes(), &mut self.wbuf)?;
                    self.flush().await?;
                }
                Message::AuthenticationSasl(b) => {
                    let mut mechanisms = b.mechanisms();
                    let mut scram = false;
                    while let Some(m) = mechanisms.next().map_err(|e| proto(&e.to_string()))? {
                        scram |= m == "SCRAM-SHA-256";
                    }
                    if !scram {
                        return Err(Error::fatal("The server asks for an unsupported SASL mechanism"));
                    }
                    let mut s = ScramSha256::new(password()?.as_bytes(), ChannelBinding::unsupported());
                    frontend::sasl_initial_response("SCRAM-SHA-256", s.message(), &mut self.wbuf)?;
                    self.flush().await?;
                    match self.read().await? {
                        Message::AuthenticationSaslContinue(b) => s.update(b.data())?,
                        Message::ErrorResponse(e) => return Err(Error { fatal: true, ..db_error(e.fields()) }),
                        _ => return Err(proto("unexpected SASL message")),
                    }
                    frontend::sasl_response(s.message(), &mut self.wbuf)?;
                    self.flush().await?;
                    match self.read().await? {
                        Message::AuthenticationSaslFinal(b) => s.finish(b.data())?,
                        Message::ErrorResponse(e) => return Err(Error { fatal: true, ..db_error(e.fields()) }),
                        _ => return Err(proto("unexpected SASL message")),
                    }
                }
                Message::ErrorResponse(e) => return Err(Error { fatal: true, ..db_error(e.fields()) }),
                _ => return Err(Error::fatal("Unsupported authentication method (GSS, SSPI…)")),
            }
        }
    }

    async fn flush(&mut self) -> Result<()> {
        let r = async {
            self.stream.write_all(&self.wbuf).await?;
            self.stream.flush().await
        }
        .await;
        self.wbuf.clear();
        r.map_err(|e| {
            self.broken = true;
            Error::from(e)
        })
    }

    // The next message, notices kept aside and asynchronous messages skipped
    async fn read(&mut self) -> Result<Message> {
        loop {
            let parsed = Message::parse(&mut self.rbuf).map_err(|e| {
                self.broken = true;
                proto(&e.to_string())
            })?;
            match parsed {
                Some(Message::NoticeResponse(n)) => self.notices.push(notice_text(n.fields())),
                Some(Message::ParameterStatus(_)) | Some(Message::NotificationResponse(_)) => {}
                Some(m) => {
                    if matches!(m, Message::ReadyForQuery(_)) {
                        self.pending = false;
                    }
                    return Ok(m);
                }
                None => {
                    self.rbuf.reserve(8192);
                    let n = self.stream.read_buf(&mut self.rbuf).await.map_err(|e| {
                        self.broken = true;
                        Error::from(e)
                    })?;
                    if n == 0 {
                        self.broken = true;
                        return Err(Error::fatal("Connection terminated unexpectedly"));
                    }
                }
            }
        }
    }

    fn begin(&mut self) -> Result<()> {
        if self.broken || self.pending {
            self.broken = true;
            return Err(Error::fatal("The connection was interrupted, try again"));
        }
        self.pending = true;
        Ok(())
    }

    // Reads up to ReadyForQuery (after an error, or to finish an extended-protocol exchange)
    async fn ready(&mut self) -> Result<()> {
        loop {
            if let Message::ReadyForQuery(r) = self.read().await? {
                self.tx_status = r.status();
                return Ok(());
            }
        }
    }

    fn row(body: &postgres_protocol::message::backend::DataRowBody) -> Result<Row> {
        let buf = body.buffer();
        let mut ranges = body.ranges();
        let mut row = Vec::new();
        while let Some(r) = ranges.next().map_err(|e| proto(&e.to_string()))? {
            row.push(r.map(|r| String::from_utf8_lossy(&buf[r]).into_owned()));
        }
        Ok(row)
    }

    fn fields(body: &postgres_protocol::message::backend::RowDescriptionBody) -> Result<Vec<Field>> {
        let mut out = Vec::new();
        let mut fields = body.fields();
        while let Some(f) = fields.next().map_err(|e| proto(&e.to_string()))? {
            out.push(Field { name: f.name().to_string(), table_oid: f.table_oid(), column_id: f.column_id(), type_oid: f.type_oid() });
        }
        Ok(out)
    }

    // Simple query protocol: every result of `sql` (for commands, and statements read without a row limit)
    pub async fn simple(&mut self, sql: &str) -> Result<Vec<QueryResult>> {
        self.begin()?;
        frontend::query(sql, &mut self.wbuf)?;
        self.flush().await?;
        let mut results = Vec::new();
        let mut current = QueryResult::default();
        let mut error = None;
        loop {
            match self.read().await? {
                Message::RowDescription(b) => current.fields = Some(Self::fields(&b)?),
                Message::DataRow(b) => current.rows.push(Self::row(&b)?),
                Message::CommandComplete(b) => {
                    current.tag = Some(b.tag().map_err(|e| proto(&e.to_string()))?.to_string());
                    results.push(std::mem::take(&mut current));
                }
                Message::EmptyQueryResponse => results.push(std::mem::take(&mut current)),
                Message::ErrorResponse(e) => error = Some(db_error(e.fields())),
                Message::ReadyForQuery(r) => {
                    self.tx_status = r.status();
                    return match error {
                        Some(e) => Err(e),
                        None => Ok(results),
                    };
                }
                Message::CopyInResponse(_) => {
                    frontend::copy_fail("COPY FROM STDIN is not supported", &mut self.wbuf)?;
                    self.flush().await?;
                }
                _ => {}
            }
        }
    }

    // A command whose result does not matter
    pub async fn execute(&mut self, sql: &str) -> Result<()> {
        self.simple(sql).await.map(|_| ())
    }

    fn bind_params(&mut self, params: &[Option<String>]) -> Result<()> {
        frontend::bind(
            "",
            "",
            std::iter::empty(), // every parameter as text
            params.iter(),
            |p: &Option<String>, buf: &mut BytesMut| match p {
                Some(s) => {
                    buf.extend_from_slice(s.as_bytes());
                    Ok(IsNull::No)
                }
                None => Ok(IsNull::Yes),
            },
            std::iter::empty(), // every result column as text
            &mut self.wbuf,
        )
        .map_err(|_| Error::new("Cannot encode the query parameters"))
    }

    // Extended protocol, with text parameters ($1, $2… their types inferred by the server): all the rows
    pub async fn query(&mut self, sql: &str, params: &[Option<String>]) -> Result<QueryResult> {
        self.begin()?;
        frontend::parse("", sql, std::iter::empty(), &mut self.wbuf)?;
        self.bind_params(params)?;
        frontend::describe(b'P', "", &mut self.wbuf)?;
        frontend::execute("", 0, &mut self.wbuf)?;
        frontend::sync(&mut self.wbuf);
        self.flush().await?;
        let mut result = QueryResult::default();
        let mut error = None;
        loop {
            match self.read().await? {
                Message::RowDescription(b) => result.fields = Some(Self::fields(&b)?),
                Message::DataRow(b) => result.rows.push(Self::row(&b)?),
                Message::CommandComplete(b) => result.tag = Some(b.tag().map_err(|e| proto(&e.to_string()))?.to_string()),
                Message::ErrorResponse(e) => error = Some(db_error(e.fields())),
                Message::ReadyForQuery(r) => {
                    self.tx_status = r.status();
                    return match error {
                        Some(e) => Err(e),
                        None => Ok(result),
                    };
                }
                _ => {}
            }
        }
    }

    // Opens `sql` as a portal (a cursor) and returns its columns; read it with `fetch`, then `close_portal`.
    pub async fn open_portal(&mut self, sql: &str) -> Result<Option<Vec<Field>>> {
        self.begin()?;
        frontend::parse("", sql, std::iter::empty(), &mut self.wbuf)?;
        self.bind_params(&[])?;
        frontend::describe(b'P', "", &mut self.wbuf)?;
        frontend::flush(&mut self.wbuf);
        self.flush().await?;
        loop {
            match self.read().await? {
                Message::ParseComplete | Message::BindComplete => {}
                Message::RowDescription(b) => return Ok(Some(Self::fields(&b)?)),
                Message::NoData => return Ok(None),
                Message::ErrorResponse(e) => {
                    let err = db_error(e.fields());
                    self.sync_after_error().await?;
                    return Err(err);
                }
                _ => return Err(proto("unexpected message opening a portal")),
            }
        }
    }

    // The next `n` rows of the portal (0: all), and its command tag when it is exhausted.
    // After an error the portal is closed and the connection ready again.
    pub async fn fetch(&mut self, n: i32, rows: &mut Vec<Row>) -> Result<Option<String>> {
        frontend::execute("", n, &mut self.wbuf)?;
        frontend::flush(&mut self.wbuf);
        self.flush().await?;
        loop {
            match self.read().await? {
                Message::DataRow(b) => rows.push(Self::row(&b)?),
                Message::PortalSuspended => return Ok(None),
                Message::CommandComplete(b) => return Ok(Some(b.tag().map_err(|e| proto(&e.to_string()))?.to_string())),
                Message::EmptyQueryResponse => return Ok(Some(String::new())),
                Message::ErrorResponse(e) => {
                    let err = db_error(e.fields());
                    self.sync_after_error().await?;
                    return Err(err);
                }
                Message::CopyInResponse(_) | Message::CopyOutResponse(_) => {
                    // COPY through a portal: give up on it
                    self.sync_after_error().await?;
                    return Err(Error::new("COPY is not supported"));
                }
                _ => {}
            }
        }
    }

    async fn sync_after_error(&mut self) -> Result<()> {
        frontend::sync(&mut self.wbuf);
        self.flush().await?;
        self.ready().await
    }

    pub async fn close_portal(&mut self) -> Result<()> {
        frontend::close(b'P', "", &mut self.wbuf)?;
        frontend::sync(&mut self.wbuf);
        self.flush().await?;
        self.ready().await
    }

    pub async fn terminate(mut self) {
        frontend::terminate(&mut self.wbuf);
        let _ = self.flush().await;
        let _ = self.stream.shutdown().await;
    }
}
