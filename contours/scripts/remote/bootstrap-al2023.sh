#!/usr/bin/env bash
#
# Bootstrap an AWS box running Amazon Linux 2023 for the world contour build:
# the dnf counterpart of bootstrap.sh (which is apt-only). Used for the
# 2026-10 rebuild (#135) on an i4i.8xlarge.
#
# Amazon Linux has no GDAL package, so the geo stack (GDAL, sqlite, Node 22,
# rclone) comes from conda-forge in a micromamba env on the NVMe volume;
# tippecanoe is built from the pinned release with the system compiler.
#
# Before running it, stripe the instance-store NVMe drives into one volume at
# /mnt/nvme (the root disk is 8 GB and /tmp is tmpfs, so nothing big may live
# on either). Formatting is left to a human on purpose:
#
#   sudo dnf install -y mdadm xfsprogs
#   sudo mdadm --create /dev/md0 --level=0 --raid-devices=2 /dev/nvme1n1 /dev/nvme2n1 --run
#   sudo mkfs.xfs /dev/md0 && sudo mkdir -p /mnt/nvme && sudo mount -o noatime /dev/md0 /mnt/nvme
#   sudo chown ec2-user:ec2-user /mnt/nvme
#
# Usage (as ec2-user):
#   bash bootstrap-al2023.sh
#   NVME=/mnt/nvme REPO_REF=main bash bootstrap-al2023.sh
#
# It writes /etc/profile.d/geo.sh (PATH, TMPDIR, npm cache). Non-login shells
# do not read it: every ssh command and every detached build must start with
# `. /etc/profile.d/geo.sh`. Idempotent: re-running skips finished steps.

set -euo pipefail

NVME="${NVME:-/mnt/nvme}"
REPO_URL="${REPO_URL:-https://github.com/eamon-b/tracknotes.git}"
REPO_REF="${REPO_REF:-main}"
CHECKOUT_DIR="${CHECKOUT_DIR:-$NVME/tracknotes}"
# Keep equal to TIPPECANOE_VERSION in scripts/tile-pipeline.ts (see bootstrap.sh).
TIPPECANOE_REF="${TIPPECANOE_REF:-2.79.0}"

if ! mountpoint -q "$NVME"; then
  echo "Error: $NVME is not a mount point. Stripe and mount the NVMe drives first (see the header)." >&2
  exit 1
fi

export TMPDIR="$NVME/tmp"
mkdir -p "$TMPDIR" "$NVME/src" "$NVME/bin"

echo "== dnf packages"
sudo dnf install -y -q git gcc-c++ make sqlite-devel zlib-devel jq unzip tar tmux bzip2 rsync >/dev/null

echo "== geo env (conda-forge: gdal, sqlite, node 22, rclone)"
if [ ! -x "$NVME/bin/micromamba" ]; then
  curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C "$NVME" bin/micromamba
fi
export MAMBA_ROOT_PREFIX="$NVME/micromamba"
if [ ! -x "$NVME/micromamba/envs/geo/bin/gdalinfo" ]; then
  "$NVME/bin/micromamba" create -y -q -p "$NVME/micromamba/envs/geo" -c conda-forge \
    'gdal>=3.8' sqlite 'nodejs=22' rclone >/dev/null
fi

sudo tee /etc/profile.d/geo.sh >/dev/null <<EOF
export MAMBA_ROOT_PREFIX=$NVME/micromamba
export PATH=$NVME/micromamba/envs/geo/bin:/usr/local/bin:\$PATH
export TMPDIR=$NVME/tmp
export npm_config_cache=$NVME/npm-cache
EOF
# shellcheck disable=SC1091
. /etc/profile.d/geo.sh

echo "== tippecanoe $TIPPECANOE_REF"
if ! tippecanoe --version 2>&1 | grep -q "v${TIPPECANOE_REF#v}"; then
  [ -d "$NVME/src/tippecanoe/.git" ] || git clone -q https://github.com/felt/tippecanoe.git "$NVME/src/tippecanoe"
  git -C "$NVME/src/tippecanoe" fetch -q --tags
  git -C "$NVME/src/tippecanoe" checkout -q "$TIPPECANOE_REF"
  # The system compiler and the system sqlite/zlib headers, not the conda env's
  env PATH=/usr/bin:/bin make -C "$NVME/src/tippecanoe" -j"$(nproc)" >/dev/null
  sudo make -C "$NVME/src/tippecanoe" install >/dev/null
fi

echo "== pmtiles CLI"
if ! command -v pmtiles >/dev/null; then
  tag=$(curl -fsSL https://api.github.com/repos/protomaps/go-pmtiles/releases/latest | jq -r .tag_name)
  curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/$tag/go-pmtiles_${tag#v}_Linux_x86_64.tar.gz" \
    | tar -xz -C "$TMPDIR" pmtiles
  sudo install -m 0755 "$TMPDIR/pmtiles" /usr/local/bin/pmtiles
fi

echo "== repo ($REPO_REF)"
if [ ! -d "$CHECKOUT_DIR/.git" ]; then
  git clone -q --branch "$REPO_REF" "$REPO_URL" "$CHECKOUT_DIR"
else
  git -C "$CHECKOUT_DIR" fetch -q
  git -C "$CHECKOUT_DIR" checkout -q "$REPO_REF"
  git -C "$CHECKOUT_DIR" pull -q --ff-only
fi
(cd "$CHECKOUT_DIR" && npm ci --no-audit --no-fund >/dev/null)
mkdir -p "$CHECKOUT_DIR/logs"

echo "== versions"
printf '  %-12s %s\n' os "$(awk -F= '/^PRETTY_NAME=/ {gsub(/"/,"",$2); print $2}' /etc/os-release)"
printf '  %-12s %s\n' gdal "$(gdalinfo --version)"
printf '  %-12s %s\n' tippecanoe "$(tippecanoe --version 2>&1 | head -n1)"
printf '  %-12s %s\n' node "$(node -v)"
printf '  %-12s %s\n' pmtiles "$(pmtiles version 2>&1 | head -n1)"
printf '  %-12s %s\n' rclone "$(rclone version | head -n1)"
printf '  %-12s %s\n' sqlite3 "$(sqlite3 --version | awk '{print $1}')"
printf '  %-12s %s\n' repo "$(git -C "$CHECKOUT_DIR" rev-parse --short HEAD)"
