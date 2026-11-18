// Whether a statement only reads, so that it can be run again to fetch the rows after the row limit.
// Used by the server (to refuse anything else) and by the grid (to offer "Load more").

const LEADING_COMMENTS = /^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/

// The statement without the comments and spaces before its first keyword
export const stripLeadingComments = (sql: string) => sql.replace(LEADING_COMMENTS, '')

export function isPageable(sql: string) {
  const s = stripLeadingComments(sql)
  if (!/^(select|with|values|table|show)\b/i.test(s)) return false
  // data-modifying CTEs, SELECT … INTO, locking reads, sequences: running them again is not harmless (strings and
  // comments are not told apart: a false alarm only hides the button)
  return !/\b(insert|update|delete|merge|into|for\s+(?:no\s+key\s+)?(?:update|share)|lock\s+in\s+share|nextval|setval)\b/i.test(s)
}
