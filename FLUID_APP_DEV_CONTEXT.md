# Fluid App — Development Context

**Status:** Design handoff for implementation. Give this document to Claude Code as the authoritative starting context — it is self-contained and does not assume access to any prior conversation.

---

## 1. What this app is

The **Fluid App** is a standalone, mode-driven web application that acts as the browser-based "screen" for individual tasks inside Orion (formerly WPD / Unified Workflow Platform), Innodata's document-workflow orchestration platform. It replaces the legacy pattern of launching a desktop executable per task with a single web app that Orion's workflow engine opens in a browser tab, passing task/file context via URL parameters.

One Fluid App instance handles **multiple task types** ("modes"), selected by the `task_code` the platform already provides on launch — not a custom parameter invented by this app. Modes are added by registering new screen components; no core routing changes.

**Frontend architecture: single-spa micro-frontend, mounted as a Parcel.** This app builds as a **single-spa Parcel** (not a standalone SPA in an iframe) — a bundle exporting `bootstrap`/`mount`/`unmount` that Orion's shell dynamically imports and mounts directly into its own DOM, in the same JS realm. There is no cross-origin boundary between Orion and this app when launched this way — no iframe, no CSP `frame-ancestors`, no `postMessage` handshake, no cross-origin cookie problem. Orion's shell passes task context as plain JS `customProps` at mount time.

**Dual entry-point requirement:** this app must also support being opened standalone in a browser tab (matching the legacy desktop-app-replacement pattern, and useful for any integration outside Orion's own shell). Support both:
- **Parcel mode** — mounted by a host via `customProps` (primary path when embedded in Orion)
- **Standalone mode** — loaded directly, reads task context from URL query params (§3)

Same screen components, two ways of receiving task context. Detect which mode is active by whether `customProps` were supplied by a mounting host vs. the app bootstrapping itself as the top-level document.

**This build's target pipeline** (one workflow, four sequential screens):

```
/acquisition → /qualification → /batch → /download
```

A text-only PDF is registered, reviewed page-by-page with error flagging, split into 2–5 roughly-equal-page-count files, and made available as a download link. **RAG transformation is owned by a separate app, not this one.** Orion's workflow ends at handoff — the split files are the final artifact this pipeline produces. For the current demo scope, handoff is just a download link the RAG app's owner/operator clicks manually; there is no transmission/webhook push and no round-trip of RAG output back into Orion. (A transmission-based push was considered but is explicitly deferred as unnecessary complexity for this scope — see §13.)

---

## 2. Relationship to the backend (`uw-be`)

The Fluid App **never talks to Orion's core API from the browser.** It has its own thin backend that:

- Holds the Orion service credentials (a Sanctum-style personal access token)
- Proxies/orchestrates calls to `uw-be`'s service-to-service API (`routes/api.php`)
- Owns anything that shouldn't run in a browser tab (validation gates, multi-call orchestration, async job triggering)

```
Browser (Fluid App SPA)
   |  session/JWT issued by Fluid App Backend
   v
Fluid App Backend  (thin — orchestration only, no business rules re-implemented)
   |  api-token: <id>|<token>  +  project_code on every call
   v
uw-be  (Orion core API — routes/api.php)
```

**Why a separate backend, not direct browser→Orion calls:**
- The Orion service token must never reach the browser
- Multi-step orchestration (e.g. split → register N files) needs a server
- Response-envelope quirks (see §5) need centralized, consistent handling
- Keeps this app portable — embeddable from Orion's shell, a legacy desktop launcher, or any future caller, without coupling to Orion's own frontend release cycle

---

## 3. Launch contract

Two entry paths. Both resolve to the same internal `TaskContext` shape before any screen component renders.

### 3.1 Parcel mode (primary — mounted inside Orion)

Orion's shell dynamically imports this app's bundle and mounts it directly:

```ts
mountRootParcel(fluidAppParcel, {
  domElement: containerRef.current,
  taskCode: 'ACQUISITION',   // mode registry key
  taskId: 3758,
  fileId: 555359,
  projectId: 334,
  jobId: 87789,
  batchId: 557886,
  projectCode: 'TEST-UNIFIED-WF',
  userId: 503,
  userLoginId: 'PV4',
  apiToken: scopedShortLivedToken,   // see §10 — never Orion's raw session/service token
});
```

The Fluid App exports `bootstrap`/`mount`/`unmount` (via `single-spa-react`'s helper or equivalent) so any single-spa host can mount it. `unmount` must fully tear down — no dangling listeners/timers — since Orion's shell may mount/unmount this app repeatedly as the operator moves between tasks without a full page reload.

### 3.2 Standalone mode (fallback — direct browser tab)

Same context, supplied as URL query params, matching the legacy launch pattern:

```
https://<fluid-app-host>/<screen>?
  project_id=334
  &job_id=87789
  &batch_id=557886
  &file_id=555359
  &task_id=3758
  &user_id=503
  &project_code=TEST-UNIFIED-WF
  &job_name=UF0001
  &batch_name=UF0001013
  &file_name=Get_Started_With_Smallpdf.pdf
  &task_code=ACQUISITION        <!-- this selects the mode -->
  &user_login_id=PV4
```

### 3.3 Rules (both modes)

- `taskCode`/`task_code` is the mode registry key in both paths. Map it → screen component; don't invent a separate `mode=` value.
- None of these values (from either path) are trusted for authorization. On load, the Fluid App Backend re-fetches and re-validates context server-side via `get-task-ongoing-file` using the IDs supplied. Both the URL and `customProps` are *pointers*, not credentials.
- No long-lived auth token is ever placed in the standalone-mode URL. See §10 for what each mode uses instead.

---

## 4. Auth model

| Item | Value |
|---|---|
| Header | `api-token: <id>\|<plaintext-token>` (NOT `Authorization: Bearer`) |
| Token type | Laravel Sanctum-style personal access token, validated against `IAPersonalAccessToken` |
| Who holds it | Fluid App Backend only — provisioned once as a service-account credential, stored server-side (secrets manager / env var), never sent to the browser |
| Expiry | No expiry check on this code path currently — do not rely on token rotation for security; rely on scope/permissions of the service account instead |
| Tenancy | Every call to a tenancy-gated endpoint must include `project_code` (preferred over `project_id`) as a top-level param. **A missing/wrong `project_code` fails silently** — no clean 400 — and surfaces later as a confusing not-found error. Validate `project_code` is present client-side (in the Fluid App Backend) before firing any request. |

---

## 5. Response envelope handling — critical, non-obvious

`uw-be`'s `routes/api.php` has **three different response conventions** depending on controller. A single generic "check HTTP status" handler will silently treat failures as successes for most of the endpoints this app uses. Build a **per-endpoint or per-controller response parser**, not one generic one.

| Style | Used by (relevant to this app) | Success | Error | HTTP status |
|---|---|---|---|---|
| **A** | `register-file`, `register-job-batch-file` (TaskProcessController) | `{success:true, code:200, data:{...}}` | `{success:false, code:<n>, message, error}` | Real status codes |
| **B** | `update-file-status`, `update-file-meta-data`, `get-task-ongoing-file`, `get-file-task-output`, `flow-back-file-task` (FileController) | `{status:true, ...}` | `{status:false, error:"..."}` | **Almost always HTTP 200 even on failure** — must branch on `status`, not HTTP code |

Build the response parser as a lookup table keyed by endpoint name, returning a normalized `{ok: boolean, data, error}` shape to the rest of the app. Do this once, early — every screen depends on it.

---

## 6. Endpoints this app uses

All params below are sent as query (GET) or body (POST) fields unless noted. All require `project_code` (tenancy). Auth header on every call: `api-token: <id>|<token>`.

### 6.1 `/acquisition`

| Step | Endpoint | Key params | Style |
|---|---|---|---|
| 1. Register | `POST register-job-batch-file` | `project_code`, `workflow_code`, `first_task_uid`, `file_name`, `file_path`, `file_unique_identifier`, `meta_data` | A |
| 2. Upload | `PUT <file_output_upload_url>` (from step 1 response) | raw file bytes | — (S3 direct) |
| 3. Complete | `POST update-file-status` | `project_code`, `task_uid`, `file_id`, `previous_file_status:"I"`, `file_status:"C"` | B |

**Gate before step 3:** validate the uploaded PDF is text-extractable (not scanned/image-only). If it fails, do **not** call `update-file-status` with `"C"`. Instead, set `file_status:"O"` (on-hold) with `onhold_reason` (required for `"O"`), or write a `meta_data` flag (`{"acquisition_check":"fail"}`) via the `meta_data` param on the same call, and route accordingly. **Confirm with Bhanu which behavior is wanted** (reject vs. flag-and-continue) — not yet decided.

### 6.2 `/qualification`

| Step | Endpoint | Key params | Style |
|---|---|---|---|
| 1. Fetch context | `GET get-task-ongoing-file` | `project_id`, `task_id`, `file_id`, `job_id` | B |
| 2. Track viewed pages (non-audited) | `POST update-file-meta-data` | `project_code`, file-resolver params, `meta_data:{"pages_viewed":[...]}` | B |
| 3. Complete + flag errors (audited) | `POST update-file-status` | `previous_file_status`, `file_status`, `meta_data:{"pages_with_errors":[12,20,50,100]}`, `next_task` (if branching) | B |

**Use step 2 (`update-file-meta-data`, no audit trail) for page-view tracking** — it's incidental telemetry, doesn't need compliance audit.
**Use step 3's `meta_data` param (merges *with* audit, if `projects.track_metadata_change=true`) for `pages_with_errors`** — this is a QA-relevant flag and should be auditable. **Confirm `track_metadata_change` is enabled on the target project.**

**3-way routing outcome** (decided by presence/content of `pages_with_errors`):

| Outcome | Mechanism |
|---|---|
| Clean | `update-file-status` → `"C"`, normal DAG forward routing |
| Rework | `POST flow-back-file-task` → `flowback_reason` (required), optional `is_reset`, `assigned_to` |
| Archive | **No archive endpoint found in `routes/api.php`.** Likely lives in the other route surface (`routes/api/uw.php`, browser-JWT/RBAC side) since archiving is typically an admin action. **Blocker — confirm with Rifky which endpoint/surface owns this before building the archive path.** |

### 6.3 `/batch` (split)

**No native split primitive exists.** `CompileTaskProcessController` only aggregates many→one (the opposite direction). Build as multi-call orchestration in the Fluid App Backend:

| Step | Endpoint | Notes |
|---|---|---|
| 1. Complete parent | `POST update-file-status` | Normal completion of the qualification-stage file |
| 2. Register N children (2–5, per-page-count split) | `POST register-file` **×N** | `first_task_uid` = the **target task's uid**, chosen per §6.3.1 below. `file_data` = the split PDF bytes for that chunk. `meta_data:{"parent_file_id":<id>,"split_index":n}` for traceability. `job_id`/`batch_id` = same as parent (job/batch already exist — do not use `register-job-batch-file` here). |

**6.3.1 — per-chunk target task selection.** Don't hardcode the download/final task_uid. Pull the workflow's task graph once (`GET get-all-tasks`, `project_code`+`workflow_code`) and resolve `first_task_uid` dynamically. If a chunk contains pages that were flagged in `pages_with_errors` upstream, route that specific chunk's `register-file` call to a different task (e.g. a manual-fix task) than clean chunks (→ the download-ready task). This is an **intentional exception** to "routing lives in the DAG" — the app is making a per-chunk routing decision that duplicates what `task_next_tasks`/`meta_data_expression` would otherwise do. Flag this to Vibhor as a known, deliberate deviation, not an oversight.

**Blocker/decision needed:** whether this split-fan-out pattern should stay app-side or become a first-class engine feature (a native "split" task type mirroring compile-task's fan-in). Confirmed acceptable for now since CA-style tasks already fan out to multiple next tasks in some workflows — but worth a ticket either way.

### 6.4 `/download` — terminal screen, no compute happens in this app

RAG transformation happens in a separate app that this pipeline never calls. `/batch`'s split output **is** the final artifact. This screen just surfaces download links for each split file.

| Step | Endpoint | Notes |
|---|---|---|
| Resolve outputs | `GET get-file-task-output` **×N** (one per split child registered in §6.3) | For each `Completed` split file — resolves S3 path + short-lived download URL |

No async worker, no status polling, no "ranked"/format spec to satisfy — that's entirely the RAG app's concern once it has the file in hand. The demo scope is: operator (or whoever owns the RAG app) opens `/download`, sees N links, clicks them.

**Deferred, not in scope:** pushing files to the RAG app automatically via Orion's existing Transmission subsystem (`enable_transmission`/`tasks_for_transmission` on the workflow) instead of a manual download link. That's a real, already-built mechanism for exactly this kind of handoff — worth revisiting post-demo if manual download links prove to be a bottleneck — but adds transmission-job configuration and webhook delivery that's unnecessary complexity for this scope. See §13.

---

## 7. Known `uw-be` bugs/quirks to code defensively around

| Issue | Handling |
|---|---|
| `get-files-for-current-task` / `get-files-for-next-task` | Broken — `data.file` always null (undefined-variable bug upstream). **Do not use.** Job/batch-level siblings are fine. |
| `register-file-to-task` | Dead — always `410 Gone`. Do not use. |
| Multi-tenancy silent failure | Missing/invalid `project_code` doesn't error cleanly at the gate. Validate client-side (Fluid App Backend) before sending. |
| Plain-text (non-JSON) error bodies | Several download endpoints return plain text on not-found/not-uploaded. Attempt-JSON-then-fallback when calling any `download-*`/`get-*-download-url` endpoint. |
| Some success responses are redirects/binary, not JSON | `download-file-task-input` = 302 redirect. `source-files-bulk-download` = binary ZIP on success, but a **plain-text HTTP 200** on certain failures — check body content, not status. Not directly used by this app's 5 screens, but relevant if download logic expands. |
| v1 vs v2 QA endpoints differ in side effects | Not used by this pipeline; noted for future modes. |

---

## 8. Data / metadata schema (this app's contribution to `file.meta_data`)

```json
{
  "pages_viewed": [1, 2, 3, "..."],
  "pages_with_errors": [12, 20, 50, 100],
  "parent_file_id": 555366,
  "split_index": 2,
  "acquisition_check": "fail"
}
```

`file.meta_data` is a JSON column merged (not replaced) by both `update-file-meta-data` and `update-file-status`'s `meta_data` param. Namespace keys defensively if other tasks in the same workflow also write to this column — no reserved-key convention exists at the platform level.

---

## 9. Architecture — Mode Registry pattern + single-spa export contract

The app has two layers of registration: the **single-spa lifecycle** (how the whole app mounts into a host) and the **Mode Registry** (how it picks a screen once mounted). Don't conflate them.

### 9.1 single-spa lifecycle (top-level export)

```ts
// single-spa-entry.ts
import { LifeCycles } from 'single-spa';
import singleSpaReact from 'single-spa-react';
import App from './App';

const lifecycles: LifeCycles = singleSpaReact({
  React,
  ReactDOMClient,
  rootComponent: App,
  errorBoundary(err, info, props) { /* render a fallback, don't crash the host */ },
});

export const { bootstrap, mount, unmount } = lifecycles;
```

`App` receives whatever `customProps` the host passed to `mountRootParcel` (§3.1), or, if there are none (top-level document — standalone mode), parses URL params instead (§3.2). Either way it resolves to one `TaskContext` object before rendering.

### 9.2 Mode Registry (screen selection, inside `App`)

```ts
// mode-registry.ts
type ModeConfig = {
  component: React.ComponentType<TaskContextProps>;
  requiredTaskType: 'A' | 'M' | 'C' | 'Q';
  endpoints: string[]; // for documentation/introspection only
};

const modeRegistry: Record<string, ModeConfig> = {
  ACQUISITION:    { component: AcquisitionScreen,    requiredTaskType: 'M', endpoints: ['register-job-batch-file','update-file-status'] },
  QUALIFICATION:  { component: QualificationScreen,  requiredTaskType: 'M', endpoints: ['get-task-ongoing-file','update-file-meta-data','update-file-status','flow-back-file-task'] },
  BATCH_SPLIT:    { component: BatchSplitScreen,     requiredTaskType: 'A', endpoints: ['update-file-status','register-file','get-all-tasks'] },
  DOWNLOAD:       { component: DownloadScreen,       requiredTaskType: 'M', endpoints: ['get-file-task-output'] },
};
```

`App` looks up `TaskContext.taskCode` in this registry and renders the matching component. Adding a new task type later — e.g. if RAG transformation ever moves back in-house, or a transmission-based handoff replaces the manual download link — is a new registry entry, not a rewrite of this file. No single-spa lifecycle changes, no routing changes elsewhere in the app.

**Do not build a mode for fully-automatic (headless) task types.** If a future task type requires zero human interaction (e.g. an automatic QA pass), it should be a backend task handler invoked via `uw-be`'s pull-based worker loop (`get-task-next-file-with-start` → process → `update-file-status`), not a browser screen. Building a UI for something that never needs a human to look at it is unnecessary complexity — don't add a mode for it just because a `task_code` exists.

---

## 10. Security requirements

| Rule | Detail |
|---|---|
| No Orion service token in the browser | Lives only in the Fluid App Backend's environment/secrets store, in both mount modes |
| No cross-origin auth problem in Parcel mode | Single-spa mounts this app into Orion's own JS realm — there is no iframe boundary, so no CSP `frame-ancestors`, no `postMessage` handshake, and no cross-origin cookie/ITP concern. Do not build any of that; it doesn't apply here. |
| Parcel mode auth | Orion's shell already knows who the user is and what they're authorized for (it triggered the mount). It passes a **short-lived, scoped token** via `customProps.apiToken` at mount time — proving "this user is authorized for this task right now" — not Orion's own raw session/service token. The Fluid App Backend exchanges/validates this token server-side before allowing any action. |
| Standalone mode auth | No host to trust context from. The Fluid App Backend must independently authenticate — either its own login, or a short-lived signed launch token issued by Orion for the specific out-of-shell integration (e.g. the legacy new-tab pattern). **Decide which before building the standalone auth path** — Parcel mode's answer above doesn't automatically apply here. |
| Input validation | Every value from either mount path (`customProps` or URL params) is untrusted input for authorization purposes — re-validate against `get-task-ongoing-file`'s response before allowing any action, even though it arrived from a "trusted" host in Parcel mode |
| Unmount hygiene | Tokens/context held in the app's in-memory state must be cleared on `unmount` — the host may mount a different task/user context into the same page shortly after |

---

## 11. Suggested repo structure

```
fluid-app/
├── frontend/                  # single-spa Parcel (also runnable standalone — §3.2)
│   ├── src/
│   │   ├── single-spa-entry.ts    # bootstrap/mount/unmount export (§9.1)
│   │   ├── App.tsx                # resolves TaskContext from customProps OR URL params, renders mode
│   │   ├── modes/
│   │   │   ├── acquisition/
│   │   │   ├── qualification/
│   │   │   ├── batch-split/
│   │   │   └── download/
│   │   ├── mode-registry.ts       # §9.2
│   │   ├── api-client.ts          # calls Fluid App Backend only, never uw-be directly
│   │   └── task-context.ts        # shared context type + fetch/re-validate logic
│   ├── webpack.config.js          # externalize react/react-dom per single-spa convention, module-federation or SystemJS build target
│   └── package.json
├── backend/                   # thin orchestration layer
│   ├── src/
│   │   ├── uwbe-client/
│   │   │   ├── response-parser.ts   # per-endpoint Style A/B normalization (§5)
│   │   │   └── endpoints.ts         # typed wrappers per §6
│   │   ├── routes/
│   │   │   ├── acquisition.ts
│   │   │   ├── qualification.ts
│   │   │   ├── batch-split.ts       # multi-call orchestration (§6.3)
│   │   │   └── download.ts          # resolves N download links (§6.4) — no compute, no worker
│   │   └── package.json (or composer.json if built in Laravel to match Orion's stack)
└── FLUID_APP_DEV_CONTEXT.md   # this file
```

---

## 12. MVP phasing

| Phase | Scope |
|---|---|
| **Phase 1 (MVP)** | `/acquisition` + `/qualification` (clean/rework paths only, archive path blocked pending §6.2 answer). Mode registry skeleton. Response-parser layer (§5) built first — everything else depends on it. |
| **Phase 2** | `/batch` split logic + dynamic next-task resolution (§6.3.1). Requires the archive-endpoint and split-as-engine-feature decisions to be at least provisionally resolved. |
| **Phase 3** | `/download` — trivial once §6.3's split files exist; just resolves and displays N download links. No async worker, no format spec — RAG transformation is out of scope entirely (owned by a separate app). |

**Explicitly out of scope for this build:** RAG transformation itself (owned by a separate app — this pipeline only produces the split files it consumes); any mode for fully-automatic/headless task types (see §9); transmission/webhook-based push handoff (manual download link is the demo scope — see §6.4); multi-tenant subdomain launch handling (assume single-project launch context for now, matching the legacy sample); any UI for archiving until the endpoint question is resolved.

---

## 13. Open questions / blockers (do not build past these silently)

| # | Question | Owner | Blocks |
|---|---|---|---|
| 1 | Reject vs. flag-and-continue for non-text PDFs at acquisition | Bhanu | `/acquisition` gate logic |
| 2 | Which endpoint/route-file owns file archiving | Rifky | `/qualification` archive path |
| 3 | Is `projects.track_metadata_change` enabled on the target project | Confirm directly | Whether `pages_with_errors` gets an audit trail |
| 4 | Split fan-out: accept as permanent app-side pattern, or file as engine feature request | Vibhor | `/batch` long-term design, not the MVP build itself |
| 5 | ~~"Ranked" definition + target chunk format for RAG output~~ — **resolved: not this app's concern.** RAG transformation is owned by a separate app; this pipeline's only obligation is producing the split files and a download link. | — | — |
| 6 | ~~Fluid App's own auth model~~ — **resolved:** Parcel mode uses a short-lived scoped token passed via `customProps` at mount (§10). Standalone mode's auth model (own login vs. Orion-issued launch token) is still open. | Vibhor / JP | Standalone-mode auth middleware only |
| 7 | Which single-spa root config / import-map mechanism does Orion's shell already use (or will use) to resolve and mount this Parcel? | Vibhor / whoever owns Orion's shell frontend | Build target config (§11 `webpack.config.js`), deploy pipeline for the bundle |
| 8 | Does Orion's shell need this app registered as a single-spa **application** (route-activated) anywhere, or is it Parcel-only (imperatively mounted, no direct route)? | Vibhor | Confirms Parcel-only assumption in §1/§9 is correct |

---

## 14. Glossary (Orion domain terms used above)

| Term | Meaning |
|---|---|
| `task_uid` | Stable UUID identifying a task, used in external integrations (vs. `task_id`, an internal DB id) |
| `job` | Top-level work container per task invocation; auto-numbered (`job_name`) |
| `batch` | Logical grouping of files within a job |
| `file_task` | The record of one file's presence at one task — created/updated as files move through the DAG |
| `task_next_tasks` / DAG routing | The graph structure determining which task a file goes to next, optionally conditional on `meta_data_expression` |
| `compile task` | A task that aggregates many files into one output (many→one) — the inverse of what `/batch` needs |
| `meta_data` | Free-form JSON column on `files`, mergeable via multiple endpoints, optionally audited |
| Style A / Style B | This document's shorthand for `uw-be`'s two response envelope conventions (§5) |
