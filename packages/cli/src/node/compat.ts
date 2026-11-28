export const interactiveTerminalUnavailable =
  "Interactive mode requires a terminal. Use `opencode run` or `opencode serve`."

export function tuiUnavailable() {
  return "The full-screen TUI is unavailable in the headless Node CLI. Use `opencode run` or `opencode serve`; install the standard OpenCode CLI for interactive sessions (macOS requires version 13 or later)."
}
