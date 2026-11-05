// Usage: pnpm tauri:debug [port]
// Runs `pnpm tauri dev` with WebView2's remote debugging port open (9222 by default), so
// Playwright or Chrome DevTools can attach to the window with connectOverCDP. Debug builds keep
// their own WebView2 data folder, so this runs beside the installed app.
import { spawn } from "node:child_process";
import { connect } from "node:net";

const VITE_PORT = 1420;

const port = process.argv[2] ?? "9222";
if (!/^\d+$/.test(port)) {
  console.error(`Usage: pnpm tauri:debug [port]   (got: ${port})`);
  process.exit(1);
}

// Vite listens on `localhost`, which may be either address family, so probe both.
function listening(p: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port: p, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

// With the Vite port taken, `tauri dev` reports failure but its cargo child still launches a
// debug app with the CDP port open, leaving an orphan beside whatever the user starts next.
const probes = await Promise.all(["127.0.0.1", "::1"].map((h) => listening(VITE_PORT, h)));
const taken = probes.some(Boolean);
if (taken) {
  console.error(
    `Port ${VITE_PORT} is already in use, so Vite can't start. To use the server already on it, run\n` +
      `  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${port} src-tauri/target/debug/bashboard.exe`,
  );
  process.exit(1);
}

const child = spawn("pnpm", ["tauri", "dev"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
child.on("exit", (code) => process.exit(code ?? 1));
