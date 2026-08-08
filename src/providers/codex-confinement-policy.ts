export const CODEX_CONFINEMENT_DISABLED_FEATURES = Object.freeze([
  'shell_tool',
  'unified_exec',
  'browser_use',
  'computer_use',
  'js_repl',
  'tool_search',
  // Native delegation cannot share the gateway's fenced execution session.
  'multi_agent',
  // Codex 0.145 starts the built-in codex_apps MCP unless this is explicit.
  'apps',
  'plugins',
]);
