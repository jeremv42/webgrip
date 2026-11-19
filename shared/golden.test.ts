// The editor (these TS functions) and the server (their Rust copies in server/src/sql.rs) must split statements and
// tell read-only ones the same way: both are checked against the same golden files.
import { describe, expect, it } from 'vitest'
import split from '../server/tests/golden/split.json' with { type: 'json' }
import pageable from '../server/tests/golden/pageable.json' with { type: 'json' }
import { splitSql } from './splitSql.ts'
import { isPageable, stripLeadingComments } from './pageable.ts'
import type { Dialect } from './types.ts'

describe('shared SQL helpers, as the server sees them', () => {
  it('split scripts like server/src/sql.rs', () => {
    for (const c of split) expect({ ...c, out: splitSql(c.text, c.dialect as Dialect) }).toEqual(c)
  })

  it('tell pageable statements like server/src/sql.rs', () => {
    for (const c of pageable) expect({ sql: c.sql, pageable: isPageable(c.sql), stripped: stripLeadingComments(c.sql) }).toEqual(c)
  })
})
