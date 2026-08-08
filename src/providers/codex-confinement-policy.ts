export const CODEX_CONFINEMENT_DISABLED_FEATURES = Object.freeze([
  'shell_tool',
  'unified_exec',
  'browser_use',
  'computer_use',
  'js_repl',
  'tool_search',
  // Codex 0.145 starts the built-in codex_apps MCP unless this is explicit.
  'apps',
  'plugins',
]);
