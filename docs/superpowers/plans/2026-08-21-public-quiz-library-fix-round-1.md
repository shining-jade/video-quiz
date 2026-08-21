# Public Quiz Library FixRound1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every lifecycle/publication visibility race, safely recover abandoned builds, declare required indexes, and add an executable bounded privacy auditor.

**Architecture:** A private per-owner lifecycle lock is acquired before publication withdrawal begins and is consumed atomically with the final allowance mutation. Public reads and publication writes require an explicit active source, active matching allowance, and no lifecycle lock; legacy sources remain auditable through an exact-owner bounded query but cannot be published until migrated. Building projections become hidden `cancelled` tombstones on lifecycle withdrawal so restore can start a fresh build. A read-only CLI scans bounded public projections, children, audit records, source/allowance/lock bindings, and writes an exclusive durable report.

**Tech Stack:** Browser JavaScript, Firebase Firestore modular client SDK, Firestore Security Rules, Firebase Admin SDK, Node.js built-in test runner.

**Spec:** `docs/superpowers/specs/2026-08-21-email-auth-public-quiz-library-design.md`

## Global Constraints

- Public projections contain no owner UID, owner email, or private moderation reason.
- Every scan and lifecycle batch is bounded; no unbounded Firestore query or batch is introduced.
- Production migration, deployment, push, real accounts, and browser acceptance are outside this implementation run.
- Changes follow RED → GREEN and finish with full Node and local demo Firestore/Admin Emulator gates.

---

### Task 1: Lifecycle lock and visibility barrier

**Files:**
- Modify: `firestore-store.js`
- Modify: `firestore.rules`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Produces: private `publication_lifecycle_locks/{ownerUid}` documents bound to allowance identity/revision, reason, operation ID, and initiator.
- Produces: lock acquisition before the first publication audit and atomic lock consumption with the allowance status mutation.
- Consumes: the existing exact-owner lifecycle audit/withdrawal loop and auth-generation/route-current actor guard.

- [ ] **Step 1: Write failing tests** proving the lock exists before audit, blocks publish/list/get/copy during each deterministic interleaving phase, is consumed atomically on success, is exactly released on safe failure, and can be adopted by an exact retry if release failed.
- [ ] **Step 2: Run focused Node and Emulator tests** and verify failures are caused by missing lock protocol and missing Rules visibility checks.
- [ ] **Step 3: Implement the minimum lock protocol** with exact schema validation, active-allowance binding, stable operation identity, bounded retry adoption, and final transaction consumption.
- [ ] **Step 4: Run focused tests** and verify all lock/race cases pass.

### Task 2: Legacy audit parity and cancelled builds

**Files:**
- Modify: `public-quiz-library-core.js`
- Modify: `firestore-store.js`
- Modify: `firestore.rules`
- Modify: `tests/public-quiz-library-core.test.js`
- Modify: `tests/firestore-store.test.js`
- Modify: `tests/firestore-rules.test.js`

**Interfaces:**
- Produces: exact-owner `auditOwnedPublications(ownerUid, limit, cursor)` that includes documents missing `lifecycleState`.
- Produces: hidden building-shaped `cancelled` publication status.
- Produces: republish replacement of cancelled builds with a fresh token and current source revision.

- [ ] **Step 1: Write failing tests** for a legacy source missing lifecycle state and for building → trash/cancelled → restore → fresh republish.
- [ ] **Step 2: Run focused tests** and confirm the lifecycle filter and building wedge are the failures.
- [ ] **Step 3: Remove the lifecycle query filter**, preserve exact owner/stable bounded paging, validate legacy owner/admin audit access, and add cancelled building-shaped validation/transitions.
- [ ] **Step 4: Run focused Node and Emulator tests** and verify legacy parity and republish recovery.

### Task 3: Composite-index release contract

**Files:**
- Create: `firestore.indexes.json`
- Modify: `firebase.json`
- Create: `tests/firestore-indexes.test.js`
- Modify: `docs/PUBLIC-QUIZ-LIBRARY.md`

**Interfaces:**
- Produces: composite index `published_quiz_sets(status ASC, updatedAt DESC, __name__ DESC)`.
- Consumes: the teacher `status == published` and admin `status in [published, moderated]` ordered queries.

- [ ] **Step 1: Write a failing static contract test** that parses both Firebase files and checks the exact collection-group, scope, fields, directions, uniqueness, and wiring.
- [ ] **Step 2: Run the test** and observe missing index configuration.
- [ ] **Step 3: Add the exact Firebase index JSON and deployment documentation**.
- [ ] **Step 4: Run the test** and verify it passes.

### Task 4: Bounded privacy/orphan auditor CLI

**Files:**
- Create: `public-library-audit.js`
- Create: `scripts/audit-public-library.js`
- Create: `tests/public-library-audit.test.js`
- Create: `tests/public-library-audit-admin-emulator.test.js`
- Modify: `package.json`
- Modify: `docs/PUBLIC-QUIZ-LIBRARY.md`
- Modify: `README.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Produces: `auditPublicLibrary({db, maxDocuments}) -> report` with bounded parent/child/audit scans and `safeToDeployPublicLibrary`.
- Produces: dry-run-only CLI requiring exact `--project`, `--target-mode`, `--max-documents`, and a non-overwriting reserved report path.
- Consumes: Firebase Admin credentials/emulator configuration and `reserveReport` durable report helper.

- [ ] **Step 1: Write failing unit/CLI/Emulator tests** for target validation, dry-run enforcement, exclusive report reservation, bounded scans, PII/allowlist/orphan/source/allowance/lock/moderation findings, and zero-finding deployment safety.
- [ ] **Step 2: Run focused tests** and observe missing module/CLI.
- [ ] **Step 3: Implement the read-only auditor and CLI**, reserving the report before Admin initialization and retaining the reservation marker if publication fails.
- [ ] **Step 4: Run focused Node and Admin Emulator tests** and verify the executable contract.

### Task 5: Release verification and report

**Files:**
- Modify: `.superpowers/sdd/2026-08-21-public-quiz-library/task-5-report.md`

**Interfaces:**
- Consumes: all prior FixRound1 outputs.
- Produces: reproducible RED/GREEN and full-gate evidence.

- [ ] **Step 1: Run `pnpm test`** and require zero failures.
- [ ] **Step 2: Run `pnpm test:rules`** and require zero Rules/Admin Emulator failures.
- [ ] **Step 3: Run syntax checks and `git diff --check`**.
- [ ] **Step 4: Self-review the five findings and deployment docs**, then record exact results in the Task 5 report.
- [ ] **Step 5: Commit the reviewed tracked changes** with the approved Korean commit message; do not deploy, migrate production, push, or use a real account.
