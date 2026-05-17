---
name: vina-installer
description: Use this skill when the user wants to write, edit, debug, or extend Vina's one-line install scripts — the `install.sh` users curl-pipe-bash on macOS/Linux/WSL, and the `install.ps1` users iwr-iex on Windows. Covers the distribution model (GitHub Releases tarballs, not the npm registry), bootstrapping Node ≥ 20, pnpm, and Playwright Chromium, dropping a `vina` wrapper into PATH, version pinning, dry-run support, and upgrade detection. Also use it whenever someone asks how to ship Vina without `npm publish`, wants a Windows install script, or says "one-liner install for Vina".
---

# Vina Installer

This document defines how Vina's two install scripts are designed and maintained:

- `scripts/install.sh` — bash, served at `https://vina.ai/install.sh`, run via `curl -fsSL https://vina.ai/install.sh | bash`
- `scripts/install.ps1` — PowerShell, served at `https://vina.ai/install.ps1`, run via `powershell -c "irm https://vina.ai/install.ps1 | iex"`

The user-facing contract: one of those two commands, run in a clean shell, leaves the user with a working `vina` binary on their PATH, with Node, pnpm, and Playwright's Chromium ready to go. Neither script depends on npm being a primary distribution channel — Vina is distributed as a GitHub Release tarball, not an npm package.

## 1. Distribution model

Vina ships as a single asset per release on GitHub:

```
https://github.com/<org>/vina/releases/download/v<X.Y.Z>/vina-<X.Y.Z>.tar.gz
```

The tarball contains the prebuilt monorepo: every workspace's `dist/`, every `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and the React app's built static assets. It does **not** contain `node_modules/` — those are installed on the user's machine so native modules (`better-sqlite3`) and Playwright resolve correctly for the user's OS, libc, and Node version.

The installer's job on the user's machine is, in order:

1. Make sure Node ≥ 20 is on PATH (install if missing).
2. Make sure pnpm is on PATH (activate via Corepack).
3. Download `vina-<X.Y.Z>.tar.gz` to a temp dir and extract to the install root.
4. `pnpm install --prod --frozen-lockfile` inside the install root — fetches runtime deps only, no build step.
5. `pnpm exec playwright install chromium` — Playwright stores its browser outside `node_modules`, so this is a separate step.
6. Write a wrapper shim that execs `node <install-root>/packages/cli/dist/bin.js`.
7. Ensure the wrapper's directory is on PATH (persisted into shell rc files on Unix; into the user PATH environment variable on Windows).

Rejected alternatives:

- **Publishing to npm**: out of scope. Vina is not on the npm registry. The CLI is not an `npx` target.
- **Single static binary** (Bun compile, Node SEA, `pkg`): rejected because `better-sqlite3` is fragile to bundle across glibc versions, and Playwright's Chromium is hundreds of MB and per-OS, so the binary approach offers no real size or speed win.
- **Git clone and build on the user's machine**: rejected for end users because `pnpm build` on a typed monorepo takes minutes and depends on devDependencies. Available behind `--dev` for contributors only.

## 2. Install paths

| Path | macOS / Linux | Windows |
|---|---|---|
| Install root | `~/.vina/app/<version>` | `%LOCALAPPDATA%\Vina\app\<version>` |
| Current pointer | `~/.vina/app/current` (symlink) | `%LOCALAPPDATA%\Vina\app\current` (directory junction) |
| Wrapper | `~/.local/bin/vina` | `%USERPROFILE%\.local\bin\vina.cmd` |
| Temp scratch | `$(mktemp -d)` | `$env:TEMP\vina-install-<guid>` |
| Vina data (owned by the daemon, not the installer) | `~/.local/share/vina` (Linux), `~/Library/Application Support/vina` (macOS) | `%APPDATA%\vina` |

The `current` pointer is what the wrapper resolves through. Upgrades extract the new version side-by-side, then atomically flip `current` to point to the new version. Rollback is `ln -sfn ~/.vina/app/v0.1.0 ~/.vina/app/current`.

The installer never touches the data directory. The first `vina start` creates that on demand.

## 3. install.sh

A complete working skeleton. Save as `scripts/install.sh`, `chmod +x`, serve at `https://vina.ai/install.sh`.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Vina installer — macOS / Linux / WSL
# Usage:
#   curl -fsSL https://vina.ai/install.sh | bash
#   curl -fsSL https://vina.ai/install.sh | bash -s -- --version v0.2.0
#   curl -fsSL https://vina.ai/install.sh | bash -s -- --dry-run --no-onboard

# ─── Config ─────────────────────────────────────────────────────────────────
VINA_REPO="${VINA_REPO:-your-org/vina}"
VINA_INSTALL_ROOT="${VINA_INSTALL_ROOT:-$HOME/.vina/app}"
VINA_BIN_DIR="${VINA_BIN_DIR:-$HOME/.local/bin}"
NODE_MIN_MAJOR=20
PNPM_VERSION="9.15.0"           # must match packageManager in tarball's root package.json
INSTALLER_VERSION="2026.05.15"  # bump on every script change; printed by vina doctor

# ─── Colors ─────────────────────────────────────────────────────────────────
if [[ -t 1 ]] && [[ "${NO_COLOR:-}" == "" ]]; then
    C_DIM='\033[2m'; C_BOLD='\033[1m'; C_RESET='\033[0m'
    C_CYAN='\033[38;5;39m'; C_GREEN='\033[38;5;42m'
    C_YELLOW='\033[38;5;214m'; C_RED='\033[38;5;203m'
else
    C_DIM=''; C_BOLD=''; C_RESET=''; C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''
fi
log()   { printf "${C_DIM}·${C_RESET} %s\n" "$*"; }
ok()    { printf "${C_GREEN}✓${C_RESET} %s\n" "$*"; }
warn()  { printf "${C_YELLOW}▲${C_RESET} %s\n" "$*" >&2; }
err()   { printf "${C_RED}✖${C_RESET} %s\n" "$*" >&2; }
stage() { printf "\n${C_CYAN}${C_BOLD}==> %s${C_RESET}\n" "$*"; }

# ─── Don't run as root ──────────────────────────────────────────────────────
if [[ "$(id -u)" == "0" ]] && [[ -z "${ALLOW_ROOT:-}" ]]; then
    err "Don't run this installer as root."
    err "It installs into your home directory and uses sudo only when needed."
    exit 1
fi

# ─── Temp cleanup ───────────────────────────────────────────────────────────
TMPDIRS=()
cleanup() { for d in "${TMPDIRS[@]:-}"; do rm -rf "$d" 2>/dev/null || true; done; }
trap cleanup EXIT
mktmp() { local d; d="$(mktemp -d)"; TMPDIRS+=("$d"); echo "$d"; }

# ─── CLI args ───────────────────────────────────────────────────────────────
VERSION="latest"
DRY_RUN=0
NO_ONBOARD=0
NO_PLAYWRIGHT=0
VERBOSE=0
DEV_MODE=0
FORCE=0

print_help() {
cat <<EOF
Vina installer

Usage: install.sh [options]

  --version <tag>        Install a specific release (default: latest)
  --dry-run              Print plan and exit
  --no-onboard           Don't auto-start vina after install
  --no-playwright        Skip Chromium download (run 'vina doctor' later to install)
  --force                Reinstall even if already at requested version
  --dev                  Clone from git and build locally (contributors only)
  --verbose, -v          Show full command output
  --help, -h             Show this message
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)        VERSION="$2"; shift 2 ;;
        --dry-run)        DRY_RUN=1; shift ;;
        --no-onboard)     NO_ONBOARD=1; shift ;;
        --no-playwright)  NO_PLAYWRIGHT=1; shift ;;
        --force)          FORCE=1; shift ;;
        --dev)            DEV_MODE=1; shift ;;
        --verbose|-v)     VERBOSE=1; shift ;;
        --help|-h)        print_help; exit 0 ;;
        *)                err "Unknown flag: $1"; print_help; exit 2 ;;
    esac
done

# ─── Banner ─────────────────────────────────────────────────────────────────
printf "\n${C_CYAN}${C_BOLD}  Vina${C_RESET}\n"
printf "${C_DIM}  Local AI job application assistant${C_RESET}\n\n"

# ─── Run a step (quiet by default, full output with --verbose) ──────────────
step() {
    local title="$1"; shift
    if [[ "$VERBOSE" == "1" ]]; then
        log "$title"
        "$@"
        return $?
    fi
    local logfile
    logfile="$(mktemp)"
    TMPDIRS+=("$logfile")
    if "$@" >"$logfile" 2>&1; then
        ok "$title"
        return 0
    fi
    err "$title failed"
    tail -n 60 "$logfile" >&2 || true
    return 1
}

# ─── OS detect ──────────────────────────────────────────────────────────────
case "${OSTYPE:-}" in
    darwin*) OS="macos" ;;
    linux-gnu*|linux-musl*) OS="linux" ;;
    *)
        if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
            OS="linux"
        else
            err "Unsupported OS: ${OSTYPE:-unknown}"
            err "Vina supports macOS and Linux (including WSL). For Windows, use install.ps1."
            exit 1
        fi
        ;;
esac
ok "Detected: $OS"

# ─── Downloader ─────────────────────────────────────────────────────────────
if command -v curl >/dev/null 2>&1; then
    download() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 1 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
    download() { wget -q --https-only --secure-protocol=TLSv1_2 --tries=3 -O "$2" "$1"; }
else
    err "Need curl or wget."
    exit 1
fi

# ─── Node ───────────────────────────────────────────────────────────────────
node_major() {
    command -v node >/dev/null 2>&1 || return 1
    local v; v="$(node -v 2>/dev/null | sed 's/^v//;s/\..*$//')"
    [[ "$v" =~ ^[0-9]+$ ]] || return 1
    echo "$v"
}

check_node() {
    local major; major="$(node_major)" || return 1
    [[ "$major" -ge "$NODE_MIN_MAJOR" ]]
}

install_node_macos() {
    if ! command -v brew >/dev/null 2>&1; then
        warn "Homebrew not found — installing"
        step "Installing Homebrew" bash -c \
            '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
        [[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
        [[ -x /usr/local/bin/brew   ]] && eval "$(/usr/local/bin/brew shellenv)"
    fi
    step "Installing Node.js via Homebrew" brew install "node@${NODE_MIN_MAJOR}"
    brew link --overwrite "node@${NODE_MIN_MAJOR}" >/dev/null 2>&1 || true
}

install_node_linux() {
    if command -v apt-get >/dev/null 2>&1; then
        step "Updating apt" sudo apt-get update -qq
        step "Installing Node via NodeSource" bash -c "
            curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x | sudo -E bash -
            sudo apt-get install -y -qq nodejs
        "
    elif command -v dnf >/dev/null 2>&1; then
        step "Installing Node" sudo dnf install -y -q "nodejs${NODE_MIN_MAJOR}"
    elif command -v pacman >/dev/null 2>&1; then
        step "Installing Node" sudo pacman -Sy --noconfirm nodejs npm
    elif command -v apk >/dev/null 2>&1; then
        step "Installing Node" sudo apk add --no-cache nodejs
    else
        err "Could not detect package manager. Install Node ${NODE_MIN_MAJOR}+ from https://nodejs.org and re-run."
        exit 1
    fi
}

ensure_node() {
    if check_node; then
        ok "Node $(node -v)"
        return 0
    fi
    warn "Node ${NODE_MIN_MAJOR}+ not found; installing"
    if [[ "$OS" == "macos" ]]; then install_node_macos; else install_node_linux; fi
    hash -r
    if ! check_node; then
        err "Node install completed but 'node' is still not on PATH in this shell."
        err "Open a new terminal and re-run this script."
        exit 1
    fi
    ok "Node $(node -v)"
}

# ─── Build tools (for better-sqlite3 source-build fallback) ─────────────────
install_build_tools_linux() {
    if command -v apt-get >/dev/null 2>&1; then
        step "Installing build tools" sudo apt-get install -y -qq build-essential python3 make g++
    elif command -v dnf >/dev/null 2>&1; then
        step "Installing build tools" sudo dnf install -y -q gcc gcc-c++ make python3
    elif command -v pacman >/dev/null 2>&1; then
        step "Installing build tools" sudo pacman -Sy --noconfirm base-devel python make gcc
    elif command -v apk >/dev/null 2>&1; then
        step "Installing build tools" sudo apk add --no-cache build-base python3
    else
        warn "Couldn't detect package manager for build tools — skipping"
    fi
}

install_build_tools_macos() {
    if ! xcode-select -p >/dev/null 2>&1; then
        warn "Xcode Command Line Tools not installed"
        xcode-select --install >/dev/null 2>&1 || true
        err "Complete the macOS installer dialog, then re-run this script."
        exit 1
    fi
}

log_needs_build_tools() {
    local logfile="$1"
    [[ -f "$logfile" ]] || return 1
    grep -Eiq "gyp ERR|node-gyp|python.*not found|make.*not found|no developer tools" "$logfile"
}

# ─── pnpm via Corepack ──────────────────────────────────────────────────────
ensure_pnpm() {
    if command -v pnpm >/dev/null 2>&1; then
        ok "pnpm $(pnpm -v)"
        return 0
    fi
    log "Activating pnpm@${PNPM_VERSION} via Corepack"
    corepack enable >/dev/null 2>&1 || true
    if ! corepack prepare "pnpm@${PNPM_VERSION}" --activate >/dev/null 2>&1; then
        warn "corepack prepare failed; trying 'corepack install'"
        corepack install -g "pnpm@${PNPM_VERSION}" >/dev/null 2>&1 || true
    fi
    hash -r
    if ! command -v pnpm >/dev/null 2>&1; then
        err "pnpm bootstrap failed. Install manually: npm install -g pnpm@${PNPM_VERSION}"
        exit 1
    fi
    ok "pnpm $(pnpm -v)"
}

# ─── Resolve release tag ────────────────────────────────────────────────────
resolve_version() {
    if [[ "$VERSION" != "latest" ]]; then
        case "$VERSION" in
            v*) echo "$VERSION" ;;
            *)  echo "v${VERSION}" ;;
        esac
        return 0
    fi
    # GitHub redirects /releases/latest to /releases/tag/<tag>
    local final
    final="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
        "https://github.com/${VINA_REPO}/releases/latest" 2>/dev/null | sed 's|.*/||')" || true
    if [[ -z "$final" ]]; then
        err "Could not resolve latest version from GitHub."
        err "Pass an explicit tag: --version v0.1.0"
        exit 1
    fi
    echo "$final"
}

# ─── Existing install ───────────────────────────────────────────────────────
current_installed_version() {
    local current="${VINA_INSTALL_ROOT}/current"
    [[ -L "$current" ]] || return 1
    local target; target="$(readlink "$current")"
    basename "$target"
}

# ─── Download + extract ─────────────────────────────────────────────────────
download_and_extract() {
    local tag="$1" dest="$2"
    local stripped="${tag#v}"
    local url="https://github.com/${VINA_REPO}/releases/download/${tag}/vina-${stripped}.tar.gz"
    local tmp; tmp="$(mktmp)"

    step "Downloading vina ${tag}" download "$url" "${tmp}/vina.tar.gz"
    mkdir -p "$dest"
    step "Extracting" tar -xzf "${tmp}/vina.tar.gz" -C "$dest" --strip-components=1
}

# ─── pnpm install (with build-tools retry on native-module failure) ────────
install_runtime_deps() {
    local dir="$1"
    local logfile; logfile="$(mktemp)"; TMPDIRS+=("$logfile")
    if pnpm -C "$dir" install --prod --frozen-lockfile >"$logfile" 2>&1; then
        ok "Runtime dependencies installed"
        return 0
    fi
    if log_needs_build_tools "$logfile"; then
        warn "Native build tools missing; installing and retrying"
        if [[ "$OS" == "macos" ]]; then install_build_tools_macos; else install_build_tools_linux; fi
        step "Installing runtime dependencies" pnpm -C "$dir" install --prod --frozen-lockfile
        return $?
    fi
    err "pnpm install failed"
    tail -n 60 "$logfile" >&2 || true
    return 1
}

# ─── Playwright Chromium ────────────────────────────────────────────────────
install_chromium() {
    local dir="$1"
    if [[ "$NO_PLAYWRIGHT" == "1" ]]; then
        warn "Skipping Chromium download (--no-playwright). Run 'vina doctor' to install later."
        return 0
    fi
    step "Downloading Chromium for Playwright (~250 MB)" \
        pnpm -C "$dir" exec playwright install chromium
}

# ─── Wrapper script ─────────────────────────────────────────────────────────
write_wrapper() {
    local install_root="$1"
    local target="${install_root}/current/packages/cli/dist/bin.js"
    mkdir -p "$VINA_BIN_DIR"
    local wrapper="${VINA_BIN_DIR}/vina"
    cat > "$wrapper" <<EOF
#!/usr/bin/env bash
# Vina wrapper — generated by install.sh ${INSTALLER_VERSION}
set -euo pipefail
exec node "${target}" "\$@"
EOF
    chmod +x "$wrapper"
    ok "Wrapper installed at ${wrapper}"
}

# ─── current symlink (atomic upgrade-flip) ──────────────────────────────────
update_current() {
    local versioned="$1"
    local current="${VINA_INSTALL_ROOT}/current"
    ln -sfn "$versioned" "$current"
}

# ─── PATH housekeeping ──────────────────────────────────────────────────────
ensure_path() {
    case ":${PATH}:" in
        *":${VINA_BIN_DIR}:"*) return 0 ;;
    esac
    local line="export PATH=\"\$HOME/.local/bin:\$PATH\""
    local touched=0
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
        [[ -f "$rc" ]] || continue
        if ! grep -Fq "$line" "$rc"; then
            printf '\n# Added by Vina installer\n%s\n' "$line" >> "$rc"
        fi
        touched=1
    done
    [[ "$touched" == "1" ]] || printf '%s\n' "$line" >> "$HOME/.bashrc"
    warn "Added ${VINA_BIN_DIR} to PATH — open a new shell or run: source ~/.bashrc"
    export PATH="${VINA_BIN_DIR}:${PATH}"
}

# ─── Stop running daemon before upgrade ─────────────────────────────────────
stop_existing_daemon() {
    command -v vina >/dev/null 2>&1 || return 0
    vina stop >/dev/null 2>&1 || true
}

# ─── Main ───────────────────────────────────────────────────────────────────
main() {
    local tag; tag="$(resolve_version)"
    local versioned="${VINA_INSTALL_ROOT}/${tag}"

    stage "Install plan"
    printf "  ${C_DIM}OS:${C_RESET}          %s\n" "$OS"
    printf "  ${C_DIM}Version:${C_RESET}     %s\n" "$tag"
    printf "  ${C_DIM}Install dir:${C_RESET} %s\n" "$versioned"
    printf "  ${C_DIM}Wrapper:${C_RESET}     %s/vina\n" "$VINA_BIN_DIR"

    local existing; existing="$(current_installed_version || true)"
    if [[ -n "$existing" && "$existing" == "$tag" && "$FORCE" == "0" ]]; then
        ok "Already at ${tag}. Pass --force to reinstall."
        exit 0
    fi
    if [[ -n "$existing" ]]; then
        printf "  ${C_DIM}Existing:${C_RESET}    %s → %s\n" "$existing" "$tag"
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
        ok "Dry run — no changes made"
        exit 0
    fi

    stage "Preparing environment"
    ensure_node
    ensure_pnpm

    stage "Installing Vina ${tag}"
    stop_existing_daemon
    download_and_extract "$tag" "$versioned"
    install_runtime_deps "$versioned"
    install_chromium "$versioned"
    update_current "$versioned"
    write_wrapper "$VINA_INSTALL_ROOT"
    ensure_path

    stage "Done"
    ok "Vina ${tag} installed"
    printf "\n  Next: ${C_BOLD}vina start${C_RESET}\n\n"

    if [[ "$NO_ONBOARD" != "1" ]] && [[ -r /dev/tty && -w /dev/tty ]]; then
        exec "${VINA_BIN_DIR}/vina" start
    fi
}

main
```

## 4. install.ps1

Save as `scripts/install.ps1`, serve at `https://vina.ai/install.ps1`.

```powershell
# Vina installer — Windows
# Usage:
#   powershell -c "irm https://vina.ai/install.ps1 | iex"
#   powershell -c "& ([scriptblock]::Create((irm https://vina.ai/install.ps1))) -Version v0.2.0 -DryRun"

param(
    [string]$Version = "latest",
    [string]$InstallDir,
    [switch]$DryRun,
    [switch]$NoOnboard,
    [switch]$NoPlaywright,
    [switch]$Force,
    [switch]$Dev
)

$ErrorActionPreference = "Stop"

# ─── Config ─────────────────────────────────────────────────────────────────
$Repo = if ($env:VINA_REPO) { $env:VINA_REPO } else { "your-org/vina" }
$NodeMinMajor = 20
$PnpmVersion = "9.15.0"
$InstallerVersion = "2026.05.15"

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $InstallDir = Join-Path $env:LOCALAPPDATA "Vina\app"
}
$BinDir = Join-Path $env:USERPROFILE ".local\bin"

# ─── Output helpers ─────────────────────────────────────────────────────────
function Write-Stage($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[!]  $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "[x]  $msg" -ForegroundColor Red }
function Write-Log($msg)   { Write-Host " .  $msg" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "  Vina" -ForegroundColor Cyan
Write-Host "  Local AI job application assistant" -ForegroundColor DarkGray
Write-Host ""

# PowerShell 5+ required (built into Windows 10/11)
if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Err "PowerShell 5 or newer is required (Windows 10/11)."
    exit 1
}

# ─── PATH refresh helper ────────────────────────────────────────────────────
function Sync-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path","User")
}

# ─── Node ───────────────────────────────────────────────────────────────────
function Get-NodeMajor {
    try {
        $v = (node -v 2>$null)
        if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
    } catch { }
    return 0
}

function Test-Node { (Get-NodeMajor) -ge $NodeMinMajor }

function Install-Node {
    Write-Warn "Node $NodeMinMajor+ not found; installing"
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Log "Using winget"
        winget install OpenJS.NodeJS.LTS --silent `
            --accept-package-agreements --accept-source-agreements | Out-Null
    } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Log "Using Chocolatey"
        choco install nodejs-lts -y | Out-Null
    } elseif (Get-Command scoop -ErrorAction SilentlyContinue) {
        Write-Log "Using Scoop"
        scoop install nodejs-lts | Out-Null
    } else {
        Write-Err "No package manager (winget/choco/scoop) found."
        Write-Err "Install Node $NodeMinMajor+ from https://nodejs.org and re-run."
        exit 1
    }
    Sync-Path
    if (-not (Test-Node)) {
        Write-Err "Node installed but not yet on PATH in this shell."
        Write-Err "Close this terminal, open a new one, and re-run the installer."
        exit 1
    }
    Write-Ok "Node $(node -v)"
}

function Ensure-Node {
    if (Test-Node) { Write-Ok "Node $(node -v)"; return }
    Install-Node
}

# ─── pnpm ───────────────────────────────────────────────────────────────────
function Ensure-Pnpm {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        Write-Ok "pnpm $(pnpm -v)"; return
    }
    Write-Log "Activating pnpm@$PnpmVersion via Corepack"
    try { corepack enable | Out-Null } catch { }
    try {
        corepack prepare "pnpm@$PnpmVersion" --activate | Out-Null
    } catch {
        Write-Warn "corepack prepare failed; trying corepack install"
        try { corepack install -g "pnpm@$PnpmVersion" | Out-Null } catch { }
    }
    Sync-Path
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Write-Err "pnpm bootstrap failed. Install manually: npm install -g pnpm@$PnpmVersion"
        exit 1
    }
    Write-Ok "pnpm $(pnpm -v)"
}

# ─── Resolve release tag ────────────────────────────────────────────────────
function Resolve-Version([string]$wanted) {
    if ($wanted -ne "latest") {
        if ($wanted -notmatch '^v') { return "v$wanted" } else { return $wanted }
    }
    $api = "https://api.github.com/repos/$Repo/releases/latest"
    $headers = @{ "User-Agent" = "vina-installer"; "Accept" = "application/vnd.github+json" }
    try {
        return (Invoke-RestMethod -Uri $api -Headers $headers).tag_name
    } catch {
        Write-Err "Could not resolve latest version from GitHub: $($_.Exception.Message)"
        Write-Err "Pass an explicit tag: -Version v0.1.0"
        exit 1
    }
}

# ─── Existing install ───────────────────────────────────────────────────────
function Get-CurrentVersion {
    $current = Join-Path $InstallDir "current"
    if (-not (Test-Path $current)) { return $null }
    $item = Get-Item $current -Force
    if ($item.LinkType -notin @("Junction", "SymbolicLink")) { return $null }
    return (Split-Path -Leaf $item.Target[0])
}

# ─── Download + extract ─────────────────────────────────────────────────────
function Download-AndExtract([string]$tag, [string]$dest) {
    $stripped = $tag.TrimStart('v')
    $url = "https://github.com/$Repo/releases/download/$tag/vina-$stripped.tar.gz"
    $tmp = Join-Path $env:TEMP ("vina-install-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $tarPath = Join-Path $tmp "vina.tar.gz"

    try {
        Write-Log "Downloading $tag"
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $tarPath -UseBasicParsing
        Write-Ok "Downloaded"

        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        # tar.exe ships with Windows 10 build 17063+ and Windows 11
        Write-Log "Extracting"
        & tar -xzf $tarPath -C $dest --strip-components=1
        if ($LASTEXITCODE -ne 0) { throw "tar exited with $LASTEXITCODE" }
        Write-Ok "Extracted"
    } finally {
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    }
}

# ─── Runtime deps + Chromium ────────────────────────────────────────────────
function Install-RuntimeDeps([string]$dir) {
    Write-Log "Installing runtime dependencies"
    Push-Location $dir
    try {
        $prev = $env:NPM_CONFIG_SCRIPT_SHELL
        $env:NPM_CONFIG_SCRIPT_SHELL = "cmd.exe"
        try { pnpm install --prod --frozen-lockfile } finally { $env:NPM_CONFIG_SCRIPT_SHELL = $prev }
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
    Write-Ok "Runtime dependencies installed"
}

function Install-Chromium([string]$dir) {
    if ($NoPlaywright) {
        Write-Warn "Skipping Chromium download (-NoPlaywright). Run 'vina doctor' to install later."
        return
    }
    Write-Log "Downloading Chromium for Playwright (~250 MB)"
    Push-Location $dir
    try {
        pnpm exec playwright install chromium
        if ($LASTEXITCODE -ne 0) { throw "playwright install failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
    Write-Ok "Chromium installed"
}

# ─── Wrapper .cmd ───────────────────────────────────────────────────────────
function Write-Wrapper {
    if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Force -Path $BinDir | Out-Null }
    $wrapper = Join-Path $BinDir "vina.cmd"
    $entry = Join-Path $InstallDir "current\packages\cli\dist\bin.js"
    @"
@echo off
rem Vina wrapper - generated by install.ps1 $InstallerVersion
node "$entry" %*
"@ | Set-Content -Path $wrapper -Encoding ASCII -NoNewline
    Write-Ok "Wrapper installed at $wrapper"
}

# ─── current junction (atomic upgrade-flip) ─────────────────────────────────
function Update-Current([string]$versionedDir) {
    $current = Join-Path $InstallDir "current"
    if (Test-Path $current) {
        # Use cmd /c rmdir to remove junction without following it
        & cmd /c rmdir "$current" 2>$null | Out-Null
    }
    New-Item -ItemType Junction -Path $current -Target $versionedDir -Force | Out-Null
}

# ─── PATH housekeeping ──────────────────────────────────────────────────────
function Ensure-PathEntry {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($userPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($entries | Where-Object { $_ -ieq $BinDir }) { return }
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$BinDir", "User")
    Sync-Path
    Write-Warn "Added $BinDir to user PATH — open a new terminal if 'vina' not found"
}

# ─── Stop running daemon ────────────────────────────────────────────────────
function Stop-ExistingDaemon {
    if (-not (Get-Command vina -ErrorAction SilentlyContinue)) { return }
    try { & vina stop 2>$null | Out-Null } catch { }
}

# ─── Main ───────────────────────────────────────────────────────────────────
function Main {
    $tag = Resolve-Version $Version
    $versioned = Join-Path $InstallDir $tag

    Write-Stage "Install plan"
    Write-Host "  OS:          Windows" -ForegroundColor DarkGray
    Write-Host "  Version:     $tag" -ForegroundColor DarkGray
    Write-Host "  Install dir: $versioned" -ForegroundColor DarkGray
    Write-Host "  Wrapper:     $(Join-Path $BinDir 'vina.cmd')" -ForegroundColor DarkGray

    $existing = Get-CurrentVersion
    if ($existing -and $existing -eq $tag -and -not $Force) {
        Write-Ok "Already at $tag. Pass -Force to reinstall."
        return
    }
    if ($existing) {
        Write-Host "  Existing:    $existing -> $tag" -ForegroundColor DarkGray
    }

    if ($DryRun) {
        Write-Ok "Dry run — no changes made"
        return
    }

    Write-Stage "Preparing environment"
    Ensure-Node
    Ensure-Pnpm

    Write-Stage "Installing Vina $tag"
    Stop-ExistingDaemon
    Download-AndExtract $tag $versioned
    Install-RuntimeDeps $versioned
    Install-Chromium $versioned
    Update-Current $versioned
    Write-Wrapper
    Ensure-PathEntry

    Write-Stage "Done"
    Write-Ok "Vina $tag installed"
    Write-Host ""
    Write-Host "  Next: vina start" -ForegroundColor Cyan
    Write-Host ""

    if (-not $NoOnboard) {
        & (Join-Path $BinDir "vina.cmd") start
    }
}

Main
```

## 5. Vina-specific gotchas

**Playwright Chromium.** Vina drives a real Chromium browser for LinkedIn and Indeed via Playwright. Playwright stores the browser binary outside `node_modules` (`~/.cache/ms-playwright` on Linux, `~/Library/Caches/ms-playwright` on macOS, `%LOCALAPPDATA%\ms-playwright` on Windows), so it needs its own download step after `pnpm install`. The browser is ~250 MB and per-platform. `--no-playwright` lets the user defer it; `vina doctor` will flag the missing browser later and tell them to run `pnpm -C ~/.vina/app/current exec playwright install chromium`.

**better-sqlite3.** Vina uses `better-sqlite3` for the local database. It ships prebuilt binaries on npm for common Node major versions, so most installs avoid compilation. When prebuilts are missing (older glibc, musl, unusual ABI), it falls back to source build via `node-gyp`, which requires `python3`, `make`, and a C++ compiler. The bash installer detects this from the install log (`gyp ERR` / `node-gyp` / `make: not found`) and runs `install_build_tools_*` then retries. The PowerShell installer does not auto-install build tools because Visual C++ Build Tools is a hefty download with a GUI installer — surface the failure cleanly and point the user at the Microsoft docs.

**Port 7341.** The CLI binds to `localhost:7341` by default and falls back to 7342–7350 if taken. The installer must not open ports, configure firewalls, or write to system service files. The daemon handles all of that.

**Data directory.** The installer never touches `~/.local/share/vina` (or its platform equivalent). The first `vina start` creates it, runs migrations, and writes a fresh `vina.db`. This separation means `--force` reinstall is safe — it never wipes user data.

**Upgrades.** Detect via the `current` symlink's target name. If it matches the requested tag, exit early unless `--force`. If it's an older version, stop the running daemon first (`vina stop || true`), extract the new version side-by-side, flip the symlink, then start again. The Vina CLI's `doctor` command handles any DB migrations the new version needs — the installer does not invoke migrations directly.

**WSL.** Detect via `WSL_DISTRO_NAME` being set, then treat as Linux. Chromium runs headless inside WSL2 without issue; only graphical mode (`--headful` in `vina start`) needs WSLg (Windows 11) or an X server. The installer should not warn about this — `vina doctor` is the right place.

**Sudo.** The installer only needs sudo when installing Node or build tools via the system package manager. The Vina install itself lands entirely in `$HOME` — `~/.vina/app`, `~/.local/bin/vina`, and `~/.bashrc`/`~/.zshrc` additions. The script refuses to run as root (override with `ALLOW_ROOT=1`) because if the user pipes through `sudo bash`, the wrapper ends up owned by root and Corepack/pnpm break in confusing ways downstream.

**Corepack signature bugs.** On Node 20.x the `corepack prepare pnpm@<v> --activate` call may fail with "Cannot find matching keyid" due to a stale signature cache shipped with that Node version. The fallback is `corepack install -g pnpm@<v>` (the older positional form), which the skeletons above already attempt. If both fail, the script gives up cleanly with a manual-install hint.

**Windows ExecutionPolicy.** Piping through `iex` bypasses execution policy and is the documented happy path. If users save `install.ps1` to disk and try to run it directly, they may hit "running scripts is disabled on this system". Document that in the project README:

> If you downloaded `install.ps1` instead of piping it: `powershell -ExecutionPolicy Bypass -File install.ps1`

**No mention of npm in user-facing output.** Search the scripts for `npm` before publishing. The string should not appear in any printed message — only in fallback hint text inside failure paths (e.g. "install pnpm manually: `npm install -g pnpm@9.15.0`"). The advertised install path is curl/iwr; npm is not part of the user's mental model.

## 6. Release pipeline

The installer is only as good as the artifact it downloads. CI on tag push must produce exactly one asset per release:

```
vina-<X.Y.Z>.tar.gz
```

Contents:

```
vina-<X.Y.Z>/
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── packages/
    ├── cli/         (dist/ + package.json)
    ├── server/      (dist/ + migrations/ + package.json)
    ├── orchestrator/(dist/ + package.json)
    ├── automation/  (dist/ + package.json)
    ├── web/         (dist/ + package.json)
    └── shared/      (dist/ + package.json)
```

Not included: source `.ts` files, tests, `.git`, `node_modules`, fixtures. The tarball is typically 5–15 MB.

Reference workflow (`.github/workflows/release.yml`):

```yaml
on:
  push:
    tags: ['v*']

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build

      - name: Pack tarball
        run: |
          ver="${GITHUB_REF_NAME#v}"
          dir="vina-${ver}"
          mkdir "$dir"
          cp package.json pnpm-workspace.yaml pnpm-lock.yaml "$dir/"
          mkdir "$dir/packages"
          for pkg in cli server orchestrator automation web shared; do
            mkdir -p "$dir/packages/$pkg"
            cp -r "packages/$pkg/dist" "$dir/packages/$pkg/"
            cp    "packages/$pkg/package.json" "$dir/packages/$pkg/"
          done
          cp -r packages/server/migrations "$dir/packages/server/"
          tar -czf "vina-${ver}.tar.gz" "$dir"

      - uses: softprops/action-gh-release@v1
        with:
          files: |
            vina-*.tar.gz
            scripts/install.sh
            scripts/install.ps1
```

The installer scripts themselves are published as additional release assets, so users on slow `vina.ai` deployments can fetch directly from GitHub.

## 7. Hosting the scripts

`https://vina.ai/install.sh` and `https://vina.ai/install.ps1` must:

- Serve over HTTPS, TLS 1.2 or higher.
- Send `Content-Type: text/plain; charset=utf-8` (works with `bash` and `iex`).
- Send `Cache-Control: max-age=300` or shorter. Long caches mean a fixed install bug takes hours to propagate.
- Be backed by a static host you control: Cloudflare Pages, Vercel, Netlify, or S3 + CloudFront.

Both scripts accept `VINA_REPO` as an environment escape hatch for testing pre-release tags from a fork:

```bash
curl -fsSL https://vina.ai/install.sh | VINA_REPO=my-fork/vina bash
```

```powershell
$env:VINA_REPO = "my-fork/vina"; iwr -useb https://vina.ai/install.ps1 | iex
```

## 8. Testing checklist

Before every release, run through these on each platform.

**Fresh install on a clean machine:**

- `curl -fsSL https://vina.ai/install.sh | bash` — finishes, `vina --version` prints the tag
- `iwr -useb https://vina.ai/install.ps1 | iex` — finishes, `vina --version` prints the tag

**Idempotency:**

- Running the installer again with no args is a no-op: prints "already at vX.Y.Z"
- Running with `--force` reinstalls cleanly
- Running with `--version v<older>` downgrades (current symlink moves)

**Non-interactive:**

- `--no-onboard` finishes without auto-starting the daemon
- `--dry-run` prints the plan, exits 0, makes no changes

**Smoke after install:**

- `vina --version` exits 0
- `vina doctor` exits 0 (or 1 with a specific, actionable error — never a stack trace)
- `vina start` brings up the daemon; `curl -s http://localhost:7341/api/bootstrap` returns valid JSON
- `vina stop` shuts it down; PID file is gone

**Failure modes:**

- Node missing entirely → installer installs Node and continues
- Node too old (e.g. v18) → installer upgrades and continues
- No package manager (rare; minimal Docker) → installer prints actionable error and exits 1
- Network failure mid-download → installer prints which step failed; partial extract is cleaned up
- Disk full during extract → installer exits cleanly without leaving a half-extracted version dir live
- `~/.local/bin` not on PATH in user's shell rc → installer adds it and prints a warning

**Containers for testing the Unix script:**

```bash
docker run --rm -it ubuntu:22.04 bash -c "
  apt-get update -qq &&
  apt-get install -y -qq curl ca-certificates sudo &&
  useradd -m -s /bin/bash test && echo 'test ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers &&
  su test -c 'curl -fsSL https://vina.ai/install.sh | bash'
"
```

```bash
docker run --rm -it alpine:latest sh -c "
  apk add --no-cache bash curl ca-certificates sudo &&
  adduser -D test && echo 'test ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers &&
  su test -c 'curl -fsSL https://vina.ai/install.sh | bash'
"
```

```bash
docker run --rm -it fedora:latest bash -c "
  dnf install -y -q curl sudo &&
  useradd -m test && echo 'test ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers &&
  su test -c 'curl -fsSL https://vina.ai/install.sh | bash'
"
```

For Windows: a fresh Windows Sandbox session, or a throwaway VM. There is no good headless equivalent.

## 9. Maintenance

- Bump `INSTALLER_VERSION` (bash) / `$InstallerVersion` (PowerShell) on every script change. `vina doctor` prints it in diagnostic output, which makes "which installer did this user run" obvious in bug reports.
- The pinned `PNPM_VERSION` / `$PnpmVersion` must match the `packageManager` field in the release tarball's root `package.json`. The release workflow should fail if they disagree — add that check before adding new releases.
- When you bump the Node minimum (e.g. to 22 LTS), update both scripts' `NODE_MIN_MAJOR` / `$NodeMinMajor` at the same time, and update `vina doctor` to match.
- The scripts deliberately have no test framework. They are tested by running them in the containers listed in §8 before each release. If you find yourself wanting unit tests for the scripts, that is usually a sign that a particular helper should move into the `vina doctor` command instead — `doctor` is testable TypeScript, the installer is bash/PowerShell glue.
