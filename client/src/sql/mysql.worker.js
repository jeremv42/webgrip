import { initialize } from 'monaco-editor/internal/common/initialize'
import { MySQLWorker } from 'monaco-sql-languages/esm/languages/mysql/mysqlWorker.js'

initialize((ctx, createData) => new MySQLWorker(ctx, createData))
