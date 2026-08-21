# World Contour Tiles — Remote Build Runbook

How to build `contours/world.pmtiles` (issue #34) on a rented machine and get
it live behind the contour Worker. The design decisions behind this live in
`plans/world-contour-tiles.md`; this document is the operational side — what to
rent, what to run, what breaks, and what it costs.

Everything here assumes the build tooling from the `feat/world-contour-tiles`
branch:

| Piece | Path |
| --- | --- |
| Grid + shard definitions | `scripts/lib/world-grid.ts` |
| DEM fetcher (Copernicus GLO-30) | `scripts/fetch-dem-copernicus.ts` |
| Build / merge / join | `scripts/build-contours-world.ts` |
| Machine setup | `scripts/remote/bootstrap.sh` |
| Shard driver (detached) | `scripts/remote/run-shard.sh` |
| Progress summary | `scripts/remote/status.sh` |
| R2 upload | `scripts/remote/upload-world.sh` |
| Worker | `workers/contour-tiles/` |

---

## 1. Machine sizing

The Australia archive (248 cells, 13.5 GB of staged FlatGeobufs) was built on a
15 GB-RAM laptop: **~4 h of tippecanoe tiling followed by ~20 h of
single-threaded, RAM-starved clustering.** The world is roughly 20× that. RAM
is the merge bottleneck, not CPU.

Recommended:

| Resource | Minimum | Why |
| --- | --- | --- |
| CPU | ≥ 32 threads | per-cell gdalwarp/gdal_contour is embarrassingly parallel (~100 s/cell) |
| RAM | 64 GB, **128 GB preferred** | tippecanoe clustering; below ~64 GB the merge degrades to the laptop's 20 h behaviour |
| Disk | ≥ 3 TB NVMe | see the disk math below |
| Swap | ≥ 64 GB on NVMe | a slow merge beats an OOM-killed merge |
| Bandwidth | unmetered | ~1.1 TB of DEM downloads if you never purge |

Concretely: a **Hetzner AX102-class dedicated box** (32 threads, 128 GB RAM,
2× 1.92 TB NVMe, unmetered 1 Gbps, ~€110/month) — one month covers the whole
build with retries — or any hourly cloud instance with ≥ 64 GB RAM and ≥ 3 TB
of local NVMe. Avoid network block storage: tippecanoe's temp spill and the
FlatGeobuf staging are both IOPS-hungry.

### Disk math

| Item | Size |
| --- | --- |
| World GLO-30 DEM, all at once | ~1.1 TB |
| Per-shard DEM peak with `--purge-dem` | 100–200 GB |
| Staged FlatGeobuf tiers | Australia was 13.5 GB → world ~250–350 GB |
| tippecanoe temp spill (`-t`, per merge) | tens of GB |
| `world_{shard}.mbtiles` sum | ~150–350 GB |
| `world.mbtiles` + `world.pmtiles` (both exist during convert) | 2× the final size |

Peak is the join step: shard mbtiles + `world.mbtiles` + `world.pmtiles`
coexist. Budget ~3× the estimated final archive size on top of the staging
dirs. `run-shard.sh` refuses to start below 500 GB free (`MIN_FREE_DISK_GB`).

### Timing estimate

| Phase | Estimate |
| --- | --- |
| DEM download (per shard, 1 Gbps) | 1–3 h |
| Cells, all shards, 32 threads @ `--parallel 16` | 10–13 h total |
| tippecanoe per shard @ 128 GB RAM | 2–5 h (2–3 shards can run concurrently) |
| `--join` (tile-join + pmtiles convert) | 2–6 h, mostly I/O |
| Upload to R2 @ 1 Gbps | 0.5–1 h per 200 GB |

Realistically: **3–5 days wall clock** including one or two restarts.

---

## 2. Before you rent anything: the settings decision gate

The remote build is expensive; the quality settings must be chosen **first**,
locally, with `scripts/contour-experiment.ts`:

```bash
npx tsx scripts/contour-experiment.ts            # builds the variant matrix
npx serve data/experiments/<run>                 # side-by-side compare page
```

Eyeball the compare page (warp scale, resampling kernel, `--simplification`,
`--minimum-detail`, `--simplify-only-low-zooms`, SRTM vs GLO-30) and bake the
chosen bundle into the defaults of `scripts/build-contours-world.ts`, commit,
and push — **before** provisioning. Changing your mind after two shards means
rebuilding them.

**Decided 2026-08-22** (Mt Sonder, run `smooth-z13`): 2× cubicspline warp,
`--simplification=2 --simplify-only-low-zooms --minimum-detail=7
--maximum-tile-bytes=1000000`. The previous `--simplification=14` left z12–z14
contours visibly polygonal; 2 is smooth at every zoom for ~+35% archive size in
mountainous tiles (z15 unchanged). Only the tippecanoe flags changed, so a
future re-tune is a `--merge-only` re-run, not a cell rebuild. The experiment's
`baseline` variant mirrors these flags; `legacy-simp-14` is the old bundle.

---

## 3. Provision and bootstrap

```bash
ssh root@<box>

# Optional but recommended when RAM < 128 GB: swap on the NVMe
fallocate -l 64G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile

# Put the checkout on the big NVMe volume, not a small root disk
export CHECKOUT_DIR=/mnt/nvme/trail-maps

curl -fsSL https://raw.githubusercontent.com/eamon-b/trail-maps/feat/world-contour-tiles/scripts/remote/bootstrap.sh -o bootstrap.sh
REPO_URL=https://github.com/eamon-b/trail-maps.git \
REPO_REF=feat/world-contour-tiles \
bash bootstrap.sh
```

(Or clone the repo by hand and run `./scripts/remote/bootstrap.sh` from it —
the script updates an existing checkout in place.)

`bootstrap.sh` installs build essentials, GDAL ≥ 3.6 (it hard-fails on older),
sqlite3, git, rclone, Node 22 from NodeSource, tippecanoe built from the latest
`felt/tippecanoe` release, the `pmtiles` CLI from `protomaps/go-pmtiles`, then
clones the repo and runs `npm ci`. It prints every version at the end — paste
that block into the build notes for the record. Re-running it is safe.

If the repo is private, either use the HTTPS URL with a read-only deploy token
you create for this box, or generate an SSH key on the box
(`ssh-keygen -t ed25519`) and register the public key as a GitHub **deploy
key**. Never copy a personal token or `~/.ssh` key onto a rented machine, and
delete the key/token when you decommission it.

---

## 4. Build the `oceania` shard first (quality gate)

`oceania` contains Australia, so its output can be compared directly against
the production SRTM archive on trails you know.

```bash
cd /mnt/nvme/trail-maps
./scripts/remote/run-shard.sh oceania
```

This fetches the shard's GLO-30 tiles, then builds and merges the cells —
**detached** (`setsid nohup`), logging to `logs/world-oceania-<timestamp>.log`.
It prints the PID and exits; the build survives your ssh session dropping.
`--fg` runs it attached instead (useful only for tiny test shards).

Watch it:

```bash
./scripts/remote/status.sh          # cells done/total per shard, artifacts, procs, disk, log tail
tail -f logs/world-oceania-*.log
```

Compare before continuing. The shard output is an **mbtiles**, so inspect it
with sqlite3, or convert just this shard and serve it for a visual check:

```bash
sqlite3 public/data/tiles/world_oceania.mbtiles \
  "SELECT name, value FROM metadata WHERE name IN ('name','format','minzoom','maxzoom');"
sqlite3 public/data/tiles/world_oceania.mbtiles \
  "SELECT zoom_level, count(*) FROM tiles GROUP BY zoom_level ORDER BY zoom_level;"

# Visual check (writes next to the mbtiles — never onto a tmpfs)
pmtiles convert public/data/tiles/world_oceania.mbtiles \
                public/data/tiles/world_oceania.pmtiles
pmtiles serve public/data/tiles          # http://localhost:8080/world_oceania/{z}/{x}/{y}.mvt
pmtiles tile public/data/tiles/world_oceania.pmtiles 15 28450 18593 | wc -c
```

Check against the production archive
(`https://tiles.contour-map-tiles.net/contours/15/28450/18593.pbf`):
same contour density, no dangling lines at 2° cell edges, index contours
present (`is_index` is the **string** `"1"` — MapLibre filters must
`to-number` it), z9–15 coverage. Only when this looks right do you spend money
on the other shards.

---

## 5. Remaining shards

The shard names come from `WORLD_SHARDS` in `scripts/lib/world-grid.ts`
(`worldShardNames()` prints the authoritative list):

```bash
./scripts/remote/run-shard.sh europe
./scripts/remote/run-shard.sh asia-west
./scripts/remote/run-shard.sh asia-east
./scripts/remote/run-shard.sh africa
./scripts/remote/run-shard.sh north-america
./scripts/remote/run-shard.sh central-america
./scripts/remote/run-shard.sh south-america
./scripts/remote/run-shard.sh iceland
./scripts/remote/run-shard.sh rest       # catch-all: oceanic islands etc.
# antarctica / greenland are opt-out: huge, near-useless ice-sheet contours.
# Build them last, or not at all.
```

`status.sh` shows the per-shard cell totals; until the Copernicus tile list is
cached at `data/dem-glo30/.tileList.txt` those totals include ocean cells the
build will skip, so they look far larger than the work actually queued.

Two or three shards can run concurrently on a 32-thread/128 GB box **if their
cell phases overlap with another shard's merge phase** — do not run two
tippecanoe merges at once unless you have watched the RSS and know they fit.
Pass a smaller parallelism when sharing the box:
`./scripts/remote/run-shard.sh africa 12`.

`--purge-dem` (on by default in the driver) deletes each cell's DEM tiles once
no pending cell needs them, which is what keeps peak DEM at shard scale instead
of 1.1 TB.

---

## 6. Join, validate, upload

```bash
# tile-join every world_*.mbtiles -> world.mbtiles -> pmtiles convert -> world.pmtiles
setsid nohup npx tsx scripts/build-contours-world.ts --join \
  > logs/world-join-$(date +%Y%m%d-%H%M%S).log 2>&1 &
```

Validate before uploading 200 GB:

```bash
# Zoom range must be z9-15 and the layer must be `contour`
pmtiles show public/data/tiles/world.pmtiles

# Structural check of the archive (index, directories, offsets)
pmtiles verify public/data/tiles/world.pmtiles

# Spot-check real tiles (should return non-empty pbf bytes)
pmtiles tile public/data/tiles/world.pmtiles 15 28450 18593 | wc -c   # Mt Sonder, AU
pmtiles tile public/data/tiles/world.pmtiles 12 2126 1459   | wc -c   # Mont Blanc, FR/IT
pmtiles tile public/data/tiles/world.pmtiles 9  265  182    | wc -c   # z9 floor, Alps

# mbtiles sanity (same checks upload-tiles.sh runs for Australia)
sqlite3 public/data/tiles/world.mbtiles "PRAGMA integrity_check;"
sqlite3 public/data/tiles/world.mbtiles "SELECT count(*) FROM tiles;"
```

Then upload:

```bash
rclone config          # one-time: see the setup block in upload-world.sh
./scripts/remote/upload-world.sh
```

`upload-world.sh` checks the PMTiles magic bytes, refuses a headerless
(killed-convert) file, uploads with `rclone copyto --s3-chunk-size 128M
--s3-upload-concurrency 8 --progress`, then compares remote and local byte
counts and prints the Worker URLs to check.

**Credentials:** create an R2 API token in the Cloudflare dashboard (R2 →
Manage R2 API Tokens → Object Read & Write on `aus-map-data`) and enter it into
`rclone config` on the box. Nothing in this repo reads or stores credentials —
if a script needs auth it asks you for it. Revoke the token when the box is
destroyed.

---

## 7. Deploy the Worker and verify

The Worker serves `/{source}/{z}/{x}/{y}.pbf` and gains a `world` source
mapping to `contours/world.pmtiles` alongside the existing `contours`
(Australia/SRTM) source.

```bash
cd workers/contour-tiles && npx wrangler deploy

curl -s https://tiles.contour-map-tiles.net/health | jq .
#   expect ok: true overall, and a per-source breakdown with world: ok
curl -sI https://tiles.contour-map-tiles.net/world/15/28450/18593.pbf
#   expect 200 + application/x-protobuf (204 means "no contours here", which is
#   correct over ocean but wrong at Mt Sonder)
```

A missing world archive must not make `/health` fail overall while only
Australia is deployed — that is by design, so deploying the Worker before the
upload finishes is safe.

Edge cache: re-uploading the same key leaves stale bytes cached for up to 24 h.

---

## 8. Gotchas (all of these have bitten us)

> **The OOM killer kills detached builds silently.**
> A backgrounded tippecanoe that fills RAM+swap disappears with nothing in the
> build log — the kill is only in `dmesg`/`journalctl -k`. Always use
> `run-shard.sh` (it logs to a file), and when a build "just stopped", check
> `journalctl -k | grep -i 'out of memory'` before blaming the code.
> `status.sh` surfaces recent OOM kills for you.

> **Never let tippecanoe's temp spill land on tmpfs.**
> tippecanoe writes tens of GB of sort files to `-t`. On a distro where `/tmp`
> is tmpfs (RAM-backed) that is a guaranteed mid-merge failure — or an OOM.
> The build scripts pass `-t <work dir>/tmp`; `run-shard.sh` additionally
> refuses to run if the work dir is on `tmpfs`/`ramfs`. If you invoke
> tippecanoe by hand, pass `-t` yourself, or `export TMPDIR=/mnt/nvme/tmp`.

> **A killed merge or convert leaves an INVALID output file.**
> mbtiles metadata and the PMTiles header are written **last**. A file of
> plausible size is not evidence of success: only an exit status of 0 is.
> Always re-run the merge (`run-shard.sh <shard> --merge-only`) or the join
> after an interruption; never upload a file whose producing command you did
> not see exit cleanly. `upload-world.sh` checks the magic bytes as a last line
> of defence.

> **Detach properly, or lose a day.**
> `foo &` alone dies with the ssh session. Use `run-shard.sh` (which does
> `setsid nohup … < /dev/null > log 2>&1`), or `tmux`. Do not rely on scrollback
> for a multi-day job — logs go to `logs/`.

> **Never run two tippecanoe merges concurrently on a RAM-tight box.**
> They do not degrade gracefully; they OOM.

> **Disk fills at the join step, not during the cells.** Shard mbtiles +
> `world.mbtiles` + `world.pmtiles` are all on disk at once.

---

## 9. Resume after a crash

Everything is resumable; nothing needs to start over.

| Situation | Do this |
| --- | --- |
| Build died during the cell phase (OOM, disk, reboot) | Re-run the exact same `./scripts/remote/run-shard.sh <shard>`. Cells with a `.done` marker in `data/tiles/contours-world/{shard}/` are skipped; only pending cells rebuild. |
| Build died during the tippecanoe merge | `./scripts/remote/run-shard.sh <shard> --merge-only` — redoes only the merge from the staged `*_z*.fgb` tiers (no GDAL work). |
| A cell looks wrong / settings changed | Delete that cell's `.done` marker and `{cellId}_z*.fgb`, then re-run the shard. Or `--force` to rebuild everything. |
| Join died | Re-run `--join`. Delete any partial `world.mbtiles` / `world.pmtiles` first — a killed run leaves a headerless file. |
| Upload died | Re-run `upload-world.sh`; rclone restarts the multipart upload. Verify byte counts afterwards (`--verify-only`). |
| DEM download died | Re-run; the fetcher skips tiles already on disk. |

A cell that has partial tier files but **no** `.done` marker is deliberately
skipped by the merge (with a warning) rather than silently contributing half a
cell's contours — if you see those warnings, re-run the shard without
`--merge-only` first.

---

## 10. Cost

| Item | Cost |
| --- | --- |
| Hetzner AX102-class dedicated box | ~€110 / month (+ ~€90 one-off setup, sometimes waived) |
| Alternative: hourly cloud, 64 GB RAM + 3 TB NVMe | ~$1–2 / h → ~$100–200 for a 4-day build |
| Bandwidth (1.1 TB DEM in, 200 GB out) | included / unmetered on Hetzner |
| R2 storage, 150–350 GB @ $0.015/GB-month | **$2.30–5.30 / month** |
| R2 Class A ops (upload, multipart) | < $0.10 |
| R2 egress | **$0** (zero-egress is the whole reason the archive lives there) |
| **One-off build total** | **~€110–200** |
| **Ongoing** | **~$3–6 / month** for storage; the Worker stays on the existing plan |

Keeping the Australia SRTM archive alongside the world one adds ~12 GB
(~$0.18/month) until it is retired — cheap enough to leave in place until the
world tileset is proven on real trails.

---

## 11. After the build

- Point the public demo/docs site at the `world` source.
- Decide later whether `contours` becomes an alias of `world` and the SRTM
  Australia archive is retired (see `plans/world-contour-tiles.md` §Rollout).
- Destroy the build box, revoke the R2 token and any deploy key.
- Record the actual timings/sizes in `plans/world-contour-tiles.md` so the next
  rebuild's estimates are real numbers instead of these guesses.
