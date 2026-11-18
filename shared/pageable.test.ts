import { describe, expect, it } from 'vitest'
import { isPageable } from './pageable.ts'

describe('isPageable', () => {
  it('accepts read-only statements, after leading comments', () => {
    for (const sql of [
      'select * from t',
      '  -- list\n/* all */ SELECT 1',
      'with x as (select 1) select * from x',
      'values (1)',
      'table t',
      'show tables',
      "select updated_at, deleted from t where note = 'x'",
    ])
      expect([sql, isPageable(sql)]).toEqual([sql, true])
  })
  it('refuses statements that are not harmless to run again', () => {
    for (const sql of [
      'update t set a = 1 returning *',
      'insert into t select 1',
      'with d as (delete from t returning *) select * from d',
      'select * into t2 from t',
      'select * from t for update',
      'select * from t for no key update',
      'select * from t lock in share mode',
      "select nextval('s')",
      'explain select 1',
      'call p()',
    ])
      expect([sql, isPageable(sql)]).toEqual([sql, false])
  })
})
