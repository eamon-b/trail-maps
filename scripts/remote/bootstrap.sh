#!/usr/bin/env bash
#
# Bootstrap a fresh remote build box for the world contour build (issue #34).
#
# Target OS: Ubuntu 24.04 LTS or Debian 12 (x86_64). Installs everything the
# world contour pipeline needs and clones the repo:
#
#   build essentials, git, curl, sqlite3, unzip, jq, rclone
#   GDAL >= 3.6 (gdal-bin)               — warp + contour
#   tippecanoe (built from source, felt/tippecanoe latest release)
#   Node 22 (NodeSource apt repo)        — the build scripts run under tsx
#   pmtiles CLI (protomaps/go-pmtiles)   — convert/verify/show the archive
#
# Idempotent: every step checks for an up-to-date install first, so re-running
# after a partial failure (or after the box reboots) is safe and cheap.
#
# Usage:
#   ./scripts/remote/bootstrap.sh
#   REPO_REF=feat/world-contour-tiles ./scripts/remote/bootstrap.sh
#   REPO_URL=https://github.com/eamon-b/trail-maps.git ./scripts/remote/bootstrap.sh
#   CHECKOUT_DIR=/mnt/nvme/trail-maps ./scripts/remote/bootstrap.sh
#   ./scripts/remote/bootstrap.sh --skip-clone     # tools only
#
# Environment overrides:
#   REPO_URL      git remote to clone   (default git@github.com:eamon-b/trail-maps.git)
#   REPO_REF      branch/tag to check out (default main)
#   CHECKOUT_DIR  where to clone        (default $HOME/trail-maps)
#   NODE_MAJOR    Node major version    (default 22)
#   TIPPECANOE_REF  tippecanoe tag to build (default: latest release)
#
# NOTE on the git remote: the default is SSH, which needs a key on the box
# (ssh-keygen -t ed25519 && add the public key as a GitHub deploy key). For a
# public repo the simpler path is REPO_URL=https://github.com/eamon-b/trail-maps.git
# — no credentials on the build box at all. Never copy a personal token here.

set -euo pipefail

REPO_URL="${REPO_URL:-git@github.com:eamon-b/trail-maps.git}"
REPO_REF="${REPO_REF:-main}"
CHECKOUT_DIR="${CHECKOUT_DIR:-$HOME/trail-maps}"
NODE_MAJOR="${NODE_MAJOR:-22}"
TIPPECANOE_REF="${TIPPECANOE_REF:-}"
TIPPECANOE_SRC_DIR="${TIPPECANOE_SRC_DIR:-$HOME/src/tippecanoe}"
MIN_GDAL_VERSION="3.6"

SKIP_CLONE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-clone) SKIP_CLONE=true; shift ;;
    --help|-h)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# --- Helpers ---

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if ! command -v sudo > /dev/null 2>&1; then
    echo "Error: not root and sudo not found. Run as root or install sudo." >&2
    exit 1
  fi
  SUDO="sudo"
fi

log() { printf '\n=== %s ===\n' "$*"; }

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "$command_name" > /dev/null 2>&1; then
    echo "Error: $command_name not found. $install_hint" >&2
    exit 1
  fi
}

# "3.8.4" >= "3.6" without bc/sort -V surprises on odd version strings.
version_ge() {
  local have="$1" want="$2"
  [ "$(printf '%s\n%s\n' "$want" "$have" | sort -V | head -n1)" = "$want" ]
}

# --- 0. Sanity ---

if ! command -v apt-get > /dev/null 2>&1; then
  echo "Error: this bootstrap targets Debian/Ubuntu (apt-get not found)." >&2
  echo "On another distro, install the same tool list by hand; the build" >&2
  echo "scripts only need gdal>=3.6, tippecanoe, node 22, pmtiles, rclone." >&2
  exit 1
fi

if [ "$(uname -m)" != "x86_64" ]; then
  echo "Warning: this script downloads the linux-x86_64 pmtiles binary;" >&2
  echo "on $(uname -m) fetch the matching asset from protomaps/go-pmtiles." >&2
fi

log "Machine"
echo "  Host:    $(hostname)"
echo "  Kernel:  $(uname -sr)"
echo "  CPUs:    $(nproc)"
free -h | sed 's/^/  /'
df -h / "$(dirname "$CHECKOUT_DIR")" 2>/dev/null | sed 's/^/  /' || true

swap_kb=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
ram_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
if [ "${swap_kb:-0}" -eq 0 ] && [ "${ram_kb:-0}" -lt $((64 * 1024 * 1024)) ]; then
  echo "  ⚠ No swap and < 64 GB RAM: the tippecanoe merge is the RAM bottleneck"
  echo "    and the kernel OOM killer will silently kill it. Consider adding a"
  echo "    swapfile on the NVMe (e.g. 64G) before starting a big shard."
fi

# --- 1. apt packages ---

log "apt packages"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -qq
$SUDO apt-get install -y --no-install-recommends \
  build-essential \
  ca-certificates \
  curl \
  git \
  gnupg \
  jq \
  libsqlite3-dev \
  pkg-config \
  rclone \
  sqlite3 \
  unzip \
  zlib1g-dev \
  gdal-bin

require_command gdalinfo "apt-get install gdal-bin failed?"
gdal_version="$(gdalinfo --version | sed -E 's/^GDAL ([0-9.]+).*/\1/')"
if ! version_ge "$gdal_version" "$MIN_GDAL_VERSION"; then
  echo "Error: GDAL $gdal_version is older than the required $MIN_GDAL_VERSION." >&2
  echo "On Debian 12 add backports, or use the ubuntugis PPA on Ubuntu:" >&2
  echo "  add-apt-repository ppa:ubuntugis/ppa && apt-get update && apt-get install gdal-bin" >&2
  exit 1
fi
echo "  ✓ GDAL $gdal_version (>= $MIN_GDAL_VERSION)"

# --- 2. Node ---

log "Node $NODE_MAJOR"
node_major=""
if command -v node > /dev/null 2>&1; then
  node_major="$(node -v | sed -E 's/^v([0-9]+)\..*/\1/')"
fi
if [ "$node_major" = "$NODE_MAJOR" ]; then
  echo "  ✓ Node $(node -v) already installed"
else
  echo "  Installing Node $NODE_MAJOR from the NodeSource apt repo..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  $SUDO -E bash /tmp/nodesource_setup.sh
  rm -f /tmp/nodesource_setup.sh
  $SUDO apt-get install -y nodejs
  echo "  ✓ Node $(node -v)"
fi

# --- 3. tippecanoe (from source) ---

log "tippecanoe"
if [ -z "$TIPPECANOE_REF" ]; then
  TIPPECANOE_REF="$(curl -fsSL https://api.github.com/repos/felt/tippecanoe/releases/latest | jq -r '.tag_name')"
  if [ -z "$TIPPECANOE_REF" ] || [ "$TIPPECANOE_REF" = "null" ]; then
    echo "Error: could not resolve the latest felt/tippecanoe release tag." >&2
    echo "Set TIPPECANOE_REF=<tag> and re-run (GitHub API rate limit?)." >&2
    exit 1
  fi
fi
# Release tags are "2.78.0" or "v2.78.0"; `tippecanoe --version` prints
# "tippecanoe v2.78.0" on stderr. Compare on the bare number.
want_tippecanoe="${TIPPECANOE_REF#v}"
have_tippecanoe=""
if command -v tippecanoe > /dev/null 2>&1; then
  have_tippecanoe="$(tippecanoe --version 2>&1 | head -n1 | sed -E 's/.*v?([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
fi
if [ "$have_tippecanoe" = "$want_tippecanoe" ]; then
  echo "  ✓ tippecanoe $have_tippecanoe already installed"
else
  echo "  Building tippecanoe $TIPPECANOE_REF from source (have: ${have_tippecanoe:-none})..."
  mkdir -p "$(dirname "$TIPPECANOE_SRC_DIR")"
  if [ -d "$TIPPECANOE_SRC_DIR/.git" ]; then
    git -C "$TIPPECANOE_SRC_DIR" fetch --tags --quiet origin
  else
    rm -rf "$TIPPECANOE_SRC_DIR"
    git clone --quiet https://github.com/felt/tippecanoe.git "$TIPPECANOE_SRC_DIR"
  fi
  git -C "$TIPPECANOE_SRC_DIR" checkout --quiet "$TIPPECANOE_REF"
  make -C "$TIPPECANOE_SRC_DIR" -j"$(nproc)"
  $SUDO make -C "$TIPPECANOE_SRC_DIR" install
  hash -r
  echo "  ✓ $(tippecanoe --version 2>&1 | head -n1)"
fi

# --- 4. pmtiles CLI ---

log "pmtiles CLI"
pmtiles_tag="$(curl -fsSL https://api.github.com/repos/protomaps/go-pmtiles/releases/latest | jq -r '.tag_name')"
if [ -z "$pmtiles_tag" ] || [ "$pmtiles_tag" = "null" ]; then
  echo "Error: could not resolve the latest protomaps/go-pmtiles release." >&2
  exit 1
fi
pmtiles_version="${pmtiles_tag#v}"
have_pmtiles=""
if command -v pmtiles > /dev/null 2>&1; then
  have_pmtiles="$(pmtiles version 2>&1 | sed -E 's/.*v?([0-9]+\.[0-9]+\.[0-9]+).*/\1/' | head -n1)"
fi
if [ "$have_pmtiles" = "$pmtiles_version" ]; then
  echo "  ✓ pmtiles $have_pmtiles already installed"
else
  echo "  Installing pmtiles $pmtiles_version (have: ${have_pmtiles:-none})..."
  pmtiles_tmp="$(mktemp -d)"
  trap 'rm -rf "$pmtiles_tmp"' EXIT
  pmtiles_asset="go-pmtiles_${pmtiles_version}_Linux_x86_64.tar.gz"
  curl -fsSL -o "$pmtiles_tmp/$pmtiles_asset" \
    "https://github.com/protomaps/go-pmtiles/releases/download/${pmtiles_tag}/${pmtiles_asset}"
  tar -xzf "$pmtiles_tmp/$pmtiles_asset" -C "$pmtiles_tmp" pmtiles
  $SUDO install -m 0755 "$pmtiles_tmp/pmtiles" /usr/local/bin/pmtiles
  rm -rf "$pmtiles_tmp"
  trap - EXIT
  hash -r
  echo "  ✓ $(pmtiles version 2>&1 | head -n1)"
fi

# --- 5. Repo checkout + npm ci ---

if [ "$SKIP_CLONE" = true ]; then
  log "Repo checkout skipped (--skip-clone)"
else
  log "Repo checkout"
  if [ -d "$CHECKOUT_DIR/.git" ]; then
    echo "  Updating existing checkout at $CHECKOUT_DIR"
    git -C "$CHECKOUT_DIR" fetch --quiet --all --tags
    git -C "$CHECKOUT_DIR" checkout "$REPO_REF"
    # Only fast-forward: never clobber local edits made on the box.
    git -C "$CHECKOUT_DIR" pull --ff-only || \
      echo "  ⚠ pull --ff-only failed (detached ref or local commits) — continuing"
  else
    echo "  Cloning $REPO_URL ($REPO_REF) into $CHECKOUT_DIR"
    git clone --branch "$REPO_REF" "$REPO_URL" "$CHECKOUT_DIR"
  fi

  echo "  Installing npm dependencies (npm ci)..."
  (cd "$CHECKOUT_DIR" && npm ci)
  echo "  ✓ $CHECKOUT_DIR ready ($(git -C "$CHECKOUT_DIR" rev-parse --short HEAD))"
fi

# --- 6. Versions ---

log "Installed versions"
printf '  %-12s %s\n' "os"         "$(awk -F= '/^PRETTY_NAME=/ {gsub(/"/, "", $2); print $2}' /etc/os-release)"
printf '  %-12s %s\n' "gdal"       "$(gdalinfo --version)"
printf '  %-12s %s\n' "ogr2ogr"    "$(ogr2ogr --version)"
printf '  %-12s %s\n' "tippecanoe" "$(tippecanoe --version 2>&1 | head -n1)"
printf '  %-12s %s\n' "tile-join"  "$(tile-join --version 2>&1 | head -n1)"
printf '  %-12s %s\n' "node"       "$(node -v)"
printf '  %-12s %s\n' "npm"        "$(npm -v)"
printf '  %-12s %s\n' "pmtiles"    "$(pmtiles version 2>&1 | head -n1)"
printf '  %-12s %s\n' "rclone"     "$(rclone version | head -n1)"
printf '  %-12s %s\n' "sqlite3"    "$(sqlite3 --version | awk '{print $1}')"
printf '  %-12s %s\n' "git"        "$(git --version)"

cat <<EOF

Bootstrap complete.

Next steps (see docs/world-contours-remote-build.md):
  cd $CHECKOUT_DIR
  ./scripts/remote/run-shard.sh oceania          # first shard — quality gate
  ./scripts/remote/status.sh                     # progress
EOF
