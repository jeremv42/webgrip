// SQL text helpers, the Rust side of shared/splitSql.ts and shared/pageable.ts (the editor uses those: keep them in sync).

use crate::js;
use crate::types::{Dialect, Statement};
use regex::Regex;
use std::sync::LazyLock;

// Splits a SQL script into statements, aware of quotes, comments and PostgreSQL dollar-quoting.
// Offsets are UTF-16 code units into the input, as the editor counts them.
pub fn split_sql(text: &str, dialect: Dialect) -> Vec<Statement> {
    let my = dialect == Dialect::Mariadb;
    let t: Vec<u16> = text.encode_utf16().collect();
    let n = t.len();
    let at = |i: usize| t.get(i).copied().unwrap_or(0);
    let is = |i: usize, c: char| at(i) == c as u16;
    let mut out = Vec::new();
    let mut start = 0;
    let mut i = 0;

    let push = |out: &mut Vec<Statement>, start: usize, end: usize| {
        let raw = String::from_utf16_lossy(&t[start..end]);
        if !js::trim(&strip_comments(&raw, my)).is_empty() {
            let trimmed_start = raw.trim_start_matches(js::is_space);
            let lead = js::len16(&raw) - js::len16(trimmed_start);
            let trimmed_end = raw.trim_end_matches(js::is_space);
            out.push(Statement { sql: js::trim(&raw).to_string(), start: start + lead, end: start + js::len16(trimmed_end) });
        }
    };

    while i < n {
        if is(i, '-') && is(i + 1, '-') || my && is(i, '#') {
            i = skip_line(&t, i);
        } else if is(i, '/') && is(i + 1, '*') {
            i = find(&t, &[b'*' as u16, b'/' as u16], i + 2).map_or(n, |e| e + 2);
        } else if is(i, '\'') || is(i, '"') || my && is(i, '`') {
            i = skip_quoted(&t, i, at(i), my && !is(i, '`'));
        } else if !my && is(i, '$') {
            let tag = dollar_tag(&t, i);
            let word_before = i > 0 && is_word(at(i - 1));
            match tag {
                Some(len) if !word_before => {
                    let tag = &t[i..i + len];
                    i = find(&t, tag, i + len).map_or(n, |e| e + len);
                }
                _ => i += 1,
            }
        } else if is(i, ';') {
            push(&mut out, start, i);
            i += 1;
            start = i;
        } else {
            i += 1;
        }
    }
    push(&mut out, start, n);
    out
}

fn is_word(c: u16) -> bool {
    c < 128 && (c as u8).is_ascii_alphanumeric() || c == b'_' as u16
}

// Length of a $tag$ (or $$) starting at i, within the next 64 units
fn dollar_tag(t: &[u16], i: usize) -> Option<usize> {
    let end = (i + 64).min(t.len());
    let mut j = i + 1;
    if j < end && t[j] != b'$' as u16 {
        let first = t[j];
        if !(first < 128 && ((first as u8).is_ascii_alphabetic() || first == b'_' as u16)) {
            return None;
        }
        while j < end && is_word(t[j]) {
            j += 1;
        }
    }
    (j < end && t[j] == b'$' as u16).then(|| j + 1 - i)
}

fn find(t: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if from > t.len() || needle.is_empty() {
        return None;
    }
    t[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

fn skip_line(t: &[u16], i: usize) -> usize {
    find(t, &[b'\n' as u16], i).map_or(t.len(), |e| e + 1)
}

fn skip_quoted(t: &[u16], mut i: usize, q: u16, backslash: bool) -> usize {
    i += 1;
    while i < t.len() {
        let c = t[i];
        if backslash && c == b'\\' as u16 {
            i += 2;
            continue;
        }
        if c == q {
            if t.get(i + 1) == Some(&q) {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    i
}

static BLOCK_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)/\*.*?(\*/|$)").unwrap());
static LINE_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"--[^\n]*").unwrap());
static MY_LINE_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(--|#)[^\n]*").unwrap());

fn strip_comments(s: &str, my: bool) -> String {
    let s = BLOCK_COMMENT.replace_all(s, "");
    (if my { &MY_LINE_COMMENT } else { &LINE_COMMENT }).replace_all(&s, "").into_owned()
}

static LEADING_COMMENTS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|(?s:/\*.*?\*/))*").unwrap());
static PAGEABLE_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(select|with|values|table|show)(?-u:\b)").unwrap());
static NOT_PAGEABLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?-u:\b)(insert|update|delete|merge|into|for\s+(?:no\s+key\s+)?(?:update|share)|lock\s+in\s+share|nextval|setval)(?-u:\b)",
    )
    .unwrap()
});

// The statement without the comments and spaces before its first keyword
pub fn strip_leading_comments(sql: &str) -> &str {
    let m = LEADING_COMMENTS.find(sql).map_or(0, |m| m.end());
    &sql[m..]
}

// Whether a statement only reads, so that it can be run again to fetch the rows after the row limit
pub fn is_pageable(sql: &str) -> bool {
    let s = strip_leading_comments(sql);
    // data-modifying CTEs, SELECT … INTO, locking reads, sequences: running them again is not harmless
    PAGEABLE_START.is_match(s) && !NOT_PAGEABLE.is_match(s)
}

static READ_STATEMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(select|with|values|table|show|explain|describe|desc)(?-u:\b)").unwrap());
static INTO_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)into\s+(outfile|dumpfile)(?-u:\b)").unwrap());

// The single read-only statement of `sql` (for the chat), or an error. The read-only transaction is the real guard; this
// also refuses what it does not cover: DDL (MySQL commits the transaction before it), several statements, files.
pub fn read_only_statement(sql: &str, dialect: Dialect) -> Result<String, String> {
    let statements = split_sql(sql, dialect);
    let [statement] = statements.as_slice() else {
        return Err("Send exactly one statement".into());
    };
    let s = strip_leading_comments(&statement.sql);
    if !READ_STATEMENT.is_match(s) {
        return Err("Only read-only statements are allowed (SELECT, WITH, VALUES, TABLE, SHOW, EXPLAIN, DESCRIBE)".into());
    }
    if INTO_FILE.is_match(s) {
        return Err("INTO OUTFILE / DUMPFILE is not allowed".into());
    }
    Ok(statement.sql.clone())
}
