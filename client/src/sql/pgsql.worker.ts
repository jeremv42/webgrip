import { initialize } from 'monaco-editor/internal/common/initialize'
import { PgSQLWorker } from 'monaco-sql-languages/esm/languages/pgsql/PgSQLWorker.js'

initialize((ctx, createData) => new PgSQLWorker(ctx, createData))
