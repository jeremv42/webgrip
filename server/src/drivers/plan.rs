// Helpers shared by the drivers' EXPLAIN parsers (postgres/plan.rs, mariadb/plan.rs)

use crate::js;
use crate::types::PlanNode;
use serde_json::{Map, Value};

pub type Json = Map<String, Value>;

pub fn obj(v: Option<&Value>) -> Option<&Json> {
    v.and_then(Value::as_object)
}

// A finite number, from a number or a numeric string
pub fn num(v: Option<&Value>) -> Option<f64> {
    let n = match v? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) if !js::trim(s).is_empty() => js::parse_num(s),
        _ => return None,
    };
    n.is_finite().then_some(n)
}

// A scalar as text (yes / no for booleans); None for null, objects and arrays
pub fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::Null | Value::Object(_) | Value::Array(_) => None,
        Value::Bool(b) => Some(if *b { "yes" } else { "no" }.into()),
        v => Some(js::template(Some(v))),
    }
}

pub use crate::js::round3 as round;

// Exclusive values for engines that report inclusive ones: the node minus its children, never negative
pub fn fill_self(n: &mut PlanNode) {
    for c in &mut n.children {
        fill_self(c);
    }
    if let Some(time) = n.time {
        let sum: f64 = n.children.iter().map(|c| c.time.unwrap_or(0.0)).sum();
        n.self_time = Some(round((time - sum).max(0.0)));
    }
    if let Some(cost) = n.cost {
        if n.self_cost.is_none() {
            let sum: f64 = n.children.iter().map(|c| c.cost.unwrap_or(0.0)).sum();
            n.self_cost = Some(round((cost - sum).max(0.0)));
        }
    }
}

// String(cell) of a result cell, as the parsers read it
pub fn cell_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        v => js::template(Some(v)),
    }
}
