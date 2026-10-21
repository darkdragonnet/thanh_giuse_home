<!--
Sync Impact Report:
- Version change: 0.0.0 (Uninitialized Template) -> 1.0.0 (Ratified Baseline)
- Modified principles: Replaced all placeholder principles with 5 core project invariants.
- Added sections: Core Principles (I-V), Technology Stack & Additional Constraints, Development Workflow & Quality Gates, Governance.
- Enforcement: Explicit technical enforcement mechanisms mapped to existing test files or flagged as REQUIRED GATE.
-->

# Student Face Registration & HANET Cloud Onboarding Constitution

## Core Principles

### I. Finite Resource Invariant (VPS 3.0 GB RAM & Docker Matrix)
- **Rules**:
  - The aggregate RAM Limit across all Docker containers **MUST NOT** exceed **2,112 MB** (`app_proxy`: 128 MB, `app_postgres`: 512 MB, `app_redis`: 192 MB, `app_api`: 512 MB, `app_worker`: 768 MB). An unallocated headroom of **960 MB** (3,072 MB - 2,112 MB) **MUST** be preserved for the host OS kernel, buffers, and swap management.
  - Heavy ORMs with standalone binary query engines (e.g., Prisma) are **STRICTLY PROHIBITED**. The database access layer **MUST** use lightweight query builders (`Kysely`) or parameterized raw SQL via `pg` (per ADR-003).
  - Web API server **MUST** use `Fastify 4+` (per ADR-001).
  - Development builds, `npm install`, and manual migrations **MUST NOT** be executed directly on the production VPS during active operating hours (07:00 – 11:30 Sunday mornings during catechism sessions, and announced campaign peak windows).
- **Enforcement Mechanisms**:
  - Hard cgroup memory caps enforced at the Linux kernel level in `docker/docker-compose.yml` (lines 37-43, 72-78, 101-106, 148-154, 194-199).
  - REQUIRED GATE: CI verification script validating that no service in `docker/docker-compose.yml` exceeds its individual memory limit and the sum is ≤ 2,112 MB.
  - Package audit in `package.json` ensuring no binary ORM packages are introduced.

### II. Worker Scarcity, Heap Bounds & Sequential Processing
- **Rules**:
  - BullMQ Queue Worker concurrency **MUST** remain an immutable constant of **1** (`concurrency: 1`).
  - Worker Node.js process heap **MUST** be capped via `NODE_OPTIONS="--max-old-space-size=512"` (within its 768 MB container limit). API Node.js heap **MUST** be capped via `NODE_OPTIONS="--max-old-space-size=384"` (within its 512 MB container limit).
  - Worker image processing via Sharp **MUST** enforce sequential processing with `sharp.cache(false)` and `sharp.concurrency(1)` in `apps/worker/src/imageProcessor.ts`, normalizing photos to **1280x736** (the native frame aspect ratio required by HANET AiCam hardware, using `fit: 'cover', position: 'center'`) before releasing buffer memory.
  - Every queued job **MUST** define an execution timeout of at most **120 seconds** managed via `AbortSignal.timeout(120000)`.
  - Docker Compose for `app_worker` **MUST** declare `stop_grace_period: 150s` to allow in-flight face uploads (up to 120s) to terminate gracefully without corruption during deployment.
  - **Retry Policy**: Transient network errors use standard Exponential Backoff. **Exception**: HTTP `-503 (HANET Service Overloaded)` **MUST** use a **Fixed Backoff of 5 minutes (300,000 ms)**. Tối đa 3 attempts cho mỗi loại lỗi, theo backoff của loại lỗi đó, sau đó chuyển `manual_review`.
- **Enforcement Mechanisms**:
  - Heap caps and graceful shutdown enforced in `docker/docker-compose.yml` (lines 128, 165, 174).
  - Image dimension and memory-safe processing verified in `tests/verify-phase3-phase4-e2e.ts` (lines 55-67).
  - 3-tier error handling and -503 300s delayed retry verified in `tests/verify-3tier-error-handling.ts` (lines 55-109, 147-159).
  - REQUIRED GATE: Unit test asserting BullMQ worker initialization option `worker.opts.concurrency === 1`.

### III. Single Source of Truth & Atomic Data Integrity
- **Rules**:
  - The PostgreSQL database on the VPS is the sole **Authoritative Master (Single Source of Truth)**. Redis and local client databases are ephemeral read-through caches/replicas.
  - If a discrepancy occurs between PostgreSQL and Redis (e.g., regarding Kill Switch state), **PostgreSQL always wins**, and Redis **MUST** be resynchronized from PostgreSQL.
  - Every student identifier (`alias_id`) and backup code **MUST** adhere strictly to the fixed-width 9-character format:
    `^[A-Za-z]{2}[A-Za-z0-9]{2}_[A-Za-z0-9]{4}$` (4-character padded class prefix + underscore + 4-character unique student suffix).
  - When students change classes or departments, the 4-character student suffix **MUST** remain 100% immutable; only the 4-character class prefix is modified.
  - All status transitions **MUST** utilize **Atomic Conditional Updates** (`UPDATE students SET status = 'pending' ... WHERE id = :id AND status IN ('empty', 'error', 'manual_review') RETURNING ...`) returning HTTP 409 Conflict if no row is updated.
  - Queue job IDs **MUST** be idempotent, keyed by `student_${alias_id}`.
- **Enforcement Mechanisms**:
  - 9-character alias format and legacy 17-character isolation verified in `tests/validator.test.ts` (lines 5-27) and `tests/sync-alias-reconciliation.spec.ts` (lines 14-25).
  - Database schema constraints defined in `docker/postgres/init.sql`.
  - REQUIRED GATE: Concurrency integration test simulating simultaneous duplicate registration requests to assert HTTP 409 Conflict on the second attempt.

### IV. Safe HANET Cloud Dependency & Emergency Safeguards
- **Rules**:
  - Pre-flight validation in the Worker **MUST** reject any `aliasID` not matching the 9-character regex before dispatching API calls to HANET Cloud.
  - Legacy seed records (e.g., 17-character strings `STU_...`) **MUST** be quarantined as `LEGACY_FORMAT_QUARANTINED` and **MUST NOT** be modified manually via the Admin UI.
  - Changing an alias on HANET Cloud **MUST** execute a 2-step atomic procedure: (1) `POST /person/updateAliasID`, (2) wait **120ms** (`delay(120)`), (3) `POST /department/add-person` to re-lock `departmentID` and prevent automatic fallback to default Department 0.
  - Request frequency to HANET Cloud **MUST NOT** exceed the partner rate ceiling of **30 req/min**.
  - **No Automated Token Refresh**: Upon receiving error `-103 (ACCESS_TOKEN_EXPIRE)`, the system **MUST** treat this as a Critical Incident. The worker **MUST** immediately trigger the **Kill Switch** by setting `registration_enabled = 'false'` in PostgreSQL (and replicating to Redis `setting:kill_switch="true"`), pausing queues, and raising an admin alert. Admin manual `.env` update and container restart is required.
  - All automated regression tests **MUST** execute against `@thanh-giuse/hanet-mock` and **MUST NOT** consume live HANET Cloud API quotas.
- **Enforcement Mechanisms**:
  - 2-step department locking and alias sync verified in `tests/sync-alias-reconciliation.spec.ts` and `skills/hanet-preserve-department/SKILL.md`.
  - Regression mock server verification in `tests/verify-phase3-phase4-e2e.ts` and `apps/hanet-mock/tests/curl/verify.sh`.
  - Quota exhaustion (-9008) worker pause verified in `tests/verify-3tier-error-handling.ts` (lines 164-220) and `tests/registration.spec.ts` (lines 107-128).
  - REQUIRED GATE: Integration test simulating error `-103` to verify that `settings.registration_enabled = 'false'` is written to PostgreSQL and `worker.pause()` is executed.

### V. Mobile-First Experience & Polling Architecture
- **Rules**:
  - The student portal **MUST** be Mobile-First, client-side pre-compressing images via Canvas (max 1920px, JPEG 0.85) to reduce upload payloads from 10MB to <800KB.
  - Reverse proxy Nginx **MUST** enforce `client_max_body_size 5M;` (per ADR-002).
  - Registration status **MUST** use **HTTP Short Polling (every 3 seconds)** per ADR-004 instead of persistent WebSockets.
  - The student UI **MUST** display clear Queue Position Feedback during polling and **MUST NOT** expose raw HTTP 500 errors to end users.
- **Enforcement Mechanisms**:
  - Ephemeral file cleanup in `tmp-faces/` and proxy real IP verification tested in `tests/verify-caveats.ts` (lines 61-163).
  - Reverse proxy configuration defined in `docker/nginx/nginx.conf`.
  - REQUIRED GATE: Frontend integration test validating 3-second polling interval and human-friendly error messages upon queue rejection.

## Technology Stack & Additional Constraints

- **Reverse Proxy**: Nginx Alpine (`client_max_body_size 5M;`, serving temporary `/tmp-faces/` per ADR-002).
- **Backend API**: Node.js 20 LTS + Fastify 4+ with `NODE_OPTIONS="--max-old-space-size=384"`.
- **Worker Engine**: Node.js 20 LTS + BullMQ with `NODE_OPTIONS="--max-old-space-size=512"`.
- **Database**: PostgreSQL 16 Alpine (`max_connections=40`, `shared_buffers=128MB`).
- **Queue Engine**: Redis 7 Alpine (AOF enabled, `maxmemory 128mb`, `noeviction`) + BullMQ.
- **Image Processing**: Sharp 0.33+ (`sharp.cache(false)`, `sharp.concurrency(1)`).
- **Testing**: Vitest + Mock HANET Server (`apps/hanet-mock`).

## Development Workflow & Quality Gates

1. **Pre-Implementation Verification**: Any new feature specification generated via `/speckit-specify` or `/speckit-plan` MUST be reviewed against this Constitution.
2. **Contract Testing**: Any code touching HANET integration MUST pass test suites using `@thanh-giuse/hanet-mock`.
3. **Database Guardrails**: New migrations MUST include parameter verification and rollback definitions.
4. **Zero-Downtime Deployment Check**: Container updates on VPS MUST use `docker compose up -d --no-deps` with `stop_grace_period: 150s`.

## Governance

- **Supremacy**: This Constitution supersedes all informal documentation, temporary conventions, and ad-hoc practices.
- **Amendment Procedure**: Modifying any principle requires:
  1. An explicit Architectural Decision Record (ADR) justifying the change.
  2. Proof that RAM limits (≤ 2,112 MB) and latency constraints remain satisfied.
  3. Formal version bump and human review approval.
- **Versioning Policy**:
  - **MAJOR**: Breaking changes to core principles, database schema invariants (e.g. changing 9-char alias format), or container architecture.
  - **MINOR**: Adding new functional principles, endpoints, or infrastructure safeguards.
  - **PATCH**: Clarifications, grammatical fixes, or non-functional wording adjustments.

**Version**: 1.0.0 | **Ratified**: 2026-10-21 | **Last Amended**: 2026-10-21
