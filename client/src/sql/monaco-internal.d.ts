// Entry point of Monaco's worker side (no typings shipped): registers the object that serves the editor's requests.
declare module 'monaco-editor/internal/common/initialize' {
  // oxlint-disable-next-line typescript/no-explicit-any -- the language worker defines its own context / data types
  export function initialize(factory: (ctx: any, createData: any) => unknown): void
}
