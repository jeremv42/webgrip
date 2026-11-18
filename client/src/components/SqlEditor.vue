<template>
  <div ref="host" class="sql-editor" />
</template>

<script lang="ts">
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
import PgsqlWorker from '../sql/pgsql.worker.ts?worker'
import MysqlWorker from '../sql/mysql.worker.ts?worker'
import type { CompletionService, ICompletionItem } from 'monaco-sql-languages/esm/monaco.contribution.js'
import { quoteIdent } from '../api.ts'
import { splitSql } from '../../../shared/splitSql.ts'
import type { CompletionInfo, CompletionTable, Dialect, ExplainMode } from '../../../shared/types.ts'
import { dottedName, insertColumns, makeIndex, splitName, textSources, visibleSources, type Entity, type Source } from '../sql/sources.ts'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

// monaco-sql-languages creates its workers with the pre-0.53 API ({ moduleId, label, createData }):
// give it a real Worker, and send the createData its entry point waits for.
const sqlWorkers: Record<string, new () => Worker> = { [LanguageIdEnum.PG]: PgsqlWorker, [LanguageIdEnum.MYSQL]: MysqlWorker }
const createWebWorker = monaco.editor.createWebWorker
type WorkerOptions = Parameters<typeof createWebWorker>[0]
type LegacyWorkerOptions = Partial<WorkerOptions> & { label?: string; createData?: unknown }
monaco.editor.createWebWorker = ((opts: LegacyWorkerOptions) => {
  const SqlWorker = opts.label ? sqlWorkers[opts.label] : undefined
  if (opts.worker || !SqlWorker) return createWebWorker(opts as WorkerOptions)
  const worker = new SqlWorker()
  worker.postMessage(opts.createData)
  return createWebWorker({ ...opts, worker } as WorkerOptions)
}) as typeof createWebWorker

export interface RunRequest {
  sql: string
  // offset of `sql` in the editor's text
  offset: number
  // wrap each statement in EXPLAIN (or EXPLAIN ANALYZE)
  explain?: ExplainMode
}

const langId = (dialect?: Dialect) => (dialect === 'mariadb' ? LanguageIdEnum.MYSQL : LanguageIdEnum.PG)
// Keywords people type most, ranked first when the parser allows them
const frequent = [
  'FROM',
  'WHERE',
  'AS',
  'AND',
  'OR',
  'ON',
  'JOIN',
  'LEFT JOIN',
  'INNER JOIN',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'ASC',
  'DESC',
  'SET',
  'VALUES',
  'INTO',
  'IN',
  'IS',
  'NOT',
  'LIKE',
  'BETWEEN',
  'UNION',
  'UNION ALL',
  'RETURNING',
  'NULLS',
  'OFFSET',
].reduce((m, k, i) => m.set(k, String(i).padStart(2, '0')), new Map<string, string>())
const keywordSets: Record<string, Set<string>> = {
  [LanguageIdEnum.PG]: new Set(pgsqlLang.keywords),
  [LanguageIdEnum.MYSQL]: new Set(mysqlLang.keywords),
}
// COUNT is missing from monaco-sql-languages' PostgreSQL function list
const builtinFunctions: Record<string, string[]> = {
  [LanguageIdEnum.PG]: ['COUNT', ...pgsqlLang.builtinFunctions],
  [LanguageIdEnum.MYSQL]: mysqlLang.builtinFunctions,
}

// Schema of each editor's model: { current, schemas, tables: [{ schema, name, kind, columns: [{ name, type, pk }] }], functions }
const schemas = new WeakMap<object, Partial<CompletionInfo>>()
const { CompletionItemKind: Kind } = monaco.languages

// monaco-sql-languages calls this with what the parser expects at the caret (suggestions) and the entities it found.
const starters = [
  'SELECT',
  'WITH',
  'INSERT INTO',
  'UPDATE',
  'DELETE FROM',
  'CREATE TABLE',
  'ALTER TABLE',
  'DROP TABLE',
  'EXPLAIN',
  'TRUNCATE',
]

const completionService: CompletionService = async (model, position, _context, suggestions, parsed, snippets) => {
  // empty statement (e.g. a new line after "...;"): the parser has nothing to say
  if (!suggestions || (!suggestions.syntax.length && !suggestions.keywords.length)) {
    const before = model.getValueInRange({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    })
    return /(^|;)\s*[\w$]*$/.test(before)
      ? starters.map((k, i) => ({ label: k, kind: Kind.Keyword, insertText: k + ' ', sortText: String(i).padStart(2, '0') }))
      : []
  }
  const entities = parsed as Entity[] | null
  const info = schemas.get(model) || {}
  const dialect: Dialect = model.getLanguageId() === LanguageIdEnum.MYSQL ? 'mariadb' : 'postgres'
  const q = (s: string) => quoteIdent(s, dialect)
  const index = makeIndex(info)
  const code = model.getValue()
  const caret = model.getOffsetAt(position)
  const stmts = splitSql(code, dialect)
  const stmt = stmts.find((st) => caret >= st.start && caret <= st.end + 1)
  let sources: Source[] = visibleSources(entities, index, stmt, code)
  if (!sources.length && stmt) sources = textSources(stmt.sql, index)
  const sourceNamed = (name: string) =>
    sources.find((x) => x.name.toLowerCase() === name) || sources.find((x) => x.table?.name.toLowerCase() === name)
  const contexts = new Set(suggestions.syntax.map((s) => s.syntaxContextType))
  const items = new Map<string, ICompletionItem>() // key -> item, to drop duplicates
  const add = (item: ICompletionItem, key = item.label as string) => {
    if (!items.has(key)) items.set(key, item)
  }
  const retrigger = { id: 'editor.action.triggerSuggest', title: '' }

  const tableItem = (t: CompletionTable, qualified: boolean, sort: string) =>
    add({
      label: qualified ? `${t.schema}.${t.name}` : t.name,
      kind: t.kind === 'table' ? Kind.Class : Kind.Interface,
      detail: `${t.kind} · ${t.schema}`,
      documentation: t.columns.map((c) => `${c.name} ${c.type}${c.pk ? ' (PK)' : ''}`).join('\n'),
      insertText: qualified ? `${q(t.schema)}.${q(t.name)}` : q(t.name),
      filterText: qualified ? `${t.schema}.${t.name} ${t.name}` : undefined,
      sortText: sort + t.name,
    })
  const addColumns = (cols: Source['columns'], source: string, sort: string) =>
    cols.forEach((c) =>
      add(
        {
          label: { label: c.name, detail: c.type ? ` ${c.type}` : '', description: source },
          kind: c.pk ? Kind.Constant : Kind.Field,
          insertText: q(c.name),
          sortText: sort + c.name,
        },
        `column ${c.name} ${source}`,
      ),
    )
  // user functions (only those of the schema when qualified), then built-in ones
  const functionItems = (schema?: string) => {
    for (const f of info.functions || [])
      if (!schema || f.schema.toLowerCase() === schema)
        add(
          {
            label: { label: f.name, detail: `(${f.args})`, description: f.schema },
            kind: Kind.Function,
            insertText: f.schema === info.current || schema ? f.name : `${q(f.schema)}.${f.name}`,
            sortText: '4' + f.name,
          },
          `function ${f.schema}.${f.name}`,
        )
    if (!schema)
      for (const f of builtinFunctions[model.getLanguageId()] || [])
        add({ label: f, kind: Kind.Function, insertText: f, sortText: '5' + f })
  }

  // column list of INSERT INTO t (...: the parser reports no column context there
  // the caret's statement up to the caret (after the previous one when it is still empty)
  const statement = code.slice(stmt ? stmt.start : (stmts.findLast((st) => st.end < caret)?.end ?? -1) + 1, caret)
  const insert = statement.match(insertColumns)
  if (insert) {
    const table = index.find(splitName(insert[1]))
    const listed = new Set(splitName(insert[2].replace(/,/g, ' ')).map((c) => c.toLowerCase()))
    addColumns(
      (table?.columns || []).filter((c) => !listed.has(c.name.toLowerCase())),
      table?.name || '',
      '0',
    )
    return [...items.values()]
  }

  // "alias.|" where the parser reports no context (e.g. UPDATE ... WHERE o.): columns of that source only
  const dotted = statement.match(dottedName)
  if (
    dotted &&
    !/^\d/.test(dotted[1]) &&
    !suggestions.syntax.some((x) => x.wordRanges.length > 1 && x.wordRanges.some((w) => w.text === '.'))
  ) {
    const parts = splitName(dotted[1])
    const name = parts.at(-1)!.toLowerCase()
    const src = sourceNamed(name)
    const table = src?.table || (!src ? index.find(parts) : undefined)
    addColumns(src ? src.columns : table?.columns || [], table ? `${table.schema}.${table.name}` : name, '0')
    return [...items.values()]
  }

  // Right after a finished identifier, value or ")" (and a space), the next thing is a keyword: WHERE, JOIN, AND, AS, ASC...
  const lastWord = statement.match(/([\w$]+|["`')\]])\s+$/)?.[1]
  const keywordFirst = !!lastWord && !keywordSets[model.getLanguageId()]?.has(lastWord.toUpperCase())
  let qualified = false

  for (const { syntaxContextType: ctx, wordRanges } of suggestions.syntax) {
    // the parser also reports the context of the previous, finished word ("from customers |"): skip it
    if (wordRanges.length && wordRanges.at(-1)!.endIndex + 1 < caret) continue
    // what is already typed before the last dot: "sales.or|" -> ['sales'], "c.|" -> ['c']
    const typed = wordRanges.map((w) => w.text).join('')
    const qualifier = typed.includes('.') ? splitName(typed.slice(0, typed.lastIndexOf('.'))) : []
    if (typed.includes('.') && !qualifier.length) continue // the parser sometimes offers a context for a lone "."
    if (qualifier.length) qualified = true

    if (ctx === EntityContextType.TABLE || ctx === EntityContextType.VIEW) {
      if (qualifier.length) {
        for (const t of info.tables || []) if (t.schema.toLowerCase() === qualifier.at(-1)!.toLowerCase()) tableItem(t, false, '1')
      } else {
        for (const t of info.tables || []) tableItem(t, t.schema !== info.current, t.schema === info.current ? '1' : '2')
        for (const s of info.schemas || [])
          add({
            label: s,
            kind: Kind.Module,
            detail: dialect === 'mariadb' ? 'database' : 'schema',
            insertText: q(s) + '.',
            command: retrigger,
            sortText: '2' + s,
          })
      }
    } else if (ctx === EntityContextType.DATABASE || ctx === EntityContextType.CATALOG) {
      for (const s of info.schemas || []) add({ label: s, kind: Kind.Module, insertText: q(s), sortText: '0' + s })
    } else if (
      ctx === EntityContextType.COLUMN ||
      (ctx === EntityContextType.FUNCTION &&
        !contexts.has(EntityContextType.TABLE) &&
        (!qualifier.length || sourceNamed(qualifier.at(-1)!.toLowerCase())))
    ) {
      // (where a function call fits, outside FROM, so does a column: the parser sometimes only reports the former)
      if (qualifier.length) {
        const src = sourceNamed(qualifier.at(-1)!.toLowerCase())
        const cols = src ? src.columns : index.find(qualifier)?.columns || []
        addColumns(cols, src?.table ? `${src.table.schema}.${src.table.name}` : qualifier.join('.'), '0')
      } else {
        for (const s of sources) {
          addColumns(s.columns, s.alias ? `${s.alias} → ${s.table?.name ?? 'subquery'}` : s.table ? s.table.name : 'subquery', '0')
          if (s.alias || s.table)
            add({
              label: s.name,
              kind: Kind.Variable,
              detail: s.alias ? `alias of ${s.table?.name ?? 'subquery'}` : 'table',
              insertText: q(s.name) + '.',
              command: retrigger,
              sortText: '1' + s.name,
            })
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

  const functions = new Set(
    [...items.values()]
      .filter((it) => it.kind === Kind.Function)
      .map((it) => (typeof it.label === 'string' ? it.label : it.label.label).toUpperCase()),
  )
  // after "x." only names make sense
  const keywords: ICompletionItem[] =
    qualified && items.size
      ? []
      : suggestions.keywords
          .filter((k) => !functions.has(k))
          .map((k, i) => ({
            label: k,
            kind: Kind.Keyword,
            insertText: k,
            sortText: (keywordFirst ? '!' : '3') + (frequent.has(k) ? 'a' + frequent.get(k)! : 'b' + String(i).padStart(4, '0')), // else in the parser's order
          }))
  const snippetItems: ICompletionItem[] = (snippets || []).map((s) => ({
    label: s.label || s.prefix,
    kind: Kind.Snippet,
    filterText: s.prefix,
    insertText: s.insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    detail: s.description,
    sortText: '6' + s.prefix,
  }))
  return [...items.values(), ...keywords, ...snippetItems]
}

for (const id of [LanguageIdEnum.PG, LanguageIdEnum.MYSQL]) {
  setupLanguageFeatures(id, {
    completionItems: { enable: true, triggerCharacters: ['.', ' '], continuousCompletion: true, completionService },
    diagnostics: true,
    format: { enable: true, tabWidth: 2 },
  })
}
</script>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'

// docId: one Monaco model per document (editor tab), so that each keeps its undo history, cursor and scroll position
const props = withDefaults(defineProps<{ docId?: string; dialect?: Dialect; completion?: Partial<CompletionInfo>; dark?: boolean }>(), {
  docId: '',
  dialect: 'postgres',
  completion: () => ({}),
})
const text = defineModel<string>({ default: '' })
const emit = defineEmits<{ run: [RunRequest] }>()

const host = ref<HTMLElement>()
let editor: monaco.editor.IStandaloneCodeEditor
let model: monaco.editor.ITextModel // the current document's
let currentDoc = ''
const docs = new Map<string, { model: monaco.editor.ITextModel; view: monaco.editor.ICodeEditorViewState | null }>()

function docModel(id: string, value: string) {
  let doc = docs.get(id)
  if (!doc) {
    const m = monaco.editor.createModel(value, langId(props.dialect))
    m.setEOL(monaco.editor.EndOfLineSequence.LF) // offsets must match the text sent to the server
    doc = { model: m, view: null }
    docs.set(id, doc)
  }
  return doc
}

// Shows another document: saves the view state (cursor, scroll) of the current one, restores the other's.
function switchDoc(id: string, value: string) {
  const prev = docs.get(currentDoc)
  if (prev) prev.view = editor.saveViewState()
  const doc = docModel(id, value)
  model = doc.model
  currentDoc = id
  if (model.getLanguageId() !== langId(props.dialect)) monaco.editor.setModelLanguage(model, langId(props.dialect))
  schemas.set(model, props.completion)
  editor.setModel(model)
  if (doc.view) editor.restoreViewState(doc.view)
  if (model.getValue() !== value) setText(value)
}

const selectRange = (from: number, to: number) => {
  const a = model.getPositionAt(from),
    b = model.getPositionAt(to)
  editor.setSelection(new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column))
  editor.revealRangeInCenterIfOutsideViewport(editor.getSelection()!)
}

// Selection if any, otherwise the statement under the cursor.
function runCurrent(explain?: ExplainMode) {
  const sel = editor.getSelection()
  if (!sel) return
  if (!sel.isEmpty()) {
    emit('run', { sql: model.getValueInRange(sel), offset: model.getOffsetAt(sel.getStartPosition()), explain })
    return
  }
  const stmts = splitSql(model.getValue(), props.dialect)
  const pos = model.getOffsetAt(sel.getPosition())
  // the statement containing the cursor, else the nearest one before it, else the first one
  const st = stmts.find((s) => pos >= s.start && pos <= s.end + 1) || stmts.findLast((s) => s.end < pos) || stmts[0]
  if (st) {
    selectRange(st.start, st.end)
    emit('run', { sql: st.sql, offset: st.start, explain })
  }
}

function runAll() {
  emit('run', { sql: model.getValue(), offset: 0 })
}

// Replaces the whole text as an edit, so that it stays undoable.
const setText = (value: string) => editor.executeEdits('vmodel', [{ range: model.getFullModelRange(), text: value }])

onMounted(() => {
  currentDoc = props.docId
  model = docModel(currentDoc, text.value).model
  schemas.set(model, props.completion)
  editor = monaco.editor.create(host.value!, {
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
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runCurrent())
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, runAll)
  // (not Ctrl+Alt+E: that is AltGr+E, the € sign, on many keyboards)
  editor.addAction({
    id: 'webgrip.explain',
    label: 'Explain Plan',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyE],
    contextMenuGroupId: '1_run',
    contextMenuOrder: 1,
    run: () => runCurrent('plan'),
  })
  editor.addAction({
    id: 'webgrip.explainAnalyze',
    label: 'Explain Analyze (runs the statement, then rolls it back)',
    keybindings: [monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.KeyE],
    contextMenuGroupId: '1_run',
    contextMenuOrder: 2,
    run: () => runCurrent('analyze'),
  })
  // (the editor's event only fires for the document on screen)
  editor.onDidChangeModelContent(() => {
    const v = model.getValue()
    if (v !== text.value) text.value = v
  })
})

onBeforeUnmount(() => {
  editor?.dispose()
  for (const d of docs.values()) d.model.dispose()
  docs.clear()
})

// one watcher for both: when the document changes, the text that comes with it is the new document's
watch([() => props.docId, text], ([id, v]) => {
  if (!editor) return
  if (id !== currentDoc) switchDoc(id, v)
  else if (v !== model.getValue()) setText(v)
})
watch(
  () => props.dialect,
  (d) => model && monaco.editor.setModelLanguage(model, langId(d)),
)
watch(
  () => props.completion,
  (c) => model && schemas.set(model, c),
)
watch(
  () => props.dark,
  (d) => monaco.editor.setTheme(d ? 'vs-dark' : 'vs'),
)

defineExpose({
  runCurrent: () => editor && runCurrent(),
  explain: (mode: ExplainMode) => editor && runCurrent(mode),
  runAll: () => editor && runAll(),
  focus: () => editor?.focus(),
  // a closed tab: drop its model
  forget(id: string) {
    const d = docs.get(id)
    if (!d || id === currentDoc) return
    d.model.dispose()
    docs.delete(id)
  },
  setCursor(pos: number) {
    pos = Math.max(0, Math.min(pos, model.getValueLength()))
    const p = model.getPositionAt(pos)
    editor.setPosition(p)
    editor.revealPositionInCenterIfOutsideViewport(p)
    editor.focus()
  },
  // Appends text on a new line at the end and returns its offset.
  append(added: string) {
    const doc = model.getValue()
    const sep = doc.length && !doc.endsWith('\n') ? '\n' : ''
    const end = model.getPositionAt(doc.length)
    editor.executeEdits('append', [{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text: sep + added }])
    const from = doc.length + sep.length
    selectRange(from, from + added.length)
    return from
  },
})
</script>

<style scoped>
.sql-editor {
  height: 100%;
  overflow: hidden;
}
</style>
