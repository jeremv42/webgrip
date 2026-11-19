# WebGrip

A mini web DataGrip in TypeScript: Node (Express, `pg`, `mysql2`) + Vue 3 / Vuetify, no store.

- Access protected by a password (`WEBGRIP_PASSWORD`), session kept for 30 days by a cookie
- PostgreSQL and MariaDB/MySQL connections, saved encrypted (AES-256-GCM, key `WEBGRIP_SECRET`) in `data/connections.json`
- Tree databases → schemas (Postgres) → tables/views → columns, filter, double-click on a table = `SELECT * … LIMIT n`
- Monaco editor (VS Code's) with a real SQL parser: context-aware completion (tables of every schema, typed columns, aliases, subqueries, CTEs, keywords, functions), syntax errors underlined, formatting (Ctrl+Alt+F)
  - **Ctrl+Enter**: selection, else the statement under the cursor
  - **Ctrl+Shift+Enter**: the whole script
- Several editor tabs per connection ("Console N"): double-click to rename, middle click or × to close; each keeps its text, undo history, position and results
- One result tab per statement; stops at the first error (the cursor is placed on the error when Postgres gives its position)
- **Explain** (Alt+E) / **Analyze** (Alt+Shift+E), also in the editor's context menu: plan of the statement under the cursor, shown as a tree with each node's share of the time (or cost), actual vs estimated rows (misestimates flagged), loops and details; a Plan / Raw toggle shows the engine's output instead (the choice is remembered). Analyze runs the statement inside a transaction (or a savepoint, in an open transaction) rolled back afterwards, so an `UPDATE`/`DELETE` changes nothing (except non-transactional MySQL tables and sequences). A hand-written `EXPLAIN (FORMAT JSON)` / `EXPLAIN FORMAT=JSON` gets the same view
- Grid: virtualized (20,000 rows stay fluid), sort by column, distinct NULLs, double-click on a cell = full value (indented JSON), TSV copy, copy button on the hovered cell
- Beyond the row limit: **Load more** (one more page) or **Load all** (up to 100,000 more rows) for read-only queries
- Quick filter on the loaded rows, columns hidden or shown from the **Columns** menu (kept when the same query runs again)
- Columns: drag a header's edge to resize, double-click it to fit the content (up to 800 px)
- Cell editing when the rows come from one table with its primary key in the result: double-click to edit (Shift+double-click: full editor, NULL), changes stay pending until **Save**, which runs the `UPDATE`s in one transaction (inside yours if one is open)
- One dedicated session per database for the editor (`BEGIN`/`SET`/temporary tables persist between runs); Cancel button (`pg_cancel_backend` / `KILL QUERY`)
- Row limit (100 to 20,000): extra rows are never loaded (cursor on Postgres, streaming on MariaDB)
- **Chat with Claude** (optional, `WEBGRIP_CHAT=1`): a right-hand panel backed by the Claude Code CLI installed and logged in
  on the server (no API key: it uses that account). Claude has no shell or file access, only the selected connection's
  structure (databases, tables, columns, keys, indexes). By default it never sees a row: it writes the queries, you run them,
  and the paperclip attaches the result on screen to your message, where you can read and edit it before sending.
  With `WEBGRIP_CHAT_RUN_QUERY=1` it may also run read-only queries itself. SQL blocks in its answers have **Insert**
  (append to the editor) and **Copy**; the conversation is kept per connection

## Run

```bash
cp .env.example .env             # then set WEBGRIP_PASSWORD and WEBGRIP_SECRET (openssl rand -base64 32)
npm install
npm run dev                      # Vite + API in watch mode
npm run build && npm start       # vite preview of the build, port 5180
```

Node ≥ 23.6: the API (`server/*.ts`) runs as is, with no build step (type stripping).

## Desktop app

The same app as a native window (Tauri v2: the system's webview, no bundled Chromium), with no password and
nothing else to install on the target machine: the server is shipped as a single executable.

```bash
# once: Rust (https://rustup.rs) and, on Debian/Ubuntu, the WebKitGTK headers
sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

npm run desktop:dev              # builds the SPA and the server executable, then opens the app
npm run desktop:build            # installers in src-tauri/target/release/bundle/ (.deb, .rpm, AppImage / .dmg / .msi)
```

Packages are built for the platform you build on (a macOS or Windows machine for those). Connections are kept in
the app's data folder; the chat turns on by itself when the `claude` CLI is installed. See ARCHITECTURE.md.

## Check

```bash
npm run typecheck                # vue-tsc (SPA) + tsc (API)
npm run lint                     # oxlint
npm run format                   # oxfmt (format:check to only check)
npm test                         # Vitest (test:watch to keep running)
npm run check                    # all of the above
```

Everything goes through Vite's port (5180): it serves the front end and proxies `/api` to the backend,
which only listens on `127.0.0.1:3070` (never exposed).

Variables (environment or `.env`, ignored by git): `WEBGRIP_PASSWORD` (access password), `WEBGRIP_SECRET` (encryption key
of the connections and the cookies, at least 16 characters: losing it means losing the saved connections),
`WEB_PORT` (Vite's port, 5180), `PORT` (internal API port, 3070), `WEBGRIP_DATA` (path of the connections file),
`WEBGRIP_CHAT` (1: chat panel, needs `claude` installed and logged in for the user running the API),
`WEBGRIP_CHAT_RUN_QUERY` (1: Claude may run read-only queries and read their rows; off by default),
`WEBGRIP_CLAUDE_BIN` (the CLI's path, default `claude` from `PATH`), `WEBGRIP_CHAT_MODEL` (e.g. `sonnet`; default: the CLI's).
An old plain-text connections file is encrypted at the first start. Changing `WEBGRIP_PASSWORD` logs every session out.
