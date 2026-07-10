# Warren → Kubernetes Migration: Consolidated Plan

**Status:** Plan — pre-implementation, drives the migration branch
**Date:** 2026-07-09
**Supersedes decisions #2/#3 of** [`k8s-migration.md`](./k8s-migration.md)
**Tracking seed:** warren-e176 (to be decomposed into a `sd plan` under this doc)

---

## 0. How to read this document

[`k8s-migration.md`](./k8s-migration.md) is the **design record** — it settled the
architecture questions (K8s, pod-per-run, cluster host, init-container workspace
prep, pod-log event streaming, `run_inbox` steering). That reasoning stands and is
not repeated here.

This document is the **plan**. It does three things the design doc did not:

1. **Revises the "eliminate burrow" decision** into a runtime-contract model
   (§2). Burrow is not removed — it is demoted to one provider behind a seam.
2. **Corrects the design doc against the actual codebase** (§4), from the
   orientation audits of 2026-07-09.
3. **Turns the 17-file sketch into the real ~50-file work breakdown** (§5) and
   sequences it for a single long-lived branch (§6).

When this doc and the design doc disagree, **this doc wins**.

---

## 1. Guiding principles

The plan is built to satisfy these (from the KOTA software design bible), in
priority order when they conflict:

- **A system is a contract, not a codebase.** The runtime seam (§3) is the
  contract; providers are replaceable implementations behind it.
- **No framework lock-in.** The current deep burrow coupling is the anti-pattern
  we are paying down. We do **not** replace it with an equally deep K8s coupling —
  the domain depends on the contract, never on `@kubernetes/client-node` or
  `@os-eco/burrow-cli` directly.
- **Build on what works; don't reimplement.** The local/burrow path works today
  (cgroup enforcement landed in burrow v0.3.15). We keep it, wrapped, not rewrite it.
- **Delete more than you write.** Multi-worker burrow routing is obsoleted by both
  target topologies — that machinery leaves the repo (§5.C). Destruction is a
  variant of done.
- **Config in the environment, not config sprawl.** Runtime selection is one clean
  switch, not forty new env vars.
- **One source of truth per capability.** Workspace materialization gets exactly
  one home in warren (`src/workspace/`), consumed by the K8s path; burrow keeps its
  own internal copy behind the LocalProvider black box.
- **Ship the contract, prove it end-to-end, then harden.** K8s parity first;
  Local held at today's feature level, not instant parity.

---

## 2. The revised decision: runtime contract, not burrow removal

The design doc's decisions #2 ("`burrow serve` is eliminated") and #3 ("burrow
repo archived") are **revised**. The others (#1 migrate to K8s, #4 pod-per-run)
stand.

**Why the revision.** The OOM incident was never "burrow is bad." It was
**co-tenancy + unenforced limits** on one constrained box under production
multi-run load. Two independent facts change the calculus:

1. Burrow v0.3.15 already fixed the enforcement half (real cgroup
   `memory.max`/`cpu.max`, `oom_killed` event). Config theater is gone.
2. Co-tenancy only bites at *scale*. For a solo self-hoster running a couple of
   runs on one machine, co-tenancy is fine.

So "single-machine burrow" is a legitimate **self-host** topology, and "pod-per-run
K8s" is the **scale/product** topology. They are orthogonal deployment shapes. A
runtime contract serves both from one domain.

**Revised decision:**

- The migration goal is **not** "remove burrow." It is: extract a
  `RuntimeProvider` contract, make `K8sProvider` first-class, and demote burrow to
  `LocalProvider` behind that contract.
- **Burrow is not archived.** It remains the LocalProvider backend (self-host,
  macOS, local dev). `@os-eco/burrow-cli` stays a dependency, used only by
  LocalProvider.
- **What actually dies** is the *topology and the hard-wiring*, not the tool:
  the supervisor sibling-process model on the K8s path, co-tenancy, the domain's
  direct dependence on the socket API, and the multi-worker routing layer.

This is also exactly the decoupling/modularization goal stated for this migration:
the seam is what makes the ~50-file coupling tractable and the codebase scalable.

---

## 3. Target architecture

```
        warren domain
        (dispatch · watchdog · steer · reap · event bridge · admission)
                          │  depends ONLY on ▼
                 ┌────────────────────────────┐
                 │      RuntimeProvider         │   ← the contract (the seam)
                 │  create(spec) → handle       │
                 │  streamEvents(handle)        │
                 │  sendMessage(handle, msg)    │
                 │  status(handle)              │
                 │  terminate(handle)           │
                 └────────────────────────────┘
                    ▲                        ▲
        LocalProvider (burrow)        K8sProvider (pod-per-run)
        wraps existing burrow-client   new build: pod-dispatcher,
        socket path; self-host,        pod-watcher, init container,
        macOS, local dev               run_inbox, pod-log bridge
```

### 3.1 The two deployment topologies

| | **Local (self-host)** | **K8s (scale/product)** |
|---|---|---|
| Entrypoint | supervisor → `burrow serve` + `warren` (as today) | warren Deployment boots directly |
| Isolation | burrow (bwrap/seatbelt) + cgroup v2 | pod boundary + kubelet cgroup v2 |
| Install | `docker compose up` | K8s manifests (GKE Autopilot) |
| Runtime provider | `LocalProvider` | `K8sProvider` |
| bwrap security flags | kept (local Docker needs them) | N/A (never applied) |
| Multi-worker routing | dropped → single local burrow | dropped → K8s scheduler |

**Consequence:** the supervisor is **not deleted** (design doc said delete it) — it
becomes the LocalProvider deployment's entrypoint. The K8s deployment simply
doesn't use it. Same for `docker-compose.yml` and its four security flags: kept for
the local path, absent from the K8s path.

### 3.2 Hosting the K8s backend — GKE Autopilot

**Decided (2026-07-09): GKE Autopilot**, revising the design doc's K3s-on-Hetzner
pick. That pick rested on (a) cost and (b) node-level custom runtime classes
(gVisor/Kata). Both rationales lapsed: gVisor/Kata are deferred (§design doc 2.2),
and `LocalProvider` now covers the cheap self-host niche — so the K8s backend
optimizes for shipping speed, operational sanity, and a credible scaling story, not
for being cheapest.

- **Why Autopilot:** managed control plane (no self-run etcd/upgrades — the least
  transferable ops burden), and per-pod billing that fits warren's bursty run
  workload (idle pods cost nothing). One cluster's management fee is waived.
- **Local dev is free and cloud-independent:** develop `K8sProvider` against `kind`
  or `k3d` (Kubernetes/K3s in Docker); no cloud bill while building.
- **Not a one-way door:** the runtime contract makes `K8sProvider` portable across
  any conformant cluster. Moving GKE → EKS/DO later (e.g. an enterprise deal) is an
  endpoint change, not a domain change. DigitalOcean/Linode managed is the
  simpler-but-less-flexible fallback if GKE's cloud-IAM surface proves heavy.

### 3.2 The contract

The exact method set is an open question (§7) but the shape is fixed: the domain
issues run lifecycle operations against a `handle`, never against a burrow id or a
pod name. `runId` remains the domain identity (generated before dispatch, unchanged
from `spawnRun`); providers map it to their native handle (`burrow_id` /
`run-<run-id>` pod name) internally.

### 3.3 Provider responsibilities

- **LocalProvider** is thin: it wraps the existing `burrow-client` single-worker
  path behind the contract. Burrow does its own workspace materialization, event
  SSE, and inbox internally — LocalProvider just adapts. Minimal new code.
- **K8sProvider** is the new build: pod-dispatcher (create pods via
  `@kubernetes/client-node`), pod-watcher (informer reconciling phase → run state),
  init-container workspace prep (uses `src/workspace/`, §5.A), pod-log → event
  bridge, `run_inbox` poll for steering. This is where the design doc's §1–§5 lives.

---

## 4. Corrections from the codebase audit (2026-07-09)

Fold these into all downstream design; the design doc has them wrong or missing.

| # | Design doc claim | Reality |
|---|---|---|
| C1 | `MaterializedWorkspaceSource` lives in `provider/types.ts` | Lives in `provider/local/workspace.ts` |
| C2 | `spawnLinux` + resource limits in `bwrap.ts` | `spawnLinux` in `sandbox.ts`; cgroup enforcement in `cgroup.ts` (v0.3.15). `bwrap.ts` is a pure argv builder. **We extract neither** — LocalProvider keeps using burrow as a black box. |
| C3 | `BurrowClientPool` "becomes vestigial" | It is the **central routing layer today**, imported by ~30 modules. High blast radius; it is *retired*, not passively vestigial. |
| C4 | Add `memoryLimitMi`/`cpuLimitMillicores` to config | `DefaultsConfigSchema` is `.strict()` and has **no** resource fields — a real schema change, not additive-compatible. |
| C5 | Doc lists 17 coupled files | `@os-eco/burrow-cli` is imported by **~35** source files; `burrow-client/` by **~50+**. See §5. |
| C6 | Extraction may need a Node port (`Bun.spawn`) | Both repos are **Bun**. `exec.ts` transplants as-is. No port. |
| C7 | cgroup default cap unspecified | Burrow v0.3.15 ships `BURROW_SANDBOX_MEMORY_LIMIT_MB` override + **4096 MB** default. Relevant to LocalProvider defaults. |
| C8 | — | `src/runs/burrow-config.ts` parses `[sandbox].network` (NetworkPolicy). Needs a pod-era home (NetworkPolicy → K8s `NetworkPolicy` or pod egress config). |

**Action items #1/#2 are DONE** (cgroup enforcement shipped, all three warren pins
at 0.3.15). Items #3/#4 (warren-b01e, warren-ea4f) are folded into §5.D as
K8s-native, not built for the Fly/burrow era.

---

## 5. Coupling surface & work breakdown

The real surface, grouped by **disposition**: `[CONTRACT]` moves behind the seam,
`[DELETE]` leaves the repo, `[KEEP-LOCAL]` stays as LocalProvider deployment code,
`[NEW]` is net-new K8s work.

### A. Workspace extraction `[NEW / shared]`

Extract the self-contained 6-file git/workspace cluster from burrow into
`warren/src/workspace/` — the single source of truth for the **K8s init
container's** materialization. Bun-native, no DB, no logger, no network layer.

| Burrow source | Warren destination |
|---|---|
| `git/exec.ts` (`runGit`, `runGitOrThrow`) | `src/workspace/git/exec.ts` |
| `git/worktree.ts` (`discoverHostClone`, `addWorktree`, `removeWorktree`, `cloneRepo`) | `src/workspace/git/worktree.ts` |
| `git/identity.ts` (`resolveBurrowIdentity`, `writeBurrowGitconfig`) | `src/workspace/git/identity.ts` |
| `provider/local/workspace.ts` (`materialize*`, `MaterializedWorkspaceSource`) | `src/workspace/materialize.ts` |
| `secrets/env.ts` (`resolveEnv`) | `src/workspace/env.ts` |
| `core/errors.ts` (`WorkspaceMaterializationError`) | fold into warren's error convention |

**Drop `extractWorkspaceSource`** — the one function pulling burrow's Drizzle
schema in. Without it the cluster has zero DB coupling. (LocalProvider does *not*
use `src/workspace/`; burrow does its own materialization internally.)

### B. The runtime seam `[CONTRACT]`

Define `RuntimeProvider`; refactor the domain hot path to depend on it. The design
doc's 17 files are mostly here:

- `src/runs/spawn/dispatch.ts` (`spawnRun`) — dispatch through the provider.
- `src/runs/steer.ts` — `steerRun` → `provider.sendMessage` (K8s: `run_inbox`).
- `src/runs/stream/bridge.ts` — event bridge → `provider.streamEvents` (K8s:
  pod-log source; Local: burrow SSE). NDJSON parsing is reused verbatim.
- `src/runs/watchdog.ts` — retained, timeout 45m → 5m, wired to provider status.
- `src/runs/spawn/callback-env.ts` — unchanged (injects `WARREN_API_TOKEN`).
- Plus the reap/stream/spawn subsystems the doc omitted:
  `src/runs/reap/*` (teardown → `provider.terminate`), `src/runs/stream/*`
  (`run-state-poller`, `recover`, `terminal-detect`, `conversation-turn`),
  `src/runs/cancel.ts`, `src/runs/seed.ts`, `src/runs/conversation-merge-dispatch.ts`.

### C. Retire multi-worker burrow routing `[DELETE]`

Obsoleted by **both** targets (K8s scheduler; Local = single burrow). Delete:

- `src/burrow-client/pool.ts` (`BurrowClientPool`, `LOCAL_WORKER_NAME`),
  `fanout.ts`, and the multi-worker parts of `client.ts` / `config.ts`. What
  survives folds into `LocalProvider`.
- `src/runs/placement.ts` (`placeForProject`, `placeForBurrow`, `leastLoaded`).
- `src/server/handlers/workers.ts`, `src/server/handlers/burrows.ts` — the
  `/workers` and `/burrows` HTTP surfaces.
- `src/server-config/workers.ts` — the `[workers]` config loader.
- `src/db/repos/workers.ts`, `src/db/repos/burrows.ts`; drop `workers` + `burrows`
  tables; nullify then eventually drop `runs.burrow_id/burrow_run_id/worker_id`
  (new Postgres migration).
- Supervisor token plumbing that only served multi-worker socket auth:
  `src/supervisor/tokens.ts` reconciliation, `src/server/main/redact.ts` burrow
  redaction, `BURROW_API_TOKEN`/`WARREN_BURROW_TOKEN` server-config carry.

### D. K8s provider build `[NEW]`

- `src/runs/pod-dispatcher.ts`, `src/runs/pod-watcher.ts` (informer),
  init-container image, `run_inbox` table + poll endpoint, pod-log stream bridge.
- **Admission control, K8s-native** (folds warren-b01e #3 + warren-ea4f #4):
  queue-depth limit (429), max-pending-pods, per-project concurrency cap (§3.3 of
  design doc). Fail-fast comes free from the pod-watcher (OOMKilled → `failed`
  within 1–2s), replacing the 45-min heartbeat as sole backstop.
- `@kubernetes/client-node` added as a dependency (absent today).
- RBAC: `warren-runs` namespace, ServiceAccount with `pods` + `pods/log` scoped
  Role/RoleBinding, `ResourceQuota`.
- K8s manifests: `Deployment`, `Service`, `Ingress` (GKE Ingress / GCP load
  balancer), `Secret`s, PVCs.

### E. Keep as LocalProvider deployment `[KEEP-LOCAL]`

`src/supervisor/main.ts`, `docker-compose.yml` (+ four security flags),
`git-identity.ts`, `git-credentials.ts`, socket boot. Left largely alone; they are
the working self-host path.

### F. Adjacent / lower priority

- `src/preview/*` — preview sidecars. K8s: second container in the pod (§Q2). Local:
  unchanged. Behind the contract eventually; **does not block** initial migration.
- `src/plot-client/client.ts` — only *structurally modeled* on burrow's HttpClient;
  no actual burrow dependency. No action.
- `src/cli/commands/{run,doctor,db}.ts`, `src/diagnostics/checks-sandbox.ts` — env
  var references; update alongside the seam.

---

## 6. Branch & sequencing

**One long-lived branch, big-bang merge.** Main is frozen (solo contributor, no
live users, Fly machine decommissioned). The design doc's "independently shippable
+ rollback per step" becomes **internal branch checkpoints**, not production
deploys. Rollback within the branch = revert to the prior checkpoint tag.

Ordering minimizes how long the branch is broken:

1. **Extraction (§5.A)** — dead code addition, nothing wired. Safe, first.
2. **Contract seam (§5.B)** — define `RuntimeProvider`; implement `LocalProvider`
   wrapping current burrow behavior. **Checkpoint: green with LocalProvider = today's
   behavior through the new seam.** This proves the seam before any K8s exists.
3. **K8sProvider build (§5.D)** — behind a runtime-selection switch; LocalProvider
   stays default. Unit-testable in isolation.
4. **Retire multi-worker routing (§5.C)** — now safe because the seam replaced its
   callers. Largest deletion.
5. **K8s validation** — dev on `kind`/`k3d`, then the GKE Autopilot cluster; run
   agents end-to-end; OOMKill + steer tests.
6. **Config/manifests/RBAC hardening; docs; final green** — then merge to main.

Each numbered checkpoint should leave `bun run check:all` green on the branch.

---

## 7. Open questions still to resolve

- **Q-contract:** exact `RuntimeProvider` method set + handle type. Needs a focused
  design pass before §5.B starts — it's the load-bearing decision. Draft: `create`,
  `streamEvents`, `sendMessage`, `status`, `terminate`, plus a capability probe so
  the domain can degrade features (e.g. preview) the LocalProvider lacks.
- **Q-conversation (design doc Q3):** `run.mode === 'conversation'` pods must be
  long-lived, conflicting with `restartPolicy: Never`. Needs a separate pod
  template + inbox-poll-alive design. Small fraction of runs; design separately.
- **Q-preview (design doc Q2):** sidecar container + `ClusterIP` Service vs. today's
  `inboundPortForwards`. Behind the contract; does not block initial migration.
- **Q-config-schema (C4):** how resource limits enter `.warren/config.yaml` given
  the `.strict()` schema — one nested `resources` block, not scattered fields.
- **Q-network:** `[sandbox].network` NetworkPolicy (C8) → K8s `NetworkPolicy` mapping.

---

## 8. Decomposition into a seeds plan

Next action: decompose **warren-e176** into a `sd plan` whose children mirror §5's
groups and §6's ordering. Proposed epic children:

1. `workspace-extract` — §5.A
2. `runtime-contract` — §5.B (blocks 3, 4)
3. `k8s-provider` — §5.D
4. `retire-multiworker` — §5.C (blocked by 2)
5. `k8s-cluster-validate` — §6.5
6. `manifests-rbac-docs` — §6.6

Q-contract (§7) is a design spike that must land before child 2 starts.
warren-b01e and warren-ea4f are absorbed into child 3 (mark them superseded, not
duplicated).
