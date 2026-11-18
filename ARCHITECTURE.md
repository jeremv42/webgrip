# Architecture

WebGrip is a minimal web SQL client (PostgreSQL and MariaDB/MySQL): a Vue SPA that talks JSON to a small Node API.
The code (TypeScript) is about 3,000 lines without tests, with no database of its own and no front-end store.

## Technologies

| Layer | Tech | Role |
|---|---|---|
| Backend | **Node.js** (ESM, TypeScript run directly), **Express 5** | JSON REST API |
| | **pg** + **pg-cursor** | PostgreSQL driver; the cursor only reads `maxRows + 1` rows |
| | **mysql2** | MariaDB/MySQL driver; rows are streamed, only the first `maxRows` are kept |
| Front end | **Vue 3** (`<script setup>`, Composition API) | SPA, state local to components, no Pinia nor router |
| | **Vuetify 4** (+ `vite-plugin-vuetify` auto-import, `@mdi/font` icons) | UI components, light/dark theme |
| | **Monaco Editor** (core + features, without the built-in languages) | SQL editor: shortcuts, menu, search… |
| | **monaco-sql-languages** + **dt-sql-parser** (ANTLR PostgreSQL / MySQL grammars, in a web worker) | Highlighting, syntax errors, context-aware completion, formatting (`sql-formatter`) |
| | **patch-package** | Local fix of `dt-sql-parser` (`patches/`), reapplied on every `npm install` |
| Tooling | **Vite 8** | Dev server, build, `preview` and `/api` proxy |
| | **concurrently** | Runs the API and Vite together (`npm run dev` / `npm start`) |
| | **TypeScript** (`vue-tsc` for the SPA, `tsc` for the API) | Type checking only (`npm run typecheck`): Vite compiles the front end, Node strips the API's types |
| | **oxlint** / **oxfmt** (oxc) | Lint (`npm run lint`) and formatting (`npm run format`) |
| | **Vitest** (+ `@vue/test-utils`, `happy-dom`) | Unit and component tests (`npm test`) |

## Layout

```
webgrip/
├── server/                    Backend (API only, listens on 127.0.0.1:3070 only), run as is by Node (type stripping)
│   ├── index.ts               Entry point: reads .env and the environment, then listens
│   ├── app.ts                 Express createApp(): routes, saved connections, driver cache
│   ├── auth.ts                Password, signed session cookie, guard of the /api routes
│   ├── vault.ts               AES-256-GCM encryption of the connections file
│   ├── describe.ts            Structure export as Markdown (to paste into a chat)
│   └── drivers/
│       ├── types.ts           Common Driver interface
│       ├── plan.ts            Helpers shared by the plan parsers
│       ├── edit.ts            Cell editing: the table a result can be updated in, UPDATE builder
│       ├── postgres/
│       │   ├── driver.ts      PostgresDriver
│       │   └── plan.ts        EXPLAIN (FORMAT JSON) → plan tree
│       └── mariadb/
│           ├── driver.ts      MariadbDriver
│           └── plan.ts        EXPLAIN / ANALYZE FORMAT=JSON and MySQL's text tree → plan tree
├── shared/
│   ├── types.ts               Types exchanged as JSON between the API and the SPA (connections, results, completion…)
│   ├── pageable.ts            Whether a statement only reads (can be run again to page), leading comments skipped
│   └── splitSql.ts            Splits a SQL script into statements (used by the server AND the editor)
├── client/                    Front end (Vite root)
│   ├── index.html
│   └── src/
│       ├── main.ts            Creates the Vue + Vuetify app (theme, component defaults)
│       ├── App.vue            Layout and global state: connection, current database/schema, execution
│       ├── api.ts             JSON fetch, identifier quoting, small localStorage wrapper
│       ├── grid.ts            Grid: number detection, sorting, TSV export, visible rows, column widths
│       ├── tabs.ts            Editor tabs: creation, closing, saving per connection
│       ├── style.css
│       ├── components/
│       │   ├── LoginDialog.vue        Password prompt (shown as soon as a request gets a 401)
│       │   ├── ConnectionDialog.vue   Create / edit / test / delete a connection
│       │   ├── DbTree.vue             Tree databases → schemas → tables → columns (loaded on demand)
│       │   ├── EditorTabs.vue         Editor tab bar (add, rename, close)
│       │   ├── SqlEditor.vue          Monaco wrapper (v-model, one model per tab, Ctrl+Enter, Ctrl+Shift+Enter) and completion
│       │   ├── ResultPanel.vue        One tab per executed statement (rows, plan, command, error, skipped)
│       │   ├── PlanView.vue           Plan / Raw toggle: tree with self time / cost share, actual vs estimated rows, details; or the engine's output
│       │   └── ResultGrid.vue         Virtualized HTML grid: sorting, NULL, resizable columns, cell copy, cell editing, TSV copy
│       └── sql/
│           ├── sources.ts             Completion without Monaco: names, schema index, tables read by the statement
│           ├── pgsql.worker.ts        Entry point of the PostgreSQL parser worker
│           └── mysql.worker.ts        Entry point of the MySQL/MariaDB parser worker
├── patches/                   patch-package fixes of dependencies
├── **/*.test.ts               Vitest tests, next to the tested code (plan parsers: real EXPLAIN outputs in plan.fixtures.json)
├── data/connections.json      Saved connections, encrypted (created at run time, ignored by git)
├── .env                       WEBGRIP_PASSWORD, WEBGRIP_SECRET (ignored by git; template: .env.example)
├── dist/                      Front-end build (`npm run build`)
├── tsconfig*.json             tsconfig.app.json (SPA, vue-tsc) and tsconfig.node.json (API, tooling)
├── .oxlintrc.json / .oxfmtrc.json   Lint (oxlint) and formatting (oxfmt)
├── vitest.config.ts           Tests (project root, unlike Vite)
└── vite.config.ts             /api proxy, Tailscale + localhost listening, Monaco aliases, build
```

## Network

```
browser ──► Vite :5180 ──(/api/*)──► Express API 127.0.0.1:3070 ──► PostgreSQL / MariaDB
              └── serves the SPA (dev: sources on the fly, preview: dist/)
```

- A single port for the browser: Vite serves the front end and proxies `/api` to the backend, which is **never** exposed (address `127.0.0.1` hard-coded).
- Vite listens on the IP of the `tailscale0` interface; in `npm run dev`, a small plugin (`localhostForward` in `vite.config.ts`) forwards `127.0.0.1:5180` to that address to keep `localhost` usable. `allowedHosts` allows the machine name and `*.ts.net` (MagicDNS). Without Tailscale, Vite stays on localhost.
- `npm start` = API + `vite preview` of the build, on the same address as the dev server.
- Variables: `WEBGRIP_PASSWORD`, `WEBGRIP_SECRET`, `WEB_PORT` (5180), `PORT` (internal API port, 3070), `WEBGRIP_DATA` (connections file). `server/index.ts` reads `.env` when it exists (`process.loadEnvFile`, variables already set win) and refuses to start without a password and a secret.

## Backend

### API

| Method | Route | Role |
|---|---|---|
| POST | `/api/login` | `{ password }` → sets the session cookie (401 if wrong, 429 after 10 failures in a minute) |
| POST | `/api/logout` | Clears the cookie |
| GET | `/api/connections` | Connection list (no password, `hasPassword` instead) |
| POST | `/api/connections` | Creates or edits (empty password + `keepPassword` = keep the old one) |
| DELETE | `/api/connections/:id` | Deletes and closes the driver |
| POST | `/api/connections/test` | Tests a configuration (returns the server version) |
| GET | `/api/c/:id/info` | `{ hasSchemas, databases }` |
| GET | `/api/c/:id/schemas?db=` | Schemas (Postgres; empty list for MariaDB) |
| GET | `/api/c/:id/tables?db=&schema=` | Tables and views with their kind |
| GET | `/api/c/:id/columns?db=&schema=&table=` | Columns: name, type, not null, primary key |
| GET | `/api/c/:id/completion?db=&schema=` | `{ current, schemas, tables: [{ schema, name, kind, columns: [{ name, type, pk }] }], functions }` for completion (every user schema/database) |
| GET | `/api/c/:id/describe?db=&schema=` | `{ markdown }`: engine, version, tables/views with columns, keys, foreign keys and indexes (structure only, no data) |
| POST | `/api/c/:id/query` | `{ db, schema, sql, maxRows, explain? }` → `{ results: [...] }` (`explain`: `plan` or `analyze`) |
| POST | `/api/c/:id/rows` | `{ db, schema, sql, offset, count }` → `{ rows, truncated, total? }`: rows after the row limit (read-only statements only, `count` ≤ 100,000) |
| POST | `/api/c/:id/save` | `{ db, schema, target: { schema, table }, changes: [{ key, set }] }` → `{ updated }`: edited rows (see Cell editing) |
| POST | `/api/c/:id/cancel` | `{ db }`: cancels the running query |

Every route but `/api/login` requires the session cookie (else `401 { error }`).
Errors are returned as `4xx` with `{ error }`. SQL errors, however, are part of the result (`kind: 'error'`).

### Drivers

`app.ts` lazily creates one driver per saved connection and drops it when the connection is edited or deleted. Both drivers implement the `Driver` interface (`server/drivers/types.ts`):

```
hasSchemas
test() · databases() · schemas(db) · tables(db, schema) · columns(db, schema, table) · completion(db, schema)
run(db, schema, statements, maxRows, explain?) · page(db, schema, sql, offset, count) · save(db, schema, target, changes) · cancel(db) · close()
```

Each driver handles two kinds of connections:

- **Metadata**: a small pool (Postgres: one pool per database, since a Postgres connection is bound to a database; MariaDB: a single pool, queries name the database).
- **Editor session**: one dedicated connection per database, which runs statements one after the other. `BEGIN`, `SET` and temporary tables therefore persist from one run to the next, as in DataGrip. One run at a time per session (`busy`); cancelling goes through the metadata pool (`pg_cancel_backend(pid)` / `KILL QUERY threadId`).

Specifics:

- **Postgres**: values are returned as the server sends them in text (no conversion to `Date`, number or JSON), which keeps dates, `numeric`, `int8` and `bytea` exact. Statements that return rows (`SELECT`, `WITH`, `VALUES`, `SHOW`, `EXPLAIN`…) go through a cursor; the others through a simple query. The chosen schema is applied with `SET search_path`. `NOTICE`s are collected per statement. Type names come from `pg_type` (cached).
- **EXPLAIN**: with `explain`, each statement (unless it already is an EXPLAIN) gets a prefix: Postgres `EXPLAIN ([ANALYZE, BUFFERS, ]FORMAT JSON)`, MySQL/MariaDB `EXPLAIN FORMAT=JSON`, and for ANALYZE `ANALYZE FORMAT=JSON` (MariaDB) or `EXPLAIN ANALYZE` (MySQL, text tree only). ANALYZE runs the statement, so the driver first opens a transaction (`BEGIN` … `ROLLBACK`), or a savepoint when the session is already in one (Postgres: `getTransactionStatus()`; MySQL: the `SERVER_STATUS_IN_TRANS` flag of a `DO 0`). A failure there (aborted transaction) is the statement's error, and the statement is not run. Postgres error positions are shifted back by the prefix length. The result carries `explain`. Any result that is an EXPLAIN output (ours or typed by the user) also carries `plan`, parsed by the driver (see Plans below), next to the raw rows.
- **MariaDB**: options `dateStrings`, `bigNumberStrings`, `jsonStrings` keep textual values; BLOBs are converted to `0x…`. The session is opened directly on the chosen database. Warnings are read with `SHOW WARNINGS`.

### Result format

```js
{ sql, start, end, ms, notices, explain?,
  kind: 'rows',    columns: [{ name, type }], rows: [[...]], truncated, total?, plan?, editable? }
| { kind: 'command', command, affected, info? }
| { kind: 'error',   error: { message, detail?, hint?, code?, position? } }
| { kind: 'skipped' }            // after an error, the following statements are not run
```

Rows are arrays (not objects) to support duplicate column names. `start`/`end` are the statement's positions in the text sent: the front end uses them, with `error.position`, to place the cursor on the error.

## SQL splitting (`shared/splitSql.ts`)

A single module, imported by the server (to run statement by statement) and by the editor (to find the statement under the cursor). It splits on `;`, ignoring those inside strings `'…'`, identifiers `"…"` / `` `…` ``, comments `--`, `#` (MariaDB) and `/* */`, and `$tag$…$tag$` blocks (Postgres). It returns `{ sql, start, end }` for each statement.

## Editor and completion (`SqlEditor.vue`)

- **Loading**: Monaco's core and features, plus the `pgsql` / `mysql` languages of monaco-sql-languages (imported through deep paths: the package index would load the grammars of every dialect). The parsers (≈ 2.2 MB each) run in a web worker, loaded only for the dialect in use.
- **Monaco ≥ 0.53 adaptation**: monaco-sql-languages still uses the old paths (`monaco-editor/esm/vs/...`) and the old worker API (`createWebWorker({ moduleId, label, createData })`). Aliases in `vite.config.ts` resolve the paths, and `SqlEditor.vue` wraps `monaco.editor.createWebWorker` to provide the `Worker` (`client/src/sql/*.worker.ts`) and send it `createData`.
- **Completion**: on each request, the parser tells what the grammar expects at the caret (table, column, function, database… and the valid keywords) and the statement's entities (tables, aliases, subqueries, CTEs). The `completionService` crosses them with the schema returned by `/completion`:
  - tables of every schema (unqualified for the current schema), schemas, then the schema's tables after `schema.`;
  - typed columns of the tables visible from the statement, `alias.` → that table's columns, columns of subqueries and CTEs (`*` expanded);
  - keywords in a useful order (FROM, WHERE, JOIN… first), and first right after a finished identifier (`from t |`, `where a = 1 |`);
  - user functions, then built-in ones.
- **Workarounds for parser limits**: it does not attach the tables of an UPDATE/DELETE to their statement (visibility decided by position with `splitSql`), misses some aliases (read from the text), does not see the column list of an `INSERT INTO t (` nor, in MySQL, the tables of an UPDATE (extracted from the text by regex). `patches/dt-sql-parser+4.6.0.patch` fixes a crash on those same statements.
- **Diagnostics and formatting**: syntax errors underlined (worker), formatting with Ctrl+Alt+F or the context menu.

## Front end

- **State**: all shared state lives in `App.vue` (refs) and goes down through props; components send events up (`run`, `context`, `open-table`, `reload`, `saved`…). No store.
- **Browser persistence** (`localStorage`, prefix `webgrip.`): theme, current connection, database/schema per connection, editor tabs per connection (`tabs.<id>`: name and text of each tab, active tab; the old `sql.<id>` becomes the first tab), editor height, max rows.
- **Editor tabs**: `App.vue` holds the current connection's tabs (`tabs.ts`) and each tab's results, in memory only. `SqlEditor` receives the tab id (`docId`) and keeps one Monaco model per tab: text, undo history, cursor and scroll belong to each tab. A run stores its results in the tab that started it, even if the user has switched to another one meanwhile. All runs go through the same database session, one at a time.
- **Execution flow**: `SqlEditor` emits `run({ sql, offset })` (selection, statement under the cursor or whole script) → `App.vue` calls `/query` with the current database and schema → `ResultPanel` shows one tab per result and opens the first error if there is one.
- **Tree** (`DbTree.vue`): nodes loaded when opened, rendered flat (computed indentation) to stay light; a click on a database/schema changes the editor's context, a double-click on a table appends and runs `SELECT * … LIMIT n`.
- **Plans**: each driver's `planOf(columns, rows)` (`server/drivers/<engine>/plan.ts`) recognizes a plan by its single cell (Postgres: `QUERY PLAN` json; MySQL/MariaDB: `EXPLAIN` / `ANALYZE` JSON or `->` tree) and normalizes it into the shared `Plan` type (`shared/types.ts`): title, details, estimated / actual rows over all loops, cost, inclusive and exclusive time. Postgres times and costs are inclusive (exclusive = node − children); MySQL/MariaDB JSON gives each table or sort its own figures and the query block its total, so containers are rolled up from their children. `PlanView.vue` switches between this tree and the raw output (JSON indented), the choice kept in `localStorage`. The bars show each node's exclusive share of the total; a ×10 gap between actual and estimated rows is flagged (except a shortfall under a LIMIT).
- **Grid** (`ResultGrid.vue`): a plain HTML `<table>` (sticky header and row numbers), rather than a `v-data-table`, to keep control of rendering and density.
  - *Virtualization*: every row is exactly 24 px (one line, `nowrap`), so the rows on screen follow from `scrollTop`; only they (plus 10 above and below) are rendered, between two spacer rows of the right height. 20,000 rows render about 35 `<tr>`.
  - *Widths*: `table-layout: fixed` with a `<colgroup>`, so widths do not change while scrolling. Each column gets the width of its header or longest value (monospace: characters × measured character width), up to 420 px; dragging a header's edge resizes it, double-clicking the edge fits the content up to 800 px.
  - *Rows after the limit*: a truncated result of a read-only statement (`shared/pageable.ts`: `SELECT`/`WITH`/`VALUES`/`TABLE`/`SHOW` without DML, `INTO`, locking clause or sequence call) offers **Load more** / **Load all**. `POST /rows` runs the statement again on the editor session and skips the rows already shown: Postgres through a cursor read by batches of 5,000, MySQL/MariaDB while streaming. No SQL is rewritten (any `ORDER BY`, `LIMIT` or duplicate column name keeps working), at the cost of running the query again; without an `ORDER BY` the order may differ between runs. The page is appended to the result's rows (edits, keyed by row index, stay valid).
  - *Quick filter* (debounced) keeps the rows where a shown column contains the text, case-insensitive. *Hidden columns* (Columns menu) are left out of the grid, the filter and the TSV copy; both are kept when the next result has the same column names.
  - *Copy*: the hovered cell (tracked by delegation on `tbody`) shows a copy button when the column is at least 72 px wide and the value is not NULL.
- **Cell editing**: the driver tells whether a result is editable (`editable`: schema, table, the table column behind each result column, primary key). Postgres gives each field's `tableID` / `columnID`, read in `pg_attribute` / `pg_index`; MySQL/MariaDB give `orgTable` / `orgName`, read in `information_schema`. `edit.ts` keeps the one table whose whole primary key is in the result, each of its columns shown once (no self-join); only its columns are editable, minus generated ones (and binary ones in MySQL, shown as hex). A failed lookup only makes the result read-only. In the grid, a double-click edits in place (Enter / Escape; Shift+double-click, multi-line or long values: a dialog with a NULL box); edits are kept per result (`WeakMap`), so switching result tabs keeps them, and drawn as pending until **Save**. Save groups them by row (`{ key: values read, set: new values }`) and `POST /save` runs parameterized `UPDATE`s on the editor session, in a transaction (or a savepoint inside the user's own, refused in a failed one); each must match exactly one row (MySQL: `Rows matched` from the info, since `affectedRows` skips unchanged rows), otherwise everything is rolled back and the edits stay pending.

## Security

- **Access**: a single password (`WEBGRIP_PASSWORD`). `/api/login` compares it in constant time; on success it sets a `webgrip_session` cookie (`HttpOnly`, `SameSite=Strict`, `Path=/api`, 30 days) holding an expiry date signed with HMAC. No session is kept on the server: the cookie survives API restarts, and changing the password or the secret invalidates every cookie. Failures are slowed down (500 ms) and limited to 10 per minute. The cookie has no `Secure` attribute: the tailnet is plain HTTP (encrypted by WireGuard).
- **Saved connections**: `data/connections.json` (mode `600`) is encrypted with AES-256-GCM, with a key derived from `WEBGRIP_SECRET` by scrypt (fresh salt and IV on each write). An unreadable file (wrong secret, altered file) stops the startup instead of being overwritten. Passwords are never sent to the browser.
- **Front end**: any `401` answer (`onUnauthorized` in `api.ts`) shows `LoginDialog`; once logged in, the app reloads the connections.
