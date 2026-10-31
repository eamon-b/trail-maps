# World Contour Tiles — Remote Build Runbook

How to build `contours/world.pmtiles` (issue #34) on a rented machine and get
it live behind the contour Worker. The design decisions behind this live in
`plans/world-contour-tiles.md`; this document is the operational side — what to
rent, what to run, what breaks, and what it costs.

Build from `main`. The `feat/world-contour-tiles` branch the first build ran
from still exists on origin but predates the zoom-tier fix (#132) and the
#158 safety nets: a box bootstrapped from it builds untiered contours again.
The tooling:

| Piece | Path |
| --- | --- |
| Grid + shard definitions | `scripts/lib/world-grid.ts` |
| DEM fetcher (Copernicus GLO-30) | `scripts/fetch-dem-copernicus.ts` |
| Build / merge / join | `contours/scripts/build-contours-world.ts` |
| Machine setup | `contours/scripts/remote/bootstrap.sh` |
| Shard driver (detached) | `contours/scripts/remote/run-shard.sh` |
| Progress summary | `contours/scripts/remote/status.sh` |
| R2 upload | `contours/scripts/remote/upload-world.sh` |
| Amazon Linux 2023 setup | `contours/scripts/remote/bootstrap-al2023.sh` |
| rclone `[r2]` from a Cloudflare token | `contours/scripts/remote/rclone-from-token.sh` |
| Unattended fetch + cells + merges | `contours/scripts/remote/drive-world.sh` |
| Unattended cleanup + join + validate + upload | `contours/scripts/remote/finish-world.sh` |
| Worker | `contours/worker/` |

---

## 0. The quickest run (what to do next time)

Distilled from the October 2026 rebuild (section 6b has the numbers). Every
step runs on the box; the laptop's uplink (~0.9 MB/s) moves nothing.

1. **Rent** an on-demand (never spot) AWS instance with local NVMe on Amazon
   Linux 2023. CPU is the only thing the build saturates, so buy cores, not
   RAM: see section 1 for the choice. Note the SSH security group pins your
   IP.
2. **Human steps on the box** (an agent's shell refuses `mkfs`, and
   credentials are yours to place):
   - stripe the NVMe drives into `/mnt/nvme` (the commands are in the header
     of `contours/scripts/remote/bootstrap-al2023.sh`);
   - put one Cloudflare API token at `~/token`: **Account → Workers R2
     Storage: Edit** and **Zone → Cache Purge** on `contour-map-tiles.net`.
     It covers rclone, wrangler and the manifest purge. Revoke it at the end.
3. **Bootstrap** (~10 min): `bash bootstrap-al2023.sh` (curl it from `main`),
   then `contours/scripts/remote/rclone-from-token.sh`.
4. **Start everything at once**, detached, from `/mnt/nvme/tracknotes`:

   ```bash
   . /etc/profile.d/geo.sh
   setsid nohup bash contours/scripts/remote/drive-world.sh  > logs/drive.log  2>&1 < /dev/null &
   setsid nohup bash contours/scripts/remote/finish-world.sh > logs/finish.log 2>&1 < /dev/null &
   ```

   `drive-world.sh` fetches every shard's DEM (retrying the Node HTTP crash),
   runs one cell lane and a pool of merges side by side; `finish-world.sh`
   converts each merged shard to `.pmtiles` as it lands, waits for the last
   merge, frees the intermediates, joins (section 6), validates and uploads
   at 32 parallel 256 MB parts. Progress is one line per event in `logs/drive-events.log`.
5. **The offline packs** on the same box while the world runs (section 7a):
   about 45 min. Upload them as soon as they validate; they do not wait for
   the world. (The October 2026 run also rebuilt the Australia archive here;
   that archive is retired, #228.)
6. **Keep the CPU busy at the end.** Each shard merges its batches one after
   another, so the biggest shard (asia-east, 8 batches) is the long pole. When
   the smaller merges finish and cores go idle, pre-tile its last batches in
   parallel: `build-contours-world.ts --shard asia-east --merge-only
   --batches-only --batch 7` (and 6, 5…); the running merge reuses each one
   it reaches with a matching `.done` marker.
7. **Clean up** (section 11) and destroy the box the moment the world upload
   verifies.

## 1. Machine sizing

**The build is CPU-bound from start to finish; RAM barely matters.** The
2026-10 run on an i4i.8xlarge (32 vCPU, 247 GB RAM) sat at 98-100 % user CPU
with no I/O wait for ~18 h, while every process together used at most ~26 GB
of RAM (a tippecanoe merge peaks at ~2.5 GB RSS; the old "RAM is the merge
bottleneck" came from the untiered build, whose z9-z12 tiles carried every
10 m line). The rest of the RAM only served as page cache.

What each phase scales with:

| Phase | Bound by | 2026-10 on 32 vCPU |
| --- | --- | --- |
| DEM fetch (~485 GB, 18,449 tiles) | network, one stream | 74 min |
| Cells (gdalwarp + gdal_contour) | cores, embarrassingly parallel | ~10 h |
| Shard merges (tippecanoe, ~92 GB batches) | ~1-6 cores per batch, batches of a shard in sequence | 2.5-3 h per batch under load; asia-east (8) ~24 h |
| `--join` (shards to pmtiles, tile-join, pmtiles convert) | the largest shard's convert, then tile-join on ~11 cores | ~16 h in Sept 2026 with mbtiles inputs; see 6b for October |
| Upload to R2 | rclone part concurrency | ~230 MB/s at 32 × 256 MB parts: 613 GB in 44 min (~35-45 MB/s at the old 8 × 128 MB) |

Recommended, AWS on-demand prices in us-east-1 (check them before renting):

| Instance | vCPU / RAM / NVMe | ~$/h | Fit |
| --- | --- | --- | --- |
| **c6id.32xlarge** | 128 / 256 GB / 4×1.9 TB | ~6.45 | Fastest: cells in ~2.5 h, and with batch-level merging (step 6) the merges in a few hours. The join, not the cores, then sets the end date. |
| c6id.24xlarge | 96 / 192 GB / 4×1.4 TB | ~4.84 | Same shape, 5.7 TB disk: enough with `finish-world.sh`'s cleanup |
| i4i.8xlarge (used 2026-10) | 32 / 256 GB / 2×3.75 TB | ~2.75 | Works; 8× more RAM than needed, a quarter of the cores |
| c6id.16xlarge / i4i.4xlarge | 64 or 16 / … / ~3.5-3.8 TB | — | Too little disk unless every shard runs `--purge-dem` and `--clean-work` |

A bigger box costs more per hour but rents for fewer of them: the CPU work is
about 600-700 vCPU-hours either way, so the trade is mostly against the fixed
~16 h join and the upload. Avoid network block storage (EBS) for the work
dirs: tippecanoe's temp spill and the FlatGeobuf staging are IOPS-hungry.
Instance-store NVMe is wiped on stop: never stop the box mid-build.

### Disk math (measured 2026-10)

| Item | Size |
| --- | --- |
| World GLO-30 DEM, every shard except the ice sheets | 485 GB |
| Staged FlatGeobuf tiers, all shards | **2.3 TB** (asia-east 680 GB, north-america 406, asia-west 403, south-america 280, africa 247, europe 136, oceania 107) |
| One merge batch | ~30 GB (from ≤ 92 GB of tiers) |
| `world_{shard}.mbtiles` | oceania 31 GB, europe 44, central-america 17, iceland 1.1 |
| `world.mbtiles` + convert temp + `world.pmtiles` | ~810 + ~690 + ~640 GB (Sept 2026) |

Peak is the end of the merges: DEM + every tier + the shard files, ~3.4 TB on
the 2026-10 run. `finish-world.sh` then deletes the DEM and every merged
shard's tiers and batches before the join, which needs ~2.2 TB on top of the
shard files. So a ~3.5 TB box needs `--purge-dem` and `--clean-work` per
shard (each loses the option of a re-merge without the DEM); ≥ 5.5 TB needs
neither. `run-shard.sh` refuses to start below 500 GB free (`MIN_FREE_DISK_GB`).

---

## 2. Before you rent anything: the settings decision gate

The remote build is expensive; the quality settings must be chosen **first**,
locally, with `contours/scripts/contour-experiment.ts`:

```bash
npx tsx contours/scripts/contour-experiment.ts            # builds the variant matrix
npx serve data/experiments/<run>                 # side-by-side compare page
```

Eyeball the compare page (warp scale, resampling kernel, `--simplification`,
`--minimum-detail`, `--simplify-only-low-zooms`, SRTM vs GLO-30) and bake the
chosen bundle into the defaults of `contours/scripts/build-contours-world.ts`, commit,
and push — **before** provisioning. Changing your mind after two shards means
rebuilding them.

**Decided 2026-08-22** (Mt Sonder, run `smooth-z13`): 2× cubicspline warp,
`--simplification=2 --simplify-only-low-zooms --minimum-detail=7
--maximum-tile-bytes=1000000`. The previous `--simplification=14` left z12–z14
contours visibly polygonal; 2 is smooth at every zoom for ~+35% archive size in
mountainous tiles (z15 unchanged). Only the tippecanoe flags changed, so a
future re-tune is a `--merge-only` re-run, not a cell rebuild — *if* the
shard's tier files are still on disk. A world build normally deletes them
(`--clean-work`), and then a re-tune is a full rebuild from the DEM. The experiment's
`baseline` variant mirrors these flags; `legacy-simp-14` is the old bundle.

**Found 2026-10-12: the zoom tiers were never applied.** tippecanoe's
`-L {"file","layer"}` object has no `minzoom` key, so every build so far — the
live `australia.pmtiles`, the live `world.pmtiles` and every offline pack —
tiled every 10 m contour into every zoom. A z9 tile then held ten times the
intended bytes; `--drop-smallest-as-needed` raises its threshold for the
*whole zoom level* from the densest tile, so Mt Sonder's live world z9 tile
kept one 100 m contour (its Australia tile kept them, quantised to a 16×16
grid by `--minimum-detail=4`). `scripts/tile-pipeline.ts` now reads each tier
as its own tippecanoe layer, gates it with a `-j` `$zoom` filter and folds the
layers back into `contour` with tile-join `-R` (`renameContourTiers`); the
experiment's `untiered` variant is the old behaviour. It is a tippecanoe-only
change, so where a build's tier files survive `--merge-only` re-tiers it with
no cell rebuild. **The world's do not**: the
September 2026 build deleted them with `--clean-work`, and its kept batches
and shards would not help (tippecanoe had already dropped the low-zoom lines
inside them), so re-tiering the world archive is a full rebuild from the DEM
(issue #135). The batch/shard joins already run tile-join, so only a
single-batch shard pays an extra tile-join pass. The re-tiered archives are
smaller at z9–z12 (Mt Sonder's z9 tile: 543 KB → 55 KB) and identical from
z13 up.

---

## 3. Provision and bootstrap

```bash
ssh root@<box>

# Optional but recommended when RAM < 128 GB: swap on the NVMe
fallocate -l 64G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile

# Put the checkout on the big NVMe volume, not a small root disk
export CHECKOUT_DIR=/mnt/nvme/tracknotes

curl -fsSL https://raw.githubusercontent.com/eamon-b/tracknotes/main/scripts/remote/bootstrap.sh -o bootstrap.sh
REPO_URL=https://github.com/eamon-b/tracknotes.git \
REPO_REF=main \
bash bootstrap.sh
```

(Or clone the repo by hand and run `./scripts/remote/bootstrap.sh` from it —
the script updates an existing checkout in place.)

`bootstrap.sh` installs build essentials, GDAL ≥ 3.6 (it hard-fails on older),
sqlite3, git, rclone, Node 22 from NodeSource, tippecanoe built from the pinned
`felt/tippecanoe` release (`TIPPECANOE_REF`, 2.79.0 — the world build refuses
any other; why that release is in `TIPPECANOE_VERSION`,
`scripts/tile-pipeline.ts`), the `pmtiles` CLI from `protomaps/go-pmtiles`, then
clones the repo and runs `npm ci`. It prints every version at the end — paste
that block into the build notes for the record. Re-running it is safe.

### If the box is Amazon Linux 2023 (AWS's default image)

`bootstrap.sh` is apt-only. Use `contours/scripts/remote/bootstrap-al2023.sh` instead
(the 2026-10 box): it installs the build tools with dnf, the geo stack
(GDAL 3.13, sqlite, Node 22, rclone) from conda-forge into a micromamba env on
the NVMe, builds tippecanoe 2.79.0 with the system compiler, and clones the
repo to `/mnt/nvme/tracknotes`. It needs `/mnt/nvme` mounted first; the
commands to stripe the instance-store drives are in its header, and a human
runs them (an agent's shell blocks `mkfs`).

```bash
ssh -i <key>.pem ec2-user@<box>
curl -fsSL https://raw.githubusercontent.com/eamon-b/tracknotes/main/scripts/remote/bootstrap-al2023.sh -o bootstrap-al2023.sh
bash bootstrap-al2023.sh                     # ~10 min
/mnt/nvme/tracknotes/scripts/remote/rclone-from-token.sh   # [r2] remote from ~/token
```

It writes `/etc/profile.d/geo.sh`, which only login shells read: **every**
`ssh box '...'` command and every detached job must start with
`. /etc/profile.d/geo.sh`, or it runs without GDAL, Node or the NVMe `TMPDIR`.
To launch a detached job over ssh without the session hanging, use
`ssh -n -f box 'cd ... && setsid nohup ... > log 2>&1 < /dev/null &'`.

### If the box is Ubuntu 20.04 (vast.ai and other GPU-container hosts)

`bootstrap.sh` targets Ubuntu 24.04 / Debian 12. Focal is EOL and cannot supply
GDAL >= 3.6 from apt: `focal/universe` has 3.0.4, and
`ppa:ubuntugis/ubuntugis-unstable` no longer publishes `gdal-bin` for focal —
its `InRelease` still resolves, so `add-apt-repository` *looks* like it worked.
Check with `apt-cache madison gdal-bin`; if 3.0.4 is the only candidate, install
the geo stack from conda-forge instead and put it first on `PATH`:

```bash
curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xvj -C /root bin/micromamba
export MAMBA_ROOT_PREFIX=/root/micromamba
/root/bin/micromamba create -y -p /root/micromamba/envs/geo -c conda-forge gdal tippecanoe sqlite
printf 'export MAMBA_ROOT_PREFIX=/root/micromamba\nexport PATH=/root/micromamba/envs/geo/bin:$PATH\n' \
  > /etc/profile.d/geo.sh && chmod +x /etc/profile.d/geo.sh
export PATH=/root/micromamba/envs/geo/bin:$PATH
```

Then run `bootstrap.sh` as usual and `apt-get remove -y gdal-bin` afterwards, so
exactly one GDAL is installed and no detached build can resolve the wrong one.
`/etc/profile.d/` is only sourced by login shells, so every `setsid nohup` build
must pass `env PATH=/root/micromamba/envs/geo/bin:...` explicitly.

**Check the disk before anything else.** A container host's disk is a hard
quota that `df` reports accurately — a 32 GB instance ENOSPCs at exactly 32 GiB,
and the world build needs ~3 TB.

If the repo is private, either use the HTTPS URL with a read-only deploy token
you create for this box, or generate an SSH key on the box
(`ssh-keygen -t ed25519`) and register the public key as a GitHub **deploy
key**. Never copy a personal token or `~/.ssh` key onto a rented machine, and
delete the key/token when you decommission it.

---

## 4. Build the `oceania` shard first (quality gate)

`oceania` contains Australia, so its output can be compared directly against
the live world archive on trails you know.

```bash
cd /mnt/nvme/tracknotes
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

Check against the live archive
(`https://tiles.contour-map-tiles.net/world/15/28450/18593.pbf`):
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

**Unattended:** `contours/scripts/remote/drive-world.sh` replaces the per-shard
commands below: it fetches every shard's DEM with retries, runs the cell
phases one shard at a time on all but six cores (largest first), and merges
up to six shards at once as their cells finish. `contours/scripts/remote/finish-world.sh`
then joins, validates and uploads (section 0).

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
# every world_*.mbtiles -> pmtiles-shards/*.pmtiles (all at once) -> tile-join
# -> world.mbtiles -> pmtiles convert -> world.pmtiles (verify + zoom check)
setsid nohup npx tsx contours/scripts/build-contours-world.ts --join \
  > logs/world-join-$(date +%Y%m%d-%H%M%S).log 2>&1 &
```

`--join` converts the shards to `.pmtiles` first because tile-join runs
`PRAGMA integrity_check` on every **mbtiles** input, one file after another on
one core, before it reads a tile (4.7 h of the September join), while it
memory-maps **pmtiles** inputs without a check and joins them on ~11 cores. The
tiles come out identical (tile count and decoded tiles compared on iceland).
The shard conversions run in parallel and a conversion newer than its shard is
reused, so on a box still merging, convert each shard as it lands (as the
October run did) and `--join` only waits for the last one. Disk: the converted
shards are ~0.9× the shard files and are deleted once `world.pmtiles`
validates.

Validate before uploading 640 GB (`finish-world.sh` runs all of these):

```bash
# Zoom range must be z9-15 and the layer must be `contour`
pmtiles show public/data/tiles/world.pmtiles

# Structural check of the archive (index, directories, offsets)
pmtiles verify public/data/tiles/world.pmtiles

# Spot-check real tiles (should return non-empty pbf bytes)
pmtiles tile public/data/tiles/world.pmtiles 15 28450 18593 | wc -c   # Mt Sonder, AU
pmtiles tile public/data/tiles/world.pmtiles 12 2126 1459   | wc -c   # Mont Blanc, FR/IT
pmtiles tile public/data/tiles/world.pmtiles 9  265  182    | wc -c   # z9 floor, Alps

# The tier check: Mt Sonder's z9 tile holds only 100 m contours
tippecanoe-decode -c public/data/tiles/world.pmtiles 9 444 290 \
  | grep -o '"elevation": *[0-9.-]*' | awk -F: '{n++; if ($2 % 100) bad++} END {print n, bad+0}'
```

Skip `PRAGMA integrity_check` on `world.mbtiles`: at world size it is hours of
single-threaded reading, and `pmtiles verify` covers the archive that ships.

Then upload:

```bash
rclone config          # one-time: see the setup block in upload-world.sh
./scripts/remote/upload-world.sh
```

`upload-world.sh` checks the PMTiles magic bytes, refuses a headerless
(killed-convert) file, uploads with `rclone copyto --s3-chunk-size 256M
--s3-upload-concurrency 32 --progress` (~230 MB/s, 613 GB in 44 min, from an i4i.8xlarge in
us-east-1; the old 8 × 128 MB parts managed 35-45 MB/s, ~4 h for the world),
then compares remote and local byte counts and prints the Worker URLs to check.

**Credentials:** put one Cloudflare API token (R2 edit, plus cache purge for
`upload-tiles.sh`) on the box as `~/token` and run
`contours/scripts/remote/rclone-from-token.sh` (section 7a). Nothing in this repo reads
or stores credentials otherwise. Revoke the token when the box is destroyed.

---

## 6a. Hybrid: tile the batches on a cheap box, join on NVMe

Use this when the build box has **rotational** storage (`lsblk -d -o NAME,ROTA`
shows `1`). The cell work and the tippecanoe tiling are CPU-bound and run fine
there; the two tile-join steps are not. tippecanoe writes its dedup mbtiles
schema (`map` z/x/y → hashed `tile_id`, `images` keyed by that hash), so
tile-join's ordered scan is a random b-tree probe per tile — 1–3 MB/s on a
spinning array, i.e. days per shard, and page-cache warming does not survive a
shared host's eviction. On NVMe the same join takes minutes.

On the build box, tile each shard into batches and stop before the join:

```bash
npx tsx contours/scripts/build-contours-world.ts --shard asia-east --merge-only --batches-only --clean-work
# leaves data/tiles/contours-world/asia-east/batch-NN.mbtiles + batch-NN.mbtiles.done
# (--clean-work removes only the tiers here; a re-run reuses finished batches)
```

Stream finished batches (and any shard already joined) to R2 as they appear:

```bash
rclone copyto --s3-no-check-bucket --s3-chunk-size 128M \
  data/tiles/contours-world/asia-east/batch-00.mbtiles \
  r2:aus-map-data/contours/world-build/batches/asia-east/batch-00.mbtiles
# ...and the .done marker next to it; shards go under contours/world-build/shards/
```

Then on a box with ≥ 3 TB of NVMe (core count barely matters — tile-join and
`pmtiles convert` are single-threaded), after `bootstrap.sh` and `rclone config`:

```bash
./scripts/remote/join-on-nvme.sh --pull-only   # start early; overlaps the build box
./scripts/remote/join-on-nvme.sh               # pull the rest, --join-batches per shard,
                                               # --join, validate, upload-world.sh
```

`--join-batches` removes a shard's batches only after its join succeeded, so a
killed join re-runs from the same inputs. Delete the `contours/world-build/`
prefix from R2 once `world.pmtiles` is verified there:
`npm run cleanup:tiles -- --world-build` lists it, `--world-build --delete`
deletes it.

### What the September 2026 run measured

The world archive (ten shards, ice sheets skipped) was built this way: batches
on an 80-core vast.ai box with a spinning array ($0.50/h), joins on an AWS
i4i.4xlarge (16 vCPU, 123 GB RAM, 3.4 TB instance-store NVMe, $1.50/h).

| Step | Measured |
| --- | --- |
| Batches in R2 (all shards) | 806 GB across 24 batch files + 3 pre-joined shards |
| R2 → EC2 pull, 8 streams | ~1 GB/s (640 GB in 11 min) |
| `tile-join` on NVMe, per shard, 3 concurrent | 40–95 GB/h each, CPU-bound at 2–3 cores per process |
| world `tile-join` (763 GB of shard files → 806 GB mbtiles) | 4.7 h integrity pass + 6 h merge |
| `pmtiles convert` (232 M tiles) | 5.5 h → **642 GB `world.pmtiles`** |
| Upload EC2 → R2 | ~45 MB/s (4.3 h); AWS egress ≈ $0.09/GB, i.e. ~$60 |

Things that bit us on this run, in addition to section 8:

- **tile-join runs `PRAGMA integrity_check` on every input before reading a
  tile.** That is a full read of each file (hours for 700 GB) with no output
  and ~10 % CPU. It is not stuck; `/proc/<pid>/io` `read_bytes` keeps climbing.
  Joined shard files (plain `tiles` table + unique index) check slower than
  tippecanoe's dedup batches. `--join` now sidesteps it by joining the
  shards as `.pmtiles` (section 6).
- **Never run `join-on-nvme.sh` while a shard is only partly uploaded.** Its
  per-shard step joins whatever batches are present, and once
  `world_<shard>.mbtiles` exists the shard is skipped forever. Gate each join
  on a completeness marker written by the build box after its last batch and
  `.done` marker are uploaded (we used `batches/<shard>/COMPLETE` holding the
  batch count and compared it with the local batch and marker counts).
- **Disk during the final phase:** shard files (~760 GB) + `world.mbtiles`
  (~810 GB) + the convert's temp file (~690 GB, in `$TMPDIR` — point it at the
  NVMe, the root disk is tiny) + `world.pmtiles` (~640 GB) does not fit in
  3.4 TB. Delete the shard files after `world.mbtiles` passes its zoom check
  and before `pmtiles convert`; they are rebuildable from the R2 batches.
- **One silently corrupt tier file** (`ERROR 1: Unexpected I/O failure` from
  GDAL, SIGBUS from tippecanoe) cost a batch two failed attempts. `ogrinfo`
  exits 0 on that error, so a validity scan must grep its stderr for `ERROR`.
- The EC2 security group pins SSH to an IP; a home connection's new address
  after a reboot looks exactly like a dead box. Check the group before
  assuming the instance is gone.

---

## 6b. What the October 2026 run measured (#135, the re-tier)

One AWS **i4i.8xlarge** (32 vCPU, 247 GB RAM, 2× 3.75 TB instance-store NVMe
striped to 6.9 TB, Amazon Linux 2023, on-demand ~$2.75/h, us-east-1) did
everything: the ten world shards (ice sheets skipped), a full Australia
rebuild and all 20 offline packs. Times are UTC, 2026-10-23 unless noted.

| Step | Measured |
| --- | --- |
| Box up → NVMe striped → bootstrap done | ~03:55 → 04:10 → 04:17 |
| DEM fetch, every shard (485 GB, 18,449 tiles) | 04:18 → 05:32 (74 min; 26 restarts for the Node HTTP crash) |
| Cells, all shards | 04:25 → 14:43 (~10 h; at 26 cores: asia-east 2 h 19, asia-west 2 h 09, north-america 1 h 15, africa 1 h 15, south-america 1 h 13, central-america 27 min) |
| Merges | oceania 10:15 (31 GB), europe 11:41 (44 GB), central-america 2 h 55 for its one batch (17 GB), rest 5 min, iceland 18 min; a 92 GB batch takes 2.5-3 h once the CPU is saturated; asia-east has 8 |
| Offline packs, 19 (3 at a time) | 10:47 → 11:32 (CDT 45 min; the rest under 4 min each) |
| Australia, full rebuild at `--parallel 24` | 14:44 → 17:21 (157 min, 13.5 GB) |
| Australia + 19 packs uploaded and verified | 20:17 → 20:32 (12.5 GiB at ~35 MiB/s) |
| Last merge (asia-east, 8 batches, 193 GB) | 2026-10-24 10:01 |
| Shards to `.pmtiles`, as each merge landed | Oct 24 07:45 → 10:41 (asia-east, 193 GB, took 40 min once merged) |
| Free DEM + tiers | 10:42 (2.65 TB freed in 30 s) |
| World `tile-join` of the pmtiles shards | 10:42 → 14:29 (3 h 47; 680 GB `world.mbtiles`) |
| `pmtiles convert` | 14:29 → 18:20 (3 h 51; **572 GB `world.pmtiles`**, 642 GB before the tier fix) |
| Validate (verify, zooms, three tiles, Mt Sonder z9 = 1,488 features, all 100 m) | 18:21 (1.5 min) |
| Upload to R2 at 32 × 256 MB parts | 18:21 → 19:05 (44 min, 613 GB at ~230 MB/s) |
| Worker serving it, `check:tiered` passing | 19:08 |

The tail after the last merge was 9 h: one 40-minute convert, the join (~11
cores at first, fewer later), the world convert (one core) and the upload.
In September the same steps took ~21 h (4.7 h of integrity checks, 6 h of
join, 5.5 h of convert, 4.3 h of upload). For the cost, see section 10.

What we learned, beyond section 8:

- **CPU-bound, not RAM-bound.** 98-100 % user CPU, no I/O wait, at most
  ~26 GB of RAM in use. See section 1 for the instance to choose.
- **The first driver idled 29 of 32 cores.** Two lanes that each ran a
  shard's cells and then its merge left the cores idle while both lanes
  merged (a merge is ~1.5 cores while reading its input). Splitting cells
  from merges (`--cells-only` lane + a merge pool, now
  `contours/scripts/remote/drive-world.sh`) took the load from 3 to ~75.
- **Batches of a shard merge in sequence**, so the biggest shard sets the end
  of the merge phase. `--batch` (with `--batches-only`) lets other processes
  pre-tile its last batches when cores free up; a merge in progress reuses
  any batch whose `.done` marker matches when it reaches it. If the two do
  meet on one batch, the sequential run deletes the half-built file and
  re-tiles it: wasted work, never a wrong archive. The next step is a
  driver that schedules batches, not shards.
- **Tier files are ~7× the old estimate**: 2.3 TB for the world.
- **Nothing should come from the laptop.** Its uplink (~0.9 MB/s) would have
  taken a day over the Australia inputs; the box fetched SRTM from AWS's
  public mirror and the basemap from build.protomaps.com in minutes (7a).
- **Publish what validates as it validates.** The Australia archive and the
  packs went live the evening of day one rather than after the world upload.
- **Join pmtiles, not mbtiles, and upload with many parts.** Converting the
  shards first (as they land) removed tile-join's 4.7 h single-core
  integrity check and let the join use ~11 cores; 32 × 256 MB parts tripled
  the upload rate. Both are now the default (`--join`, `finish-world.sh`,
  `upload-world.sh`).
- **What is left of the tail is single-threaded.** The world `pmtiles
  convert` (~4 h) and most of the join run on a few cores while the other 28
  idle: ~$25 of box. Moving them to a smaller box means copying ~600 GB off
  instance storage that is wiped when the instance stops, which costs about
  what it saves; not worth it for one run.
- **Spot-checking an mbtiles by hand:** tiles are gzipped and `tile_row` is
  TMS (flip `y` to `2^z - 1 - y`); `tippecanoe-decode` handles both and
  reads `.pmtiles` too.

## 7. Deploy the Worker and verify

The Worker serves `/{source}/{z}/{x}/{y}.pbf`. Both its sources, `world` and
`contours` (an alias kept for shipped app builds, #228), read
`contours/world.pmtiles`, so a rebuild needs no Worker change; deploy only if
the Worker itself changed.

```bash
cd contours/worker && npx wrangler deploy

curl -s https://tiles.contour-map-tiles.net/health | jq .
#   expect ok: true overall (the top level follows `world`), and world and
#   contours both ok with the same archive etag
curl -sI https://tiles.contour-map-tiles.net/world/15/28450/18593.pbf
#   expect 200 + application/x-protobuf (204 means "no contours here", which is
#   correct over ocean but wrong at Mt Sonder)
```

There is no fallback archive any more: while `world.pmtiles` is missing or
mid-upload, `/health` fails and every contour tile is a `500`. Upload over the
live key only once the new archive has validated.

Edge cache: re-uploading the same key leaves stale bytes cached for up to 24 h,
under both `/world/…` and `/contours/…` URLs; purge both prefixes if the new
tiles must land at once.

Then run `npm run check:tiered` for the tier density, and
`npm run check:contours-alias`, which fails unless
`/health` reports `sources.contours.archive.key` as `contours/world.pmtiles`
(the Worker deploy that made `contours` an alias is live) and `/contours/…` and
`/world/…` serve byte-identical tiles for Mt Sonder z9 and a Kosciuszko z12
(the edge no longer holds the retired Australia tiles under `/contours/*`).
The density check alone passes either way, because the Australia archive was
tiered too. The alias check is not part of `check:tiered` (CI runs that on pull
requests, before the Worker change is deployed). After the #228 cutover, run it once the Worker is deployed and
`tiles.contour-map-tiles.net/contours/*` is purged.

A purge reaches only Cloudflare's edge. Tiles go out with
`Cache-Control: public, max-age=86400`, so a phone that fetched an Australian
tile under `/contours/…` before the cutover can keep drawing the old SRTM lines
from its own HTTP cache for up to 24 h. Nothing server-side can shorten that;
expect it rather than chase it.

---

## 7a. The offline packs on the same box

The offline packs are tippecanoe builds too, and the box has the pinned
release and the cores the laptop lacks. **Nothing comes from the laptop**: a
home uplink (~0.9 MB/s on 2026-10) would take a day over the inputs, and the
box downloads all of them in minutes.

**Inputs, fetched on the box:**

- **Copernicus GLO-30** for every pack, Australia included (`data/dem-glo30`):
  already there if the world DEM is unpurged. Otherwise `build-tiles.ts`
  prints the `fetch-dem-copernicus.ts --bbox` command for what is missing.
  (Until #228 the Australian packs were cut from SRTM in `data/dem`.)
- **Basemap**: `--protomaps-url https://build.protomaps.com/<YYYYMMDD>.pmtiles`
  (the newest daily build; `pmtiles extract` reads only each trail's bbox).
  The laptop's `planet.pmtiles` is an Australia-only extract from May 2025.
- **Te Araroa's GPX** is not in the repo: run `npm run sync:te-araroa` on the
  box first, or its pack fails with "No GPX file found".

**The Australia archive is retired** (#228): `contours/australia.pmtiles`
stays in R2 as a frozen download of its 2026-10-23 build and is not rebuilt.
The October 2026 run rebuilt it here from SRTM in 157 min at `--parallel 24`;
`build-contours-australia.ts` and `upload:tiles --contours` are gone (recover
them from git history if it is ever revived).

**Offline packs:** `build-tiles.ts --trail <dir> --protomaps-url <url>` per
trail, three at a time (`ls data/trails | xargs -P 3 ...`): trails have their
own work and output dirs, and the only shared file, `style.json`, is the same
for all. 19 packs took 45 min, CDT alone 45 min, every other trail under 4.
Check each pack's z9 tiles hold only multiples of 100 m before uploading,
then `npm run upload:tiles -- <trail ids>`: one call handles both sizes, wrangler
under 300 MiB and the `r2` rclone remote over it (CDT, Te Araroa).

**Credentials for the uploads.** `upload-tiles.sh` uses one
`CLOUDFLARE_API_TOKEN` for wrangler's R2 writes and the manifest cache purge,
and refuses to upload anything without it. The same `~/token` as rclone works:

```bash
export CLOUDFLARE_API_TOKEN=$(tr -d '[:space:]' < ~/token)
export CLOUDFLARE_ACCOUNT_ID=<printed by rclone-from-token.sh>
export RCLONE_REMOTE=r2
```

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

> **The DEM fetcher dies every few hundred tiles on Node 22.**
> undici, Node's bundled HTTP client, throws an uncaught
> `AssertionError [ERR_ASSERTION]: false == true` from `Parser.finish` when a
> TLS socket ends mid-response. It kills the process outside the fetcher's own
> retry loop. Tiles land via `.part` files, so nothing is corrupted: re-run
> it. `drive-world.sh` does, up to `FETCH_ATTEMPTS` times per shard.

> **Login-shell environment.** On the conda-based boxes (Amazon Linux,
> Ubuntu 20.04) GDAL, Node and `TMPDIR` come from `/etc/profile.d/geo.sh`,
> which `ssh box 'cmd'` does not read. Source it in every command.

## 9. Resume after a crash

Everything is resumable; nothing needs to start over.

| Situation | Do this |
| --- | --- |
| Build died during the cell phase (OOM, disk, reboot) | Re-run the exact same `./scripts/remote/run-shard.sh <shard>`. Cells with a `.done` marker in `data/tiles/contours-world/{shard}/` are skipped; only pending cells rebuild. |
| Build died during the tippecanoe merge | `./scripts/remote/run-shard.sh <shard> --merge-only` — redoes only the merge from the staged `*_z*.fgb` tiers (no GDAL work). |
| A cell looks wrong / settings changed | Delete that cell's `.done` marker and `{cellId}_z*.fgb`, then re-run the shard. Or `--force` to rebuild everything. |
| Batched merge died during tippecanoe | Re-run the same `--merge-only` (or `--batches-only`) command: a batch is reused only when its `.done` marker records the same cell list, the same tippecanoe release *and* the same settings hash (`contourSettingsHash`); the one that died re-tiles. A batch tiled with other settings or by another release — any batch from before the 2026-10 tier fix — is re-tiled, and `--join-batches` refuses it. This is crash recovery, not a way to re-tune: changing the settings re-tiles every batch from the tiers. |
| Batched merge died during tile-join | `--join-batches` re-joins the kept batches; on a spinning disk consider section 6a instead. |
| Join died | Re-run `--join`. Delete any partial `world.mbtiles` / `world.pmtiles` first — a killed run leaves a headerless file. |
| Upload died | Re-run `upload-world.sh`; rclone restarts the multipart upload. Verify byte counts afterwards (`--verify-only`). |
| DEM download died | Re-run; the fetcher skips tiles already on disk. |

A cell that has partial tier files but **no** `.done` marker is deliberately
skipped by the merge (with a warning) rather than silently contributing half a
cell's contours — if you see those warnings, re-run the shard without
`--merge-only` first.

---

## 10. Cost

What the builds actually cost (AWS on-demand, us-east-1):

| Run | Machine × hours | Compute | AWS egress to R2 (~$0.09/GB) | Total |
| --- | --- | --- | --- | --- |
| Sept 2026 (world only) | vast.ai 80-core ~$0.50/h + i4i.4xlarge $1.50/h, ~4 days | ~$100 | ~640 GB → ~$60 | ~$160 |
| Oct 2026 (world + Australia + 20 packs) | i4i.8xlarge $2.75/h × ~39.5 h (Oct 23 03:55 → Oct 24 ~19:30) | ~$110 | ~630 GB → ~$57 | **~$165** |

The October figure counts the box until the world upload verified; every
hour it stays up after that is another $2.75. Without this run's pmtiles join
and faster upload the tail would have been ~21 h instead of 9 h: another ~$33.

Next time, the instance choice in section 1 trades cost per hour against
hours: the CPU work is ~600-700 vCPU-hours on any box, while the tail after
the last merge (~8 h of join and convert, ~45 min of upload) takes about the
same wall time on any box. The egress is the
same everywhere (Hetzner's unmetered bandwidth is the only way to avoid it).

Ongoing:

| Item | Cost |
| --- | --- |
| R2 storage: `world.pmtiles` ~613 GB + Australia 13.5 GB + packs ~2.5 GB @ $0.015/GB-month | **~$9 / month** |
| R2 Class A ops (upload, multipart) | < $0.10 per rebuild |
| R2 egress | **$0** (zero-egress is the whole reason the archive lives there) |

The retired Australia archive stays in R2 as a frozen download for ~$0.19 a
month; retiring it saved the 24 h build and the second pipeline, not storage.

---

## 11. After the build

- Refresh the world archive's size and tile count on the docs site
  (`contours/site/`, from `pmtiles show`).
- Check the tiers are live: `npm run check:tiered` (the Mt Sonder z9 tile on
  both worker sources, which now read the same archive, and every pack's z9),
  and `npm run check:contours-alias` (the `contours` alias in `/health` and
  identical tiles under both sources, see section 7). `check:tile-packs` includes it
  since the October 2026 rebuild, so the weekly workflow keeps checking it.
- Delete `contours/world-build/` (`npm run cleanup:tiles -- --world-build
  --delete`) and, once every live pack manifest points at the rebuilt packs and
  a week has passed, the superseded pack objects (`npm run cleanup:tiles`, then
  `-- --delete`).
- Destroy the build box, revoke the R2 token and any deploy key.
- Record the actual timings, sizes and cost in a section like 6b (and the
  cost table in section 10), so the next rebuild's estimates are real numbers.
