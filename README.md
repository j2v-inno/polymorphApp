# transapp (Fluid App)

Single-spa Parcel + thin Node/TypeScript orchestration backend implementing Orion's
`/acquisition → /qualification → /batch → /download` pipeline. See
[FLUID_APP_DEV_CONTEXT.md](./FLUID_APP_DEV_CONTEXT.md) for the full design spec this
build implements — read it before changing routing, auth, or endpoint behavior.

## Layout

```
transapp/
├── backend/     thin orchestration layer — Express + TypeScript, talks to uw-be
├── frontend/    single-spa Parcel — React + TypeScript, talks only to backend/
└── mock-uwbe/   fake uw-be for local testing — canned Style A/B responses, no DB/Redis/S3
```

## Setup

```
pnpm install
cp backend/.env.example backend/.env
```

The example `.env` already points `UWBE_BASE_URL` at `mock-uwbe` (`http://localhost:4200/`)
so you can run the full pipeline with zero Orion access. Point it at a real
environment's URL + a real `UWBE_API_TOKEN` to test against actual uw-be instead.

## Run locally (against the mock — no Orion access needed)

Three processes, in order:

```
pnpm dev:mock-uwbe   # http://localhost:4200 — fake uw-be
pnpm dev:backend     # http://localhost:4100
pnpm dev:frontend    # http://localhost:9100 — self-mounting standalone dev harness
```

Then either drive the frontend directly (see below) or hit the backend with curl to
walk the whole pipeline against a real PDF, exactly as the frontend would:

```bash
# 1. acquisition — register, gate-check, upload, complete
curl -X POST http://localhost:4100/api/acquisition/register-and-upload \
  -F "file=@/path/to/some.pdf" \
  -F projectCode=TEST-UNIFIED-WF -F workflowCode=WF001 -F firstTaskUid=3758 \
  -F fileName=some.pdf -F fileUniqueIdentifier=job1-batch1-some.pdf
# -> { data: { fileId, taskUid, gate: { isTextExtractable, totalPages }, ... } }

# 2. qualification — needs workflowCode too (to resolve this task's task_uid via
# get-all-tasks — TaskContext doesn't carry workflowCode or task_uid directly)
curl "http://localhost:4100/api/qualification/context?projectCode=TEST-UNIFIED-WF&workflowCode=WF001&taskId=3759&fileId=<fileId>"
curl -X POST http://localhost:4100/api/qualification/complete -H "Content-Type: application/json" \
  -d '{"projectCode":"TEST-UNIFIED-WF","taskUid":"<taskUid>","fileId":<fileId>,"pagesWithErrors":[],"outcome":"clean"}'

# 3. batch split — splits into 2-5 roughly-equal chunks, routed per §6.3.1.
# No taskUid param — resolved server-side via get-all-tasks, same as qualification.
curl -X POST http://localhost:4100/api/batch/split -H "Content-Type: application/json" \
  -d '{"projectCode":"TEST-UNIFIED-WF","workflowCode":"WF001","taskId":3760,"jobId":87789,"batchId":557886,"fileId":<fileId>,"fileName":"some.pdf"}'
# -> { data: { children: [{ fileId, taskUid, pageNumbers, routedTo }, ...] } }

# 4. download — also needs workflowCode/taskId/jobName/batchName (get-file-task-output
# requires task_uid, resolved the same way)
curl "http://localhost:4100/api/download?projectCode=TEST-UNIFIED-WF&workflowCode=WF001&taskId=3761&jobName=UF0001&batchName=UF0001013&fileIds=<childFileId1>,<childFileId2>"
```

Notes on the mock: `mock-uwbe/server.js` implements canned versions of the uw-be
endpoints this app calls (including `get-task-next-file-with-start`, added later —
not in the original 7-endpoint set §5 lists), stores uploaded/registered file bytes
in memory, and serves them back for the batch-split and download steps — so a real
multi-page PDF genuinely gets split and the resulting files are genuinely
downloadable. `update-file-meta-data` edits are also persisted in-memory per file ID
(`metaDataByFileId` in `server.js`) and echoed back by
`get-task-ongoing-file`/`get-task-next-file-with-start`, so the qualification
screen's metadata editor round-trips visibly during a demo. It does *not* validate
the `api-token` header or enforce `project_code` tenancy — it exists to exercise the
wiring, not to model uw-be's actual behavior/bugs (§7). Edit
`get-task-ongoing-file`'s `meta_data.pages_with_errors` in `server.js` to test the
manual-fix routing path in step 3.

### Driving the frontend in a browser instead of curl

`pnpm dev:frontend` runs `webpack serve --env standalone`, which uses
`standalone-single-spa-webpack-plugin` to generate a dev harness that registers and
self-mounts the app with `customProps: {}` (verified — see the generated
`index.html`'s inline script). Since no `taskCode` is supplied, `App.tsx` falls back
to parsing the URL (§3.2) — append the launch query params to drive a screen, e.g.:

```
http://localhost:9100/?task_code=ACQUISITION&project_id=334&job_id=87789&batch_id=557886&file_id=555359&task_id=3758&user_id=503&project_code=TEST-UNIFIED-WF&user_login_id=PV4
```

Change `task_code`/`file_id`/etc. between page loads to move through
qualification/batch/download using the IDs each previous step returned (the curl
walkthrough above and this browser walkthrough exercise the exact same backend
routes, so IDs from one can be reused in the other).

**Mode selection is now path-based, not taskCode-based** (`mode-path.ts`). A real
uw-fe launch lands on `localhost:9100/<mode>?...` — the path segment (`acquisition`,
`batch-split`, `transformation`, `qualification`, `download`) picks the screen directly, matching
each task's own `external_app_integration.web_app.url` configured in uw-be (set
once per task at wiring time, e.g. BATCH_SPLIT's task gets
`.../batch-split`, never just the bare origin). This was previously resolved
server-side from `task_id` via the workflow graph — fragile, since anything
upstream of `taskCode` (an empty `task_id` from uw-fe, a task rename causing
confusion about which task is which when wiring the integration URL, etc.) broke
every screen at once. `taskCode` is still resolved and used for everything else
(data operations), just not for picking which screen to render. The query-param
form above (`?task_code=ACQUISITION&...`, no path) still works as a fallback when
hitting the bare origin directly.

There's also `pnpm --filter transapp-frontend dev:integrated`, which serves the raw
bundle for attaching to a real single-spa root config via import-map-overrides
instead of self-mounting — not useful yet since Orion's shell has no root config to
attach to (open question #7/#8, still unresolved).

**Parcel mode** (mounted inside Orion via `mountRootParcel`) can only be exercised
once this bundle is registered in Orion's shell itself.

## Run locally (against real uw-be)

Point `backend/.env`'s `UWBE_BASE_URL`/`UWBE_API_TOKEN` at a real Orion environment
and service token, then run `pnpm dev:backend` + `pnpm dev:frontend` as above (skip
`dev:mock-uwbe`). You'll need real `project_code`/`workflow_code`/task UIDs for that
environment — the mock's made-up IDs won't resolve against real uw-be.

### Standing up uw-be itself locally (done once, 2026-08-12)

uw-be (`d:\Dev\github\uw-be`) already had a working local setup — composer deps,
`.env` pointed at `uw_be_dev` on `127.0.0.1:3306`, migrations already applied. Two
things were needed to actually exercise it end-to-end:

1. **MySQL wouldn't start (XAMPP).** Not a port conflict, despite what the error
   looked like — `mysql/data`'s ACL only granted SYSTEM/Administrators write
   access, and the session running XAMPP was unelevated (UAC deny-only), so
   mysqld got `Errcode 13 Permission denied` on `ibdata1`/`aria_log_control`.
   Fixed once, permanently, via an elevated `icacls ... /grant ...:(OI)(CI)M /T`
   on `C:\xampp\mysql\data`.
2. **File storage.** uw-be's presigned-URL code (`file_output_upload_url` on
   register-*, `download_url` on get-task-ongoing-file/get-file-task-output) is
   gated on `config('filesystems.default') == 's3'` — with the default
   `FILESYSTEM_DRIVER=local`, those fields are null by design, not a bug. No
   Docker available in this environment (AWS WorkSpace, no nested
   virtualization), so [MinIO](https://min.io) runs as a **standalone binary**
   (`d:\Dev\tools\minio\minio.exe server ./data --address ":9000" --console-address ":9001"`,
   downloaded directly, no container) instead. uw-be's `.env` points at it via
   `AWS_ENDPOINT=http://127.0.0.1:9000` + `AWS_USE_PATH_STYLE_ENDPOINT=true`.

Test data — a dedicated `TRANSAPPTEST`/`MAINFLOW` project (isolated from whatever
else already lives in that DB) with the four tasks wired sequentially — plus a
service-account Sanctum token, created via `php artisan tinker` (there's no
seeder/factory for this in uw-be; see tinker snippets in git history/chat log if
recreating). **Two non-obvious task-level requirements**, easy to miss by only
reading migrations:
- `tasks.unit` (varchar(3), NOT NULL, no default) must be set — used `'pg'`.
- `tasks.upload_to_storage` must be `1` on any task whose file needs a
  presigned URL (ACQUISITION, BATCH_SPLIT here) — it's `0` by default, and its
  absence silently keeps `file_output_upload_url`/`file_s3_path` null even with
  S3 correctly configured.
- `task_next_tasks.input_source` (varchar(3), NOT NULL, no default) must be set
  when wiring the DAG via `->nextTasks()->attach($id, ['input_source' => 'out'])`.

### Real endpoint behavior that differs from FLUID_APP_DEV_CONTEXT.md

Discovered by reading the actual controllers and hitting them directly — already
fixed in this codebase, documented here so nobody "fixes" it back:

- **§5's Style A/B table is wrong for 4 of its 5 "Style B" endpoints.** Only
  `flow-back-file-task` (`FileController`) is really Style B, and even then its
  shape is exactly `{status, error}`, nothing else, ever. `update-file-status`,
  `update-file-meta-data`, `get-task-ongoing-file`, `get-file-task-output` are all
  `TaskProcessController` methods using the shared Style A `respond()` helper.
- **`register-job-batch-file`/`register-file` need `start_task: true`.** Without
  it, the entire block that computes `file_output_path`/`file_s3_path`/
  `file_output_upload_url` never runs — they come back null unconditionally,
  regardless of storage config (`TaskProcessController.php:753,1300`).
- **`register-file`'s `file_data` param is real but nearly useless for this app**:
  server-side validation caps it at "may not be greater than 500000 characters"
  (~375KB raw) and requires a genuine multipart file field, not base64 JSON.
  `registerFile()` never sends it — it always uses the same
  register-then-PUT-to-`file_output_upload_url` pattern as acquisition.
- **The doc's `file_unique_identifier` param doesn't exist** — the real field is
  `unique_identifier`.
- **`get-task-ongoing-file` only reads an already-started session; it does not
  start one.** Calling it for a file that just advanced onto a task via the DAG
  400s with `"Invalid request of file status already completed."` — misleading,
  but it means "no active `file_task_users` session found," not "the file is
  done." `get-task-next-file-with-start` is the endpoint that actually claims/
  starts that session (and returns the file's data in the same call) — this app
  now calls it wherever a screen needs to fetch/claim "my current file"
  (`qualification.ts`'s `/context`, `batch-split.ts`'s parent-file fetch), and
  keeps `get-task-ongoing-file` available for the "refresh an already-claimed
  session" case it's actually built for.
- **`get-task-ongoing-file` and `get-task-next-file-with-start` use different field
  names for the same things** — the former: `download_url`/`s3_file_path`; the
  latter: `input_download_url`/`s3_path`. Both nest under `data.file`.
- **`get-all-tasks` nodes key on `code`, not `task_code`** — `task_code` is only a
  SQL alias two *other* endpoints use internally on their own joined queries.
- **`get-file-task-output` requires `task_uid`/`job_name`/`batch_name`**, not just
  `project_id`/`file_id` as the doc's table implies.
- **TaskContext doesn't carry `workflow_code`, but three endpoints
  (`get-all-tasks`, indirectly needed by qualification/batch/download to resolve
  `task_uid`) need it.** Every one of those three screens now has a manual
  workflow-code input as a result — worth raising with Vibhor/JP as a candidate
  addition to Orion's launch `customProps`/URL params (§3), same category as the
  other open questions in §13.

### RESOLVED (2026-08-15): `input_download_url`/`download_url` staying null

Root-caused while building the Transformation task (the first thing that
actually needs to *download* a self-registered file's bytes, not just preview
or re-upload them) — this was never actually about `input_source_user_task_id`
being unset. It was two independent gaps in `uw-be` itself, both real bugs, not
missing tinker setup:

1. **Missing task config, not missing API call.** `get_task_next_file_with_start`
   and `get_task_current_file` (the real handler behind `get-task-ongoing-file`)
   both gate their *entire* download-URL resolution block on
   `$task->download_from_storage == 1`. Every task cloned from this app's
   `QUALIFICATION` (including via `create_chapterflow_workflow.php` and
   `create_ragflow_workflow.php`) had this at `0` — so the whole block, fallback
   logic included, was skipped outright. Now explicitly set to `1` in
   `create_ragflow_workflow.php` for TRANSFORMATION/QUALIFICATION/DOWNLOAD. (Left
   as-is on MAINFLOW/CHAPTERFLOW per the user's explicit instruction not to touch
   existing workflows — flagged here since those tasks likely have the same gap.)
2. **Self-registered files (`register-file`/`register-job-batch-file` with
   `start_task=true`, no DAG advance) were never resolvable at all** in either
   endpoint — both only ever tried `input_source_user_task_id`-keyed paths
   (which stay null for a directly-registered file) or the plain
   `root_input_path` scheme (which only matches a file that arrived via DAG
   advancement). Fixed in `uw-be`'s `TaskProcessController.php`: both endpoints
   now fall back to the **first (lowest-id) `file_task_users` row for this
   file_task_id** — the one `register_file`'s own upload-path computation
   actually keys the S3 object to — confirmed against real files in MinIO
   storage. (`get_task_current_file` already had a *similar* fallback, but it
   used whichever session happened to be currently active/ongoing, not the
   original one — silently wrong for a file that's been reclaimed since
   registration, which is every by-chapter child by the time anything re-reads
   it.)

Also hit, unrelated to the above but blocking the same test session: uw-be's
task-row cache (`task_id_wn_`/`task_uid_wn_` etc.) needed manual busting after
the `download_from_storage` data fix — see the task-config-cache gotcha this
app's own memory already documents; a direct DB/tinker edit to a `tasks` row
is invisible to any endpoint until both cache key forms are cleared.

Verified end-to-end against real local uw-be with a real book (Heroes of
Olympus, RAGFLOW workflow): batch-split → transform → qualify all correctly
resolve and serve real file bytes now.

## Build

```
pnpm build   # backend -> backend/dist, frontend -> frontend/dist/innodata-transapp.js
```

## Deployment

Added 2026-08-17, mirroring uw-fe's/uw-be's CI/CD shape (`.github/workflows/ci.yml`
+ `deploy.yml`, GHCR images, a self-hosted-runner `deploy` job, `manual-deploy.sh`
as the bridge until that runner exists) — scaled down to what this repo actually
has (no lint/audit/test tooling exists here yet, so CI is just typecheck +
gitleaks + a compile check) and to two images instead of one, since transapp is
a single repo with both a frontend and a backend.

**Target**: `https://rnd-fe-unifiedworkflow.innodata.com`, under two new
subpaths on the *same* domain/box uw-fe already runs on — `/ext/app/wa`
(frontend) and `/ext/app/api` (backend). Not a new domain, not a new server.

### Pieces added

| File | Role |
|---|---|
| `backend/Dockerfile`, `frontend/Dockerfile` | Multi-stage builds. Backend: plain Node runtime (`node dist/server.js`). Frontend: **static files only** — `nginx:alpine` serving the webpack build output, no Node process at runtime. |
| `frontend/deploy/index.html` | Hand-authored standalone bootstrap HTML — see "Why not the standalone plugin's own HTML" below. |
| `docker-compose.deploy.yml` | Pulls both images from GHCR by tag; used by both `deploy.yml` and `manual-deploy.sh`. |
| `manual-deploy.sh` | Same role as uw-fe/uw-be's own script — pull + retag + recreate + health-check — adapted for transapp's two services in one compose file (`--app fe\|be`). |
| `.github/workflows/ci.yml` | typecheck → gitleaks → compile, then (on push to `dev`) build+push both images, then calls `deploy.yml`. |
| `.github/workflows/deploy.yml` | Self-hosted-runner job; queues indefinitely until a `[self-hosted, dev]` runner is registered for *this* repo (same situation uw-fe's deploy.yml was in when first added) — use `manual-deploy.sh` until then. |
| `nginx/rnd-fe-unifiedworkflow.snippet.conf` | Two `location` blocks to splice into the box's existing hand-maintained nginx config for this domain (confirmed: one file, no `conf.d/*.conf` include convention — can't be a drop-in). |

### Why not the standalone plugin's own HTML

`standalone-single-spa-webpack-plugin` (already a dependency, used by
`pnpm dev:frontend`) only alters HTML via `html-webpack-plugin`'s dev-server-time
hook — confirmed empirically: a plain `webpack --mode=production --env standalone`
build emits **no** `index.html` at all, only the JS bundle. Even when it does run
(under `webpack serve`), it hardcodes the bundle's script src as `"/" + filename`
— an absolute path from the domain root that 404s the moment this app is hosted
under a subpath instead of at `/`. `frontend/deploy/index.html` replicates the
same single-spa bootstrap (`registerApplication` + `start()`, matching the
plugin's own `applicationRuntime()` template) with the bundle path parameterized
instead of hardcoded — `BASE_PATH_PLACEHOLDER`, substituted by `frontend/Dockerfile`
at image-build time via `sed`.

### Frontend vs. backend proxying — deliberately different, see the snippet's own comments

Matches the box's existing convention for `/app`/`/staging` exactly for the
frontend (`proxy_pass http://localhost:9100;`, no trailing slash — nginx forwards
the full path unchanged, so `frontend/Dockerfile` nests the build output under
that same `/ext/app/wa/` path *inside* the image, needing zero custom nginx
config in the container). The backend instead strips the prefix
(`proxy_pass http://localhost:4100/;`, trailing slash) since its Express routes
are hardcoded as `/api/...` with no reason to know about an external prefix —
stripping means zero backend code changes, at the cost of being a different
convention than the frontend's. Both are intentional, not an inconsistency.

### Manual steps still needed (not something this session could do)

- **Push this repo to GitHub** (blocked on SSH auth per [[project_transapp_ui_and_git_init]] — user pushes manually).
- **GitHub `dev` environment — variables**: `BACKEND_URL` (`https://rnd-fe-unifiedworkflow.innodata.com/ext/app/api`), `FRONTEND_BASE_PATH` (`/ext/app/wa`), `FRONTEND_PORT` (`9100`), `BACKEND_PORT` (`4100`), `ALLOWED_ORIGINS` (`https://rnd-fe-unifiedworkflow.innodata.com`), `UWBE_BASE_URL` (real RND uw-be, e.g. `https://rnd-be-unifiedworkflow.innodata.com/api/`), `APP_URL` (`https://rnd-fe-unifiedworkflow.innodata.com/ext/app/wa/`, cosmetic — shown on the GH environment page).
- **GitHub `dev` environment — secrets**: `UWBE_API_TOKEN` (a real Sanctum personal access token for that uw-be instance — same kind of credential the local `.env`'s `UWBE_API_TOKEN` holds, but scoped for RND).
- **Register a self-hosted runner** for *this* repo on the RND box with `[self-hosted, dev]` labels (uw-be's runner is presumably repo-scoped too, not reusable across repos — confirm before assuming otherwise). Until then, `deploy.yml` will queue forever (expected) — run `manual-deploy.sh` by hand after each `ci.yml` build.
- **Splice `nginx/rnd-fe-unifiedworkflow.snippet.conf`'s two `location` blocks** into the box's existing server block for this domain, then `nginx -t && systemctl reload nginx`.
- **Not tested end-to-end**: this environment has no working Docker daemon (Docker Desktop's backend can't start — no nested virtualization), so none of `docker build`/`docker compose` could actually be run here. Everything above was written by close analysis of uw-fe's/uw-be's own working Dockerfiles/compose files/CI, not verified by executing it. Build both images on a real Docker host and smoke-test before pointing the real domain at them.

## Verification status

Typechecked and built clean end-to-end (both packages).

**Against `mock-uwbe`:** a genuine multi-page PDF was pushed through all four
backend routes in sequence — register → text-extractability gate → upload →
qualify → split into real, independently-openable PDF chunks → resolved to
working download links. Frontend's standalone dev harness confirmed to serve,
bundle, and self-mount with the expected empty `customProps`.

**Against real local uw-be (MySQL + MinIO, see above), with a real PDF, real
service token, real project/workflow/tasks:**
- `/acquisition` — fully verified end-to-end: register → gate (18 real pages,
  36,988 chars extracted) → real presigned-URL PUT to MinIO → complete → DAG
  auto-advance to the next task, all confirmed via direct DB inspection.
- `/qualification` — context-fetch, pages-viewed, and complete (clean) all
  verified end-to-end after fixing the `get-task-next-file-with-start` issue
  above. The page-viewer's actual PDF display is blocked by the
  `input_download_url` gap noted above, not yet resolved.
- `/batch` — task-graph resolution and the request/response plumbing are
  verified; the actual split is blocked by the same `input_download_url` gap
  (can't fetch the parent file's bytes).
- `/download` — not yet exercised against real uw-be (blocked upstream by the
  same gap — nothing has reached the download-ready task yet in this test run).

**Not yet done:** interactive verification of the React screens in an actual
browser (form behavior, page-viewer UX, error states). Parcel mode is entirely
unverified since no single-spa root config exists yet to mount into (§13 #7/#8)
— a plan for a uw-fe test page that mounts this bundle via `mountRootParcel` has
been discussed but not yet built.

## What's implemented vs. deliberately not

Built per §12's Phase 1–3 scope in one pass (all four screens), following every
decision the dev-context doc makes and flagging every one it explicitly leaves open
with inline comments (`FLUID_APP_DEV_CONTEXT.md §13, open question #N`) rather than
guessing silently:

| Area | Status |
|---|---|
| Response envelope parser (Style A/B, §5) | Implemented, endpoint-keyed lookup table |
| `/acquisition` register → upload → gate → complete (§6.1) | Implemented. Gate outcome (reject vs. flag) is config-driven (`ACQUISITION_GATE_MODE`) pending **blocker #1** (owner: Bhanu) |
| `/qualification` view-tracking + 3-way routing (§6.2) | Clean/rework implemented. Archive returns `501` pending **blocker #2** (owner: Rifky) |
| `/batch` split + dynamic task-graph routing (§6.3/§6.3.1) | Implemented, including the intentional DAG-routing deviation flagged to Vibhor. `get-all-tasks` verified Style A. The `input_download_url` gap that used to block this end-to-end is now resolved — see "RESOLVED" note below |
| `/batch` by-chapter split method (`splitMethod: "by-chapter"`) | Implemented — see "Batching by chapter" below. Not in the original dev-context doc at all; added for a use case (a single large multi-chapter PDF that needs one output file per chapter, each individually qualified) that §6.3's fixed 2–5-equal-chunks model doesn't cover |
| Qualification PDF preview + custom metadata editor | Implemented — native browser `<iframe>` preview (`input_download_url#page=N`) and a free-form key/value editor over `update-file-meta-data`, both additions beyond §6.2's original scope |
| `/transformation` — PDF text → structured XML/JSON | Implemented — see "Transformation" below. **Deliberately reverses FLUID_APP_DEV_CONTEXT.md §1/§6.4/§9.2/§13#5**, which all state RAG transformation is owned by a separate app entirely, not this one. Brought in-house per direct user decision (2026-08-15) — flagged here explicitly rather than silently overriding the doc's stated scope, same as every other deviation in this table |
| `/download` link resolution (§6.4) | Implemented for a known set of file IDs. How this screen discovers *all* sibling split-file IDs from one launch context isn't specified in §6 — see the TODO in `frontend/src/modes/download/DownloadScreen.tsx` |
| Parcel-mode auth (§10) | Backend checks token *presence* (`x-fluid-parcel-token`), not validity — the validation mechanism isn't specified upstream |
| Standalone-mode auth (§13 #6) | Not implemented — backend returns `501` unless `ALLOW_UNAUTHENTICATED_STANDALONE=true` (local dev only) |

Do not silently resolve any of the above without checking with the doc's named owner
first — that's the whole point of flagging them inline instead of guessing.

## Batching by chapter

For a single large PDF that's really N chapters bound together (the motivating case:
a ~13MB "complete series" PDF that needs to come out the other end as one
downloadable file per chapter), the Batch split screen offers a second split method
alongside the original equal-pages one:

- **equal-pages** (default) — unchanged §6.3 behavior: 2–5 roughly-equal-page-count
  children, routed to manual-fix/download-ready by whether they touch
  `pages_with_errors` from a *prior* qualification pass on the whole document.
- **by-chapter** — detects chapter-start pages using, in order:
  1. **The PDF's own outline/bookmarks** (the navigation panel most PDF viewers
     show) — filtered by title against `BATCH_SPLIT_CHAPTER_HEADING_PATTERN`, with
     each match's destination resolved to a real page number. Most reliable when
     present: verified against a real 2103-page, 5-book "complete series" PDF
     whose actual chapter-opener titles (`"I Jason"`, `"Ii Piper"`, etc. — not
     literal "Chapter N") are rendered as a **graphic**, not text, on the
     chapter's own page — so no text-based approach could ever find them there —
     but the outline carries the same titles as real, resolvable text.
  2. **Page-text scan** (the original approach) — if a PDF has no outline at
     all, falls back to testing each page's first non-blank line against the
     same pattern. Only catches headings that are themselves extractable text on
     the page, which excludes any book using styled/graphical chapter openers.
  3. **Equal-pages** — if neither finds anything, falls back silently (surfaced
     as `usedFallback`/`detectionMethod` in the response) rather than erroring
     out on a pattern or outline mismatch.

  Produces one child file per detected chapter, named from the heading text.

The two methods also differ in *routing*, not just page math: by-chapter has no
`pages_with_errors` to route by (qualification hasn't run on these chapters yet —
that's the point), so every by-chapter child routes to
`BATCH_SPLIT_TRANSFORM_TASK_CODE` instead (default `TRANSFORMATION` — **changed
2026-08-15**, previously routed straight to `BATCH_SPLIT_QUALIFICATION_TASK_CODE`;
see "Transformation" below for why a task got inserted here). This makes the actual
pipeline order for this use case **register → batch (by-chapter) → transform each
chapter → qualify each chapter (now reviewing XML/JSON) → download each chapter**,
rather than §6.3's original **register → qualify whole doc → batch → download**.
Qualification's own screen logic is unchanged either way — it just qualifies
whatever file/task it's given, rendering a PDF preview or a structured-content
viewer depending on `meta_data.content_format` (see "Transformation" below).

Outline reading (`pdf/split.ts`'s `detectChapterBoundariesFromOutline`) doesn't use
pdf-lib (its outline support is low-level/undocumented) or a fresh `pdfjs-dist`
dependency (pdf-parse v2's pdfjs-dist v5 crashes in this Node environment — see
below) — it reaches into `pdf-parse`'s own vendored pdf.js build
(`pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js`) directly via `createRequire`, since
that specific build is already proven not to hit that crash. This is an internal,
undocumented path that could break on a `pdf-parse` version bump; wrapped in
try/catch so outline detection just becomes unavailable (falls back to text-scan)
rather than crashing if it ever does. Expect to still need per-book
`BATCH_SPLIT_CHAPTER_HEADING_PATTERN` tuning either way — there's no cross-book-format
detection, just "match this regex against outline titles, or page text if there's no
outline."

Every child (either method) is registered onto its target task **unclaimed**,
not pre-owned by whoever ran the split — `register-file`'s `start_task: true`
is only used to get a presigned upload URL back in the same call, then
released (`update-file-status` `I -> O -> Y`, two hops since uw-be's own state
machine has no direct `InProgress -> YetToStart`) right after the bytes are
uploaded. The team working qualification/download is usually not the same
team that ran batching, so each child needs to surface through that task's own
normal unclaimed-files queue / "Start next file" — same as any other file —
rather than silently belonging to the splitting operator.

## Transformation (PDF text → XML/JSON)

New task, added 2026-08-15, sitting between by-chapter batch-split and
qualification. **Deliberately reverses FLUID_APP_DEV_CONTEXT.md §1/§6.4/§9.2/§13#5**,
which all state RAG transformation is owned by a separate app entirely — brought
in-house per direct user decision, not a silent override of the doc's stated scope.
Target use case: an author's book gets ingested into a tenant/client's RAG so fans
can ask an AI questions about it. This task's only job is producing a well-structured
export of one already-split chapter's text — embeddings, chunking-for-retrieval, and
vector loading remain the RAG app's concern, same "don't reach past your own scope"
posture the rest of this app already takes toward things like archiving (§13 #2).

- **Where it sits**: by-chapter batch-split now routes every chapter to this task
  (`BATCH_SPLIT_TRANSFORM_TASK_CODE`, default `TRANSFORMATION`) instead of straight to
  qualification. Transformation's own completion routes its output onward to
  qualification (`BATCH_SPLIT_QUALIFICATION_TASK_CODE`, reused — same config key
  equal-pages/by-chapter already used). Actual order:
  **register → batch (by-chapter) → transform each chapter → qualify each chapter
  (now reviewing XML/JSON) → download each chapter.**
- **Format**: the operator picks XML or JSON at runtime on the Transformation screen
  (not a fixed per-project config) — see `frontend/src/modes/transformation/TransformationScreen.tsx`.
- **Schema** (`backend/src/pdf/transform.ts`): a document envelope
  (`source_file_id`, `parent_file_id`, `split_index`, `chapter_title`, `page_count`)
  plus an ordered `chunks` array, one chunk per **page** of the already-split chapter
  file (`order`, `page`, `heading`, `text`) — `heading` is set only on `chunks[0]`
  (= `chapter_title` if known). **Not paragraph-level**: `extractPerPageText` (reused
  from `pdf/split.ts`) only captures line-level text via pdf-parse's `pagerender`
  hook with no blank-line/paragraph signal — every line gets exactly one `\n`
  whether it's a paragraph break or a mid-paragraph wrap — so paragraph detection
  isn't reliably derivable without a new heuristic (e.g. y-gap-based). Page-level is
  the same granularity this codebase already trusts elsewhere (chapter-boundary
  detection assumes a chapter starts at the top of whichever page its heading lands
  on, for the same reason). A real fast-follow, not done here.
- **Qualification's viewer**: `meta_data.content_format` (`'xml'|'json'`, written by
  this task) switches `QualificationScreen.tsx` from its PDF `<iframe>`/page-nav to a
  `<pre className="fluid-content-viewer">` showing the raw text, fetched via a new
  `GET /api/qualification/content-proxy?url=` (server-side fetch, same
  CORS-avoidance technique `batch-split.ts` already uses for parent bytes). No page
  concept for structured content, so the per-page error-flagging UI is skipped in
  that branch and `pagesWithErrors` is always sent empty — the 3-way clean/rework/
  archive outcome buttons are unchanged.
- **Real-uw-be wiring**: a third workflow, `create_ragflow_workflow.php`, clones
  CHAPTERFLOW's four tasks and inserts a fifth (`TRANSFORMATION`, cloned from
  QUALIFICATION's fields — the closest analog — with `code`/`name` overridden and
  `upload_to_storage=1`, since both TRANSFORMATION and QUALIFICATION are now targets
  of an explicit `register-file` call rather than DAG advancement). **Does not touch
  MAINFLOW or CHAPTERFLOW** — both were already stood up in this Orion project and
  stay exactly as they are; this is a new, separate workflow (`RAGFLOW`) for testing
  the new task, same reasoning CHAPTERFLOW itself used to avoid touching MAINFLOW.
  `mock-uwbe/server.js`'s `get-all-tasks` fixture (shared across all flows in the
  mock, which doesn't model per-workflow task graphs) gained one `TRANSFORMATION`
  node the same way.

```bash
# transformation — takes an already-split chapter file, needs workflowCode +
# format (xml or json); routes its output onward to qualification
curl -X POST http://localhost:4100/api/transformation/transform -H "Content-Type: application/json" \
  -d '{"projectId":334,"projectCode":"TEST-UNIFIED-WF","workflowCode":"WF001","taskId":3762,"jobId":87789,"batchId":557886,"fileId":<chapterFileId>,"fileName":"chapter.pdf","format":"json"}'
# -> { data: { fileId, taskUid, format, pageCount } }
```

## Notable implementation choices not fully pinned by the dev-context doc

- **Backend runtime**: Node/TypeScript (Express 5), not Laravel — the doc left this open.
- **PDF text-extractability gate** (`backend/src/pdf/text-extractable.ts`): average
  chars-per-page heuristic, threshold configurable via `ACQUISITION_MIN_AVG_CHARS_PER_PAGE`.
  The doc doesn't define "text-extractable" precisely.
- **Chunk count for `/batch` split** (`backend/src/pdf/split.ts`): derived from
  `BATCH_SPLIT_TARGET_PAGES_PER_CHUNK`, clamped to `[BATCH_SPLIT_MIN_CHUNKS, BATCH_SPLIT_MAX_CHUNKS]`
  (default 2–5, matching §1/§6.3's "2–5 roughly-equal-page-count files").
- **`single-spa-react` API**: implemented against the API actually published on npm
  (`React` / `ReactDOMClient` / `rootComponent`, verified against the installed
  package's `.d.ts`), which matches the dev-context doc's own §9.1 sample. Some
  documentation sources describe a newer `createElement`/`renderReactNode` shape
  that is not yet the published `latest` version — don't "fix" this to match that
  API without re-checking what's actually on npm at the time.
- **`pdf-parse` is pinned to `^1.1.1`, not the current `^2.x`.** v2 (a pdfjs-dist v5
  rewrite) throws `DataCloneError: Cannot transfer object of unsupported type` from
  its worker-simulation layer in this Node environment. v1 has no such worker and is
  sufficient for the plain text-length check the gate needs — don't upgrade without
  re-testing the crash is actually gone.
- **`FileTaskOutput.file_status`, not `status`.** Originally renamed to avoid a
  collision with Style B's envelope discriminator, back when this endpoint was
  (incorrectly) assumed to be Style B — it's actually Style A, so that specific
  collision can't happen here. Kept the name anyway since it matches the real
  `file_status` enum (`O`/`P`/`C`/`I`/`Y`/`BQ`) used elsewhere in the API. The
  general lesson still applies to any *actual* Style B endpoint's payload
  fields, since `response-parser.ts` does strip a top-level `status` key there.
