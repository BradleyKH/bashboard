// Usage: pnpm tauri:debug [port]
// Runs `pnpm tauri dev` with WebView2's remote debugging port open (9222 by default), so
// Playwright or Chrome DevTools can attach to the window with connectOverCDP. Debug builds keep
// their own WebView2 data folder, so this runs beside the installed app.
import { spawn } from "node:child_process";

const port = process.argv[2] ?? "9222";
if (!/^\d+$/.test(port)) {
  console.error(`Usage: pnpm tauri:debug [port]   (got: ${port})`);
  process.exit(1);
}

const child = spawn("pnpm", ["tauri", "dev"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
child.on("exit", (code) => process.exit(code ?? 1));
