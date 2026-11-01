import { describe, expect, it } from 'vitest'
import { splitSql } from './splitSql.ts'

const sqls = (text: string, dialect?: 'postgres' | 'mariadb') => splitSql(text, dialect).map((s) => s.sql)

describe('splitSql', () => {
  it('splits on semicolons and trims each statement', () => {
    expect(sqls('select 1;  select 2 ;\nselect 3')).toEqual(['select 1', 'select 2', 'select 3'])
  })

  it('returns offsets of the trimmed statement in the input', () => {
    const text = '  select 1;\n\n  update t set a = 1  ;'
    for (const st of splitSql(text)) expect(text.slice(st.start, st.end)).toBe(st.sql)
    expect(splitSql(text).map(({ start, end }) => [start, end])).toEqual([
      [2, 10],
      [15, 33],
    ])
  })

  it('drops empty statements and comment-only chunks', () => {
    expect(sqls(';;  ; -- nothing\n; /* nor here */ ;')).toEqual([])
    expect(splitSql('')).toEqual([])
  })

  it('ignores semicolons inside quotes, identifiers and comments', () => {
    expect(sqls(`select 'a;b', "c;d" -- e;f\nfrom t /* g;h */ where x = 'it''s;'; select 2`)).toEqual([
      `select 'a;b', "c;d" -- e;f\nfrom t /* g;h */ where x = 'it''s;'`,
      'select 2',
    ])
  })

  it('keeps PostgreSQL dollar-quoted bodies whole', () => {
    const fn = `create function f() returns int as $body$ begin; return 1; end $body$ language plpgsql`
    expect(sqls(`${fn}; do $$ begin; end $$; select 1`)).toEqual([fn, 'do $$ begin; end $$', 'select 1'])
  })

  it('does not take a $n parameter or an identifier$ for a dollar quote', () => {
    expect(sqls('select $1; select a$b$ from t; select 2')).toEqual(['select $1', 'select a$b$ from t', 'select 2'])
  })

  it('handles MariaDB backticks, # comments and backslash escapes', () => {
    expect(sqls("select `a;b` # c;d\nfrom t; select 'x\\';y'; select 3", 'mariadb')).toEqual([
      'select `a;b` # c;d\nfrom t',
      "select 'x\\';y'",
      'select 3',
    ])
  })

  it('treats # and backslashes literally in PostgreSQL', () => {
    expect(sqls("select 'a\\'; select 1 # 2; select 3")).toEqual(["select 'a\\'", 'select 1 # 2', 'select 3'])
  })

  it('runs to the end on an unterminated quote or comment', () => {
    expect(sqls("select 'oops; select 2")).toEqual(["select 'oops; select 2"])
    expect(sqls('select 1 /* open; select 2')).toEqual(['select 1 /* open; select 2'])
  })
})
