# TODO

## Security

- [x] Protect access with a simple password (even hard-coded): anyone who reaches port 5180 currently gets full SQL access
- [x] Encrypt `data/connections.json` with a secret read from a `.env` file (ignored by git)

## Editor and execution

- [ ] Several editor tabs per connection
- [ ] History of executed queries: search, insert back into the editor
- [ ] Favorite queries / scripts saved on the server
- [ ] Show that a transaction is open (`BEGIN` without `COMMIT`), with Commit and Rollback buttons
- [ ] One-click `EXPLAIN` / `EXPLAIN ANALYZE`, with a readable plan view
- [ ] Query parameters prompted at run time: `:param`, `$1` and `?`

## Results

- [ ] Export as TSV, JSON and `INSERT`, streamed (without loading the whole result in memory)
- [ ] Pagination beyond the row limit, instead of truncating
- [ ] Quick filter in the grid, column resizing and hiding
- [ ] Cell editing (tables with a primary key): changes stay pending until a "Save" button is clicked, which generates and runs the `UPDATE`s
- [ ] Virtualized grid, to display 20,000 rows without slowing down

## Tree and metadata

- [ ] Indexes, foreign keys, triggers, sequences and functions in the tree
- [ ] Show a table's DDL (`CREATE TABLE …`) from the tree
- [ ] Automatically refresh the tree and the completion cache after DDL (`CREATE`, `ALTER`, `DROP`…)

## Engines and connections

- [ ] Support three engines: SQLite (new), MySQL/MariaDB and PostgreSQL
- [ ] Connections through an SSH tunnel
- [ ] SSL/TLS options in `ConnectionDialog`

## Engineering and maintenance

- [ ] Integration tests against real servers (PostgreSQL and MariaDB in Docker containers; SQLite as a file)
- [ ] Track `dt-sql-parser` and `monaco-sql-languages` upstream: remove `patches/` and the Monaco aliases in `vite.config.ts` once fixed there
- [ ] Add a git remote (private GitHub repository) to back up the project
