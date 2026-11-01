<template>
  <div ref="host" class="sql-editor" />
</template>

<script>
// Monaco is loaded à la carte: editor core + all editor features. The SQL languages come from monaco-sql-languages
// (dt-sql-parser: real PostgreSQL / MySQL grammars) for highlighting, syntax errors and context-aware completion.
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/features/register.all'
import 'monaco-sql-languages/format'
// deep imports: the package index also loads the statement splitter, i.e. the grammars of every SQL dialect
import { setupLanguageFeatures } from 'monaco-sql-languages/esm/setupLanguageFeatures.js'
import { LanguageIdEnum } from 'monaco-sql-languages/esm/common/constants.js'
import { EntityContextType } from 'dt-sql-parser/dist/parser/common/types.js'
import 'monaco-sql-languages/esm/languages/pgsql/pgsql.contribution.js'
import 'monaco-sql-languages/esm/languages/mysql/mysql.contribution.js'
import { language as pgsqlLang } from 'monaco-sql-languages/esm/languages/pgsql/pgsql.js'
import { language as mysqlLang } from 'monaco-sql-languages/esm/languages/mysql/mysql.js'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import PgsqlWorker from '../sql/pgsql.worker.js?worker'
import MysqlWorker from '../sql/mysql.worker.js?worker'
import { quoteIdent } from '../api.js'
import { splitSql } from '../../../shared/splitSql.js'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

// monaco-sql-languages creates its workers with the pre-0.53 API ({ moduleId, label, createData }):
// give it a real Worker, and send the createData its entry point waits for.
const sqlWorkers = { [LanguageIdEnum.PG]: PgsqlWorker, [LanguageIdEnum.MYSQL]: MysqlWorker }
const createWebWorker = monaco.editor.createWebWorker
monaco.editor.createWebWorker = (opts) => {
  const SqlWorker = !opts.worker && sqlWorkers[opts.label]
  if (!SqlWorker) return createWebWorker(opts)
  const worker = new SqlWorker()
  worker.postMessage(opts.createData)
  return createWebWorker({ ...opts, worker })
}

const langId = (dialect) => (dialect === 'mariadb' ? LanguageIdEnum.MYSQL : LanguageIdEnum.PG)
// Keywords people type most, ranked first when the parser allows them
const frequent = ['FROM', 'WHERE', 'AS', 'AND', 'OR', 'ON', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT',
  'ASC', 'DESC', 'SET', 'VALUES', 'INTO', 'IN', 'IS', 'NOT', 'LIKE', 'BETWEEN', 'UNION', 'UNION ALL', 'RETURNING', 'NULLS', 'OFFSET']
  .reduce((m, k, i) => m.set(k, String(i).padStart(2, '0')), new Map())
const keywordSets = { [LanguageIdEnum.PG]: new Set(pgsqlLang.keywords), [LanguageIdEnum.MYSQL]: new Set(mysqlLang.keywords) }
// COUNT is missing from monaco-sql-languages' PostgreSQL function list
const builtinFunctions = { [LanguageIdEnum.PG]: ['COUNT', ...pgsqlLang.builtinFunctions], [LanguageIdEnum.MYSQL]: mysqlLang.builtinFunctions }

// Schema of each editor's model: { current, schemas, tables: [{ schema, name, kind, columns: [{ name, type, pk }] }], functions }
const schemas = new WeakMap()
const { CompletionItemKind: Kind } = monaco.languages

const unquote = (s) => s.replace(/^["`]|["`]$/g, '').replace(/""/g, '"').replace(/``/g, '`')
// an identifier, bare or quoted
const IDENT = String.raw`(?:[\w$]+|"(?:[^"]|"")+"|\`(?:[^\`]|\`\`)+\`)`
const insertColumns = new RegExp(String.raw`\binsert\s+into\s+(${IDENT}(?:\s*\.\s*${IDENT})?)\s*\(([^()]*)$`, 'i')
const dottedName = new RegExp(String.raw`(?:^|[^\w$"\`.])(${IDENT}(?:\.${IDENT})*)\.[\w$]*$`)
// "a.b.c" -> ['a', 'b', 'c'], quotes removed
const splitName = (s) => (s.match(/"(?:[^"]|"")*"|`(?:[^`]|``)*`|[^.\s]+/g) || []).map(unquote)

function makeIndex(info) {
  const byName = new Map() // lower(name) -> tables of every schema
  for (const t of info.tables || []) {
    const k = t.name.toLowerCase()
    byName.set(k, [...(byName.get(k) || []), t])
  }
  // [schema.]name -> table; without a schema, the current one wins (search_path / current database)
  const find = (parts) => {
    const [schema, name] = parts.length > 1 ? parts.slice(-2).map((p) => p.toLowerCase()) : [null, parts[0]?.toLowerCase()]
    const found = byName.get(name) || []
    if (schema) return found.find((t) => t.schema.toLowerCase() === schema)
    return found.find((t) => t.schema === info.current) || found[0]
  }
  return { find }
}

const isSource = (e) => [EntityContextType.TABLE, EntityContextType.VIEW].includes(e.entityContextType)

// Columns of a SELECT list (queryResult entity): aliases, "*" and "t.*" expanded from the tables it reads.
function queryColumns(qr, index) {
  const out = []
  for (const c of qr.columns || []) {
    const parts = splitName(c.text)
    if (parts.at(-1) === '*') {
      const q = parts.length > 1 ? parts.at(-2).toLowerCase() : null
      for (const src of (qr.relatedEntities || []).filter(isSource)) {
        const s = sourceOf(src, index)
        if (!q || s.name.toLowerCase() === q) out.push(...s.columns)
      }
    } else {
      const name = c._alias?.text ? unquote(c._alias.text) : parts.at(-1)
      if (name && /^[\w$"`]/.test(name)) out.push({ name, type: c._colType?.text || '' })
    }
  }
  return out
}

// Words that can follow a table name but are not an alias
const notAlias = /^(set|where|on|using|join|inner|left|right|full|cross|natural|order|group|limit|having|union|except|intersect|window|returning|values|select|default|for|lateral|offset|fetch|tablesample|partition|use|force|ignore|straight_join|as)$/i

// A FROM item: known table, or subquery (TableDeclareType.EXPRESSION = 1) whose columns come from its SELECT list.
// The parser misses some aliases (UPDATE t a SET ...): when it gives none, read the word after the table name.
function sourceOf(e, index, code = '') {
  let alias = e._alias?.text ? unquote(e._alias.text) : null
  if (!alias && e.declareType !== 1 && e.position) {
    const next = code.slice(e.position.endIndex + 1).match(/^\s+(?:as\s+)?([\w$]+|"(?:[^"]|"")+"|`(?:[^`]|``)+`)/i)?.[1]
    if (next && !notAlias.test(next)) alias = unquote(next)
  }
  if (e.declareType === 1) {
    const columns = (e.relatedEntities || []).filter((r) => r.entityContextType === EntityContextType.QUERY_RESULT).flatMap((r) => queryColumns(r, index))
    const cte = !e.text.trimStart().startsWith('(') ? unquote(e.text.trim()) : '' // WITH name AS (...)
    return { alias, name: alias || cte, table: null, columns }
  }
  const parts = splitName(e.text)
  const table = index.find(parts)
  return { alias, name: alias || parts.at(-1) || '', table, columns: table?.columns || [] }
}

const tableRefs = new RegExp(String.raw`\b(?:from|join|update|into)\s+(${IDENT}(?:\s*\.\s*${IDENT})?)(?:\s+(?:as\s+)?(${IDENT}))?`, 'gi')

// Fallback when the parser finds no table at all in the statement (e.g. MySQL UPDATE): FROM / JOIN / UPDATE / INTO t [AS] a
function textSources(sql, index) {
  return [...sql.matchAll(tableRefs)].map(([, name, alias]) => {
    const table = index.find(splitName(name))
    alias = alias && !notAlias.test(alias) ? unquote(alias) : null
    return { alias, name: alias || splitName(name).at(-1), table, columns: table?.columns || [] }
  })
}

// Tables visible from the caret. The parser ties UPDATE / DELETE tables to no statement:
// those are kept when they sit in the caret's statement (bounds from splitSql).
function visibleSources(entities, index, stmt, code) {
  const visible = (e) => (e.belongStmt
    ? e.belongStmt.isContainCaret && e.isAccessible !== false
    : !!stmt && e.position.startIndex >= stmt.start && e.position.startIndex <= stmt.end)
  return (entities || []).filter((e) => isSource(e) && visible(e)).map((e) => sourceOf(e, index, code))
}

// monaco-sql-languages calls this with what the parser expects at the caret (suggestions) and the entities it found.
const starters = ['SELECT', 'WITH', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'EXPLAIN', 'TRUNCATE']

async function completionService(model, position, _context, suggestions, entities, snippets) {
  // empty statement (e.g. a new line after "...;"): the parser has nothing to say
  if (!suggestions || (!suggestions.syntax.length && !suggestions.keywords.length)) {
    const before = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column })
    return /(^|;)\s*[\w$]*$/.test(before) ? starters.map((k, i) => ({ label: k, kind: Kind.Keyword, insertText: k + ' ', sortText: String(i).padStart(2, '0') })) : []
  }
  const info = schemas.get(model) || {}
  const dialect = model.getLanguageId() === LanguageIdEnum.MYSQL ? 'mariadb' : 'postgres'
  const q = (s) => quoteIdent(s, dialect)
  const index = makeIndex(info)
  const code = model.getValue()
  const caret = model.getOffsetAt(position)
  const stmts = splitSql(code, dialect)
  const stmt = stmts.find((st) => caret >= st.start && caret <= st.end + 1)
  let sources = visibleSources(entities, index, stmt, code)
  if (!sources.length && stmt) sources = textSources(stmt.sql, index)
  const sourceNamed = (name) => sources.find((x) => x.name.toLowerCase() === name) || sources.find((x) => x.table?.name.toLowerCase() === name)
  const contexts = suggestions.syntax.map((s) => s.syntaxContextType)
  const items = new Map() // key -> item, to drop duplicates
  const add = (item, key = item.label) => { if (!items.has(key)) items.set(key, item) }
  const retrigger = { id: 'editor.action.triggerSuggest', title: '' }

  const tableItem = (t, qualified, sort) => add({
    label: qualified ? `${t.schema}.${t.name}` : t.name,
    kind: t.kind === 'table' ? Kind.Class : Kind.Interface,
    detail: `${t.kind} · ${t.schema}`,
    documentation: t.columns.map((c) => `${c.name} ${c.type}${c.pk ? ' (PK)' : ''}`).join('\n'),
    insertText: qualified ? `${q(t.schema)}.${q(t.name)}` : q(t.name),
    filterText: qualified ? `${t.schema}.${t.name} ${t.name}` : undefined,
    sortText: sort + t.name,
  })
  const addColumns = (cols, source, sort) => cols.forEach((c) => add({
    label: { label: c.name, detail: c.type ? ` ${c.type}` : '', description: source },
    kind: c.pk ? Kind.Constant : Kind.Field,
    insertText: q(c.name),
    sortText: sort + c.name,
  }, `column ${c.name} ${source}`))
  // user functions (only those of the schema when qualified), then built-in ones
  const functionItems = (schema) => {
    for (const f of info.functions || []) if (!schema || f.schema.toLowerCase() === schema) add({ label: { label: f.name, detail: `(${f.args})`, description: f.schema }, kind: Kind.Function, insertText: f.schema === info.current || schema ? f.name : `${q(f.schema)}.${f.name}`, sortText: '4' + f.name }, `function ${f.schema}.${f.name}`)
    if (!schema) for (const f of builtinFunctions[model.getLanguageId()] || []) add({ label: f, kind: Kind.Function, insertText: f, sortText: '5' + f })
  }

  // column list of INSERT INTO t (...: the parser reports no column context there
  // the caret's statement up to the caret (after the previous one when it is still empty)
  const statement = code.slice(stmt ? stmt.start : (stmts.filter((st) => st.end < caret).at(-1)?.end ?? -1) + 1, caret)
  const insert = statement.match(insertColumns)
  if (insert) {
    const table = index.find(splitName(insert[1]))
    const listed = new Set(splitName(insert[2].replace(/,/g, ' ')).map((c) => c.toLowerCase()))
    addColumns((table?.columns || []).filter((c) => !listed.has(c.name.toLowerCase())), table?.name || '', '0')
    return [...items.values()]
  }

  // "alias.|" where the parser reports no context (e.g. UPDATE ... WHERE o.): columns of that source only
  const dotted = statement.match(dottedName)
  if (dotted && !/^\d/.test(dotted[1]) && !suggestions.syntax.some((x) => x.wordRanges.length > 1 && x.wordRanges.some((w) => w.text === '.'))) {
    const parts = splitName(dotted[1])
    const name = parts.at(-1).toLowerCase()
    const src = sourceNamed(name)
    const table = src?.table || (!src && index.find(parts))
    addColumns(src ? src.columns : table?.columns || [], table ? `${table.schema}.${table.name}` : name, '0')
    return [...items.values()]
  }

  // Right after a finished identifier, value or ")" (and a space), the next thing is a keyword: WHERE, JOIN, AND, AS, ASC...
  const lastWord = statement.match(/([\w$]+|["`')\]])\s+$/)?.[1]
  const keywordFirst = !!lastWord && !keywordSets[model.getLanguageId()]?.has(lastWord.toUpperCase())
  let qualified = false

  for (const { syntaxContextType: ctx, wordRanges } of suggestions.syntax) {
    // the parser also reports the context of the previous, finished word ("from customers |"): skip it
    if (wordRanges.length && wordRanges.at(-1).endIndex + 1 < caret) continue
    // what is already typed before the last dot: "sales.or|" -> ['sales'], "c.|" -> ['c']
    const typed = wordRanges.map((w) => w.text).join('')
    const qualifier = typed.includes('.') ? splitName(typed.slice(0, typed.lastIndexOf('.'))) : []
    if (typed.includes('.') && !qualifier.length) continue // the parser sometimes offers a context for a lone "."
    if (qualifier.length) qualified = true

    if ([EntityContextType.TABLE, EntityContextType.VIEW].includes(ctx)) {
      if (qualifier.length) {
        for (const t of info.tables || []) if (t.schema.toLowerCase() === qualifier.at(-1).toLowerCase()) tableItem(t, false, '1')
      } else {
        for (const t of info.tables || []) tableItem(t, t.schema !== info.current, t.schema === info.current ? '1' : '2')
        for (const s of info.schemas || []) add({ label: s, kind: Kind.Module, detail: dialect === 'mariadb' ? 'database' : 'schema', insertText: q(s) + '.', command: retrigger, sortText: '2' + s })
      }
    } else if ([EntityContextType.DATABASE, EntityContextType.CATALOG].includes(ctx)) {
      for (const s of info.schemas || []) add({ label: s, kind: Kind.Module, insertText: q(s), sortText: '0' + s })
    } else if (ctx === EntityContextType.COLUMN || (ctx === EntityContextType.FUNCTION && !contexts.includes(EntityContextType.TABLE)
        && (!qualifier.length || sourceNamed(qualifier.at(-1).toLowerCase())))) {
      // (where a function call fits, outside FROM, so does a column: the parser sometimes only reports the former)
      if (qualifier.length) {
        const src = sourceNamed(qualifier.at(-1).toLowerCase())
        const cols = src ? src.columns : index.find(qualifier)?.columns || []
        addColumns(cols, src?.table ? `${src.table.schema}.${src.table.name}` : qualifier.join('.'), '0')
      } else {
        for (const s of sources) {
          addColumns(s.columns, s.alias ? `${s.alias} → ${s.table?.name ?? 'subquery'}` : s.table ? s.table.name : 'subquery', '0')
          if (s.alias || s.table) add({ label: s.name, kind: Kind.Variable, detail: s.alias ? `alias of ${s.table?.name ?? 'subquery'}` : 'table', insertText: q(s.name) + '.', command: retrigger, sortText: '1' + s.name })
        }
        // no FROM yet (or unknown tables): every table of the current schema
        if (!sources.some((s) => s.columns.length)) {
          for (const t of info.tables || []) if (t.schema === info.current) addColumns(t.columns, t.name, '1')
        }
        functionItems()
      }
    } else if (ctx === EntityContextType.FUNCTION) {
      functionItems(qualifier.at(-1)?.toLowerCase())
    }
  }

  const functions = new Set([...items.values()].filter((it) => it.kind === Kind.Function).map((it) => (it.label.label ?? it.label).toUpperCase()))
  // after "x." only names make sense
  const keywords = qualified && items.size ? [] : suggestions.keywords.filter((k) => !functions.has(k)).map((k, i) => ({
    label: k, kind: Kind.Keyword, insertText: k,
    sortText: (keywordFirst ? '!' : '3') + (frequent.has(k) ? 'a' + frequent.get(k) : 'b' + String(i).padStart(4, '0')), // else in the parser's order
  }))
  const snippetItems = (snippets || []).map((s) => ({ label: s.label || s.prefix, kind: Kind.Snippet, filterText: s.prefix, insertText: s.insertText, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: s.description, sortText: '6' + s.prefix }))
  return [...items.values(), ...keywords, ...snippetItems]
}

for (const id of Object.keys(sqlWorkers)) {
  setupLanguageFeatures(id, {
    completionItems: { enable: true, triggerCharacters: ['.', ' '], continuousCompletion: true, completionService },
    diagnostics: true,
    format: { enable: true, tabWidth: 2 },
  })
}
</script>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  dialect: { type: String, default: 'postgres' },
  completion: { type: Object, default: () => ({}) },
  dark: Boolean,
})
const emit = defineEmits(['update:modelValue', 'run'])

const host = ref()
let editor, model

const selectRange = (from, to) => {
  const a = model.getPositionAt(from), b = model.getPositionAt(to)
  editor.setSelection(new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column))
  editor.revealRangeInCenterIfOutsideViewport(editor.getSelection())
}

// Selection if any, otherwise the statement under the cursor.
function runCurrent() {
  const sel = editor.getSelection()
  if (!sel.isEmpty()) {
    emit('run', { sql: model.getValueInRange(sel), offset: model.getOffsetAt(sel.getStartPosition()) })
    return
  }
  const stmts = splitSql(model.getValue(), props.dialect)
  const pos = model.getOffsetAt(sel.getPosition())
  // the statement containing the cursor, else the nearest one before it, else the first one
  const st = stmts.find((s) => pos >= s.start && pos <= s.end + 1) || stmts.filter((s) => s.end < pos).pop() || stmts[0]
  if (st) {
    selectRange(st.start, st.end)
    emit('run', { sql: st.sql, offset: st.start })
  }
}

function runAll() {
  emit('run', { sql: model.getValue(), offset: 0 })
}

// Replaces the whole text as an edit, so that it stays undoable.
const setText = (text) => editor.executeEdits('vmodel', [{ range: model.getFullModelRange(), text }])

onMounted(() => {
  model = monaco.editor.createModel(props.modelValue, langId(props.dialect))
  model.setEOL(monaco.editor.EndOfLineSequence.LF) // offsets must match the text sent to the server
  schemas.set(model, props.completion)
  editor = monaco.editor.create(host.value, {
    model,
    theme: props.dark ? 'vs-dark' : 'vs',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    fontFamily: "ui-monospace, 'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace",
    scrollBeyondLastLine: false,
    renderLineHighlight: 'line',
    tabSize: 2,
    fixedOverflowWidgets: true,
    // the context menu would otherwise live in a shadow root, out of reach of the CSS Vite injects in <head>
    useShadowDOM: false,
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runCurrent)
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, runAll)
  model.onDidChangeContent(() => {
    const v = model.getValue()
    if (v !== props.modelValue) emit('update:modelValue', v)
  })
})

onBeforeUnmount(() => {
  editor?.dispose()
  model?.dispose()
})

watch(() => props.modelValue, (v) => {
  if (model && v !== model.getValue()) setText(v)
})
watch(() => props.dialect, (d) => model && monaco.editor.setModelLanguage(model, langId(d)))
watch(() => props.completion, (c) => model && schemas.set(model, c))
watch(() => props.dark, (d) => monaco.editor.setTheme(d ? 'vs-dark' : 'vs'))

defineExpose({
  runCurrent: () => editor && runCurrent(),
  runAll: () => editor && runAll(),
  focus: () => editor?.focus(),
  setCursor(pos) {
    pos = Math.max(0, Math.min(pos, model.getValueLength()))
    const p = model.getPositionAt(pos)
    editor.setPosition(p)
    editor.revealPositionInCenterIfOutsideViewport(p)
    editor.focus()
  },
  // Appends text on a new line at the end and returns its offset.
  append(text) {
    const doc = model.getValue()
    const sep = doc.length && !doc.endsWith('\n') ? '\n' : ''
    const end = model.getPositionAt(doc.length)
    editor.executeEdits('append', [{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text: sep + text }])
    const from = doc.length + sep.length
    selectRange(from, from + text.length)
    return from
  },
})
</script>

<style scoped>
.sql-editor { height: 100%; overflow: hidden; }
</style>
