// JavaScript semantics the API keeps from its first (TypeScript) version: number formatting and parsing,
// UTF-16 lengths, String() of JSON values, whitespace.

use serde_json::Value;

// String(n) for a JS number
pub fn num_str(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if n == 0.0 {
        return "0".into();
    }
    let abs = n.abs();
    if (1e-6..1e21).contains(&abs) {
        if n.fract() == 0.0 {
            return format!("{}", n as i128);
        }
        // Rust prints the shortest round-trip digits, like JS, in plain notation in this range
        return format!("{n}");
    }
    // exponent notation: JS writes 1e+21, 1.5e-7
    let s = format!("{n:e}");
    match s.split_once('e') {
        Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
        _ => s,
    }
}

// String(v) for a JSON value, as a template literal prints it
pub fn template(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => num_str(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => join(a, ","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

// Array.prototype.join: null and undefined items are empty
pub fn join(a: &[Value], sep: &str) -> String {
    a.iter()
        .map(|v| match v {
            Value::Null => String::new(),
            v => template(Some(v)),
        })
        .collect::<Vec<_>>()
        .join(sep)
}

// Truthiness of a JSON value
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

// Number(s) for a string: NaN when it is not a number
pub fn parse_num(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'-' => (-1.0, &t[1..]),
        b'+' => (1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    let radix = |p: &str, r| {
        if t.len() != body.len() {
            return f64::NAN; // no sign before 0x
        }
        u64::from_str_radix(p, r).map(|n| n as f64).unwrap_or(f64::NAN)
    };
    if let Some(h) = body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")) {
        return radix(h, 16);
    }
    if let Some(o) = body.strip_prefix("0o").or_else(|| body.strip_prefix("0O")) {
        return radix(o, 8);
    }
    if let Some(b) = body.strip_prefix("0b").or_else(|| body.strip_prefix("0B")) {
        return radix(b, 2);
    }
    // Rust also accepts "inf" / "nan": JS does not
    if body.bytes().any(|c| !(c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-'))) {
        return f64::NAN;
    }
    body.parse::<f64>().map(|n| sign * n).unwrap_or(f64::NAN)
}

// Number(v) for a JSON value
pub fn to_num(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => parse_num(s),
        Some(Value::Array(a)) => match a.as_slice() {
            [] => 0.0,
            [x] if !x.is_array() && !x.is_object() => to_num(Some(x)),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

// `Number(v) || fallback`
pub fn num_or(v: Option<&Value>, fallback: f64) -> f64 {
    let n = to_num(v);
    if n == 0.0 || n.is_nan() {
        fallback
    } else {
        n
    }
}

// The JS whitespace set (String.prototype.trim, \s)
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

// Length in UTF-16 code units (String.prototype.length)
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

// The first `n` UTF-16 code units of `s` (never splitting a character)
pub fn take16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

// Math.round(n * 1000) / 1000
pub fn round3(n: f64) -> f64 {
    (n * 1000.0 + 0.5).floor() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_numbers_like_js() {
        for (n, s) in [
            (1.0, "1"),
            (0.1, "0.1"),
            (-2.5, "-2.5"),
            (1e21, "1e+21"),
            (1.5e-7, "1.5e-7"),
            (123456789.125, "123456789.125"),
            (2511.63, "2511.63"),
        ] {
            assert_eq!(num_str(n), s);
        }
    }

    #[test]
    fn parses_numbers_like_js() {
        assert_eq!(parse_num(" 12 "), 12.0);
        assert_eq!(parse_num("0x1A"), 26.0);
        assert_eq!(parse_num("1e+3"), 1000.0);
        assert!(parse_num("inf").is_nan());
        assert!(parse_num("1.2.3").is_nan());
        assert_eq!(parse_num(""), 0.0);
    }

    #[test]
    fn counts_utf16() {
        assert_eq!(len16("é😀"), 3);
        assert_eq!(take16("a😀b", 2), "a");
        assert_eq!(take16("a😀b", 3), "a😀");
    }
}
