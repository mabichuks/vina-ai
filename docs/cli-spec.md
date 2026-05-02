# CLI Spec — `packages/cli`

The `vina` binary. Thin wrapper that manages the daemon lifecycle and opens the UI.

## 1. Folder Layout

```
packages/cli/
├── src/
│   ├── bin.ts              # shebang entrypoint, registered in package.json
│   ├── config.ts           # env-paths constants (dataDir, pidFile, statusFile, …)
│   ├── commands/
│   │   ├── start.ts        # spawn the detached daemon, open the browser
│   │   ├── stop.ts         # SIGTERM with a grace window, then SIGKILL
│   │   ├── status.ts       # read the status file, optionally enrich via /api/system/status
│   │   ├── logs.ts         # tail vina.log
│   │   ├── reset.ts        # POST /api/system/reset (requires the daemon to be running)
│   │   └── doctor.ts       # diagnostics
│   └── lib/
│       ├── api.ts          # bearer-token HTTP helper used by status/reset
│       ├── browser.ts      # via `open` package
│       ├── pid.ts          # read/write/check PID file
│       └── status.ts       # read the status JSON; poll for it during start
└── package.json
```

`package.json` declares `"bin": { "vina": "./dist/bin.js" }`.

## 2. Commands

### `vina start`

Flags:
- `--no-browser` — do not open the browser tab

Deferred (M23, see §14): `--port`, `--headful`, `--log-level`.

Behaviour:
1. Read PID file. If a daemon is already running and responsive, print "Vina is already running at http://127.0.0.1:<port>" and open the browser (unless `--no-browser`). Exit 0
2. If PID file exists but the process is gone, clean it up _(deferred — current code prints an error instead)_
3. Spawn the server as a detached child process via `child_process.spawn(node, [serverEntry], { detached: true, stdio: ['ignore', logFile, logFile] })`. The server's main entry is resolved through Node module resolution (`import.meta.resolve('@vina/server/main')`)
4. Wait up to 15 seconds for the server to write `vina.status`. _(Spinner is deferred — see §8.)_
5. If status appears: read the URL, open the browser, print the URL, exit 0
6. If timeout: print an error pointing at the log file, exit 1. _(Killing the child + printing tail of log is deferred.)_

### `vina stop`

No flags. _(`--force` deferred — see §14.)_

Behaviour:
1. Read PID file. If absent or the PID is not alive, print "Vina is not running." Exit 0 (a stale PID file is cleaned up before exiting)
2. Send `SIGTERM`. Wait up to 30s for the process to exit
3. If still alive after timeout: send `SIGKILL`
4. Delete `vina.pid`. The daemon is responsible for deleting `vina.status` during its own graceful shutdown; if `SIGKILL` was needed the status file may be left behind and is treated as stale on the next `vina status` call
5. Print "Stopped." Exit 0

### `vina status`

No flags.

Behaviour:
1. Read PID file and status file
2. If neither exists, or the PID is not alive: print "Vina is not running." Exit 0
3. Otherwise print a single-line summary plus a few follow-up lines:

```
Vina v0.1.0 on http://127.0.0.1:7341 (pid 12345)
Started: 2026-04-26T13:21:00.000Z
Scheduler: running
Queue: 3 pending, 1 running
Provider: anthropic/claude-opus-4-7
```

The richer fields (Scheduler, Queue, Provider) come from a best-effort HTTP call to `/api/system/status` — the CLI fetches the bearer token via `/api/bootstrap` rather than reading it from the status file. If that call fails (server hung mid-shutdown, network blip), the basic line still prints and the failure is reported on stderr.

_(Differentiating "stale PID file" from "not running" is deferred — see §14.)_

### `vina logs`

Flags:
- `--follow`, `-f` — tail the log
- `--lines <n>`, `-n <n>` — number of lines to print (default 200)

Behaviour:
1. Resolve `logs/vina.log` from the data dir. If the file is missing, print a friendly message naming the path and exit 0 (the daemon hasn't run yet)
2. Print the last `--lines` lines, optionally `tail -f`-style via `fs.watchFile` polling. The watcher handles log rotation by detecting size shrinkage and resetting its read offset to 0
3. With `--follow`, run until SIGINT or SIGTERM; without it, exit 0 after printing

### `vina reset`

Flags:
- `--yes`, `-y` — skip confirmation

Deferred (see §14): `--keep-sessions`.

Behaviour:
1. If the daemon is **not** running: print "Vina is not running. Run `vina start` first." Exit 3. Reset goes through the live daemon so DB truncation is transactional — see [decisions.md ADR-010](./decisions.md) and the rationale below
2. Confirm with the user unless `--yes`. The confirmation prompt requires typing `yes`
3. Send `POST /api/system/reset` with `{ "confirm": "reset" }`. The server truncates every data table inside a single transaction and clears the contents of `files/` and `sessions/` on disk (the directories are kept so subsequent writes succeed). The vault master key is **not** cleared today — see [DEFERRED.md](../DEFERRED.md)
4. Print "All Vina data has been wiped." Exit 0
5. On daemon-side failure (network blip, `DaemonNotRunningError` mid-flight), exit 3 if the daemon disappeared, otherwise 1

**Why through the daemon?** The CLI used to be specced as offline file deletion (`rm vina.db`, etc.). The current model — POSTing to a route handler — gets transactional table truncation (a partial reset can't leave the DB in a half-empty state) and centralises the file-cleanup policy in one place. The trade-off is that the daemon must be running.

### `vina doctor`

No flags.

Diagnostics — runs and prints the status of:
- Node version (>= 20)
- Playwright browser binaries installed
- Data directory writable
- Disk space available
- `keytar` availability (informational; absence is fine)
- Whether ports 7341–7350 are reachable
- Daemon reachability (informational; if a daemon is running, confirms `/api/bootstrap` responds with the matching token)
- SerpAPI key validity (only if a key is configured in settings — runs the same minimal Google Jobs probe used by the settings route)

Exits 0 if all checks pass, 1 otherwise. Informational checks (daemon reachable when nothing is running, missing SerpAPI key when Google Jobs is disabled) do not fail the run.

**Status.** The current implementation in [packages/cli/src/commands/doctor.ts](packages/cli/src/commands/doctor.ts) covers Node version, Playwright resolvable (the package, not the browser binaries), data directory writable, and daemon reachability. The remaining checks — Playwright browser binaries, disk space, port reachability, `keytar` availability, and SerpAPI key validity — land in M23 per `docs/build-order.md`. The deferred checks fail closed (skipped, not reported as failures) until that milestone.

## 3. Process Model

Vina uses a "fire and forget" detached child:

```ts
const child = spawn(process.execPath, [serverEntry], {
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: { ...process.env, NODE_ENV: 'production' },
});
child.unref();
writePidFile(child.pid); // mode 0600
```

`NODE_ENV=production` switches the shared pino logger from pretty-printing to JSON output, which is what should land in `vina.log`. Once the deferred `--port` / `--log-level` flags ship, the spawn env will also carry `VINA_PORT` and `VINA_LOG_LEVEL`.

The CLI process exits as soon as the daemon is confirmed running (status file appears). The daemon owns its own logging, signal handling, and shutdown — see `backend-designer.md`.

We do not depend on PM2 — adding it as a runtime dep is heavy for what's essentially a single-process tool. The few features it would offer (auto-restart on crash) are not desirable in MVP: a crash should surface to the user, not silently restart.

## 4. PID File Semantics

`vina.pid` contents: a single integer. Permissions: `0600`.

Liveness check: `process.kill(pid, 0)` — throws `ESRCH` if the process is gone, succeeds (or throws `EPERM`, treated as alive) otherwise. The `EPERM` branch handles the rare case where the OS reuses a PID for a process owned by another user.

PID-reuse defence by cross-checking `started_at` against `vina.status` is **deferred** — see §14.

## 5. Status File

`vina.status` JSON, written by the daemon at startup, deleted at shutdown:

```json
{
  "port": 7341,
  "version": "0.1.0",
  "started_at": "2026-04-26T13:21:00.000Z",
  "pid": 12345
}
```

Permissions: `0600`.

The bearer token is **not** written to the status file — anything that needs to call the API fetches it via `GET /api/bootstrap` (see [packages/cli/src/lib/api.ts](../packages/cli/src/lib/api.ts)). Keeping the token out of an on-disk file simplifies the threat model: the only places it ever lives are server memory and the browser tab that loaded it.

## 6. Port Selection

Default port is 7341, configurable via the `VINA_PORT` env var (read by the server's [config.ts](../packages/server/src/config.ts)). If the port is unavailable, Fastify throws `EADDRINUSE` on bind and the daemon exits — the CLI surfaces this by reporting the timeout waiting for `vina.status`.

The chosen port is written to the status file and used by `vina status` and `vina start` (already-running path) to construct the browser URL.

Auto-incrementing across a 7341–7350 range is **deferred** — see §14.

## 7. Browser Opening

Use the `open` package (`opn`'s successor). Open the URL once on `vina start`. If the user runs `vina start` while the daemon is already up, the CLI prints the running URL and re-opens the browser (so users can re-open the UI by repeating the command). The `--no-browser` flag suppresses the launch in both paths.

## 8. Output Style

The CLI uses plain `process.stdout.write` and `process.stderr.write` with no colours, no spinners, and no Unicode glyphs. Output is short, declarative, and machine-friendly — suitable for piping to `tee`, parsing in scripts, and CI logs.

A future polish pass may introduce `chalk` (colours) and `ora` (spinners during `start`/`stop`) — see §14. Until then, this section documents the deliberate choice not to add those deps.

## 9. Exit Codes

| Code | Meaning                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success — including `vina start` against an already-running daemon (we open the browser and exit happy) and `vina stop` against an already-stopped daemon |
| 1    | General error (with a descriptive message on stderr)                                                                                |
| 3    | Daemon required but not running. Used by `vina reset`. Codes 2 and 4 from the original draft are reserved but currently unused      |

## 10. Development Behaviour

`pnpm dev` at the workspace root runs the server and web packages directly (`tsx watch packages/server/src/main.ts` for the API, Vite for the frontend). It **bypasses the CLI entirely** — the CLI is the production entry, and the dev runner is a faster path that watches for source changes.

This is intentional: the CLI is a thin wrapper, and going through `spawn(detached)` adds friction (separate process, separate logs) that hurts the dev loop. A foreground-CLI mode gated by `VINA_DEV=1` was specced earlier but has not been needed; if it ever is, it can land as a future enhancement.

## 11. Auto-Update

Out of scope for MVP. Users update with `npm i -g vina@latest`. Surfacing "installed vs latest registry version" inside `vina doctor` is a nice-to-have — see §14.

## 12. Testing

- Unit tests for path resolution and status-file parsing
- Integration tests run actual `vina start` against a stub server entrypoint (so they don't require Playwright); they assert PID file, status file, and `vina stop` behaviour
- Smoke test in CI runs `vina start && curl /api/bootstrap && vina stop`

## 13. Public Behaviour Recap

```bash
$ vina start
Vina started on http://127.0.0.1:7341 (pid 12345, version 0.1.0)
Logs: ~/Library/Application Support/vina/logs/vina.log

$ vina status
Vina v0.1.0 on http://127.0.0.1:7341 (pid 12345)
Started: 2026-04-26T13:21:00.000Z
Scheduler: running
Queue: 3 pending, 1 running
Provider: anthropic/claude-opus-4-7

$ vina logs -f
{"level":30,"time":1714137660123,"module":"server","msg":"listening on 127.0.0.1:7341"}
{"level":30,"time":1714137660456,"module":"scheduler","msg":"next run at 2026-04-26T18:00:00Z"}
...

$ vina stop
Stopping Vina (pid 12345)…
Stopped.
```

## 14. Deferred items

These are documented commitments from earlier drafts that have not yet been implemented. Most are minor UX polish; track them in [DEFERRED.md](../DEFERRED.md) when picking up.

| Item                                                          | Section | Notes                                                                            |
| ------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------- |
| `vina start` flags: `--port`, `--headful`, `--log-level`      | §2      | Will set `VINA_PORT` / `VINA_LOG_LEVEL` / `settings.browser_headful` for the run |
| `vina start` cleans up a stale PID file before spawning       | §2      | Today it errors out; should silently reclaim                                     |
| `vina start` kills the child + tails the log on startup timeout | §2     | Today it just reports the timeout                                                |
| `vina stop --force`                                           | §2      | SIGKILL after a 5s grace window                                                  |
| `vina status` differentiates "stale PID" from "not running"   | §2      | Today both produce the same message                                              |
| `vina reset --keep-sessions`                                  | §2      | Preserves Playwright session storage so the user doesn't have to re-login        |
| Spinner during `start`/`stop`                                 | §2, §8  | `ora` dep                                                                        |
| Coloured / glyphed CLI output                                 | §8      | `chalk` dep + `✔`/`✖`/`▲` prefixes                                               |
| Port range fallback 7341–7350                                 | §6      | Currently the daemon errors on `EADDRINUSE`                                      |
| PID-reuse defence via `started_at` cross-check                | §4      | Catches OS PID reuse on long-uptime machines                                     |
| Auto-update freshness check in `vina doctor`                  | §11     | One fetch to the npm registry                                                    |
| Foreground-CLI dev mode gated by `VINA_DEV=1`                 | §10     | Today `pnpm dev` bypasses the CLI                                                |