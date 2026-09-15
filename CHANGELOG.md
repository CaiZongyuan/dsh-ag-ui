# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Bidirectional shared state with `STATE_SNAPSHOT` and the reserved `ag_ui_update_state` Tool.
- Dojo-compatible keyless examples for chat, backend Tools, shared state, HITL, and tool-based generative UI.

### Fixed

- `MESSAGES_SNAPSHOT` now reconstructs assistant Tool calls from durable DSH messages, so Tool-only assistant messages and their results remain correlated after replay.
- `MESSAGES_SNAPSHOT` now includes the user messages the run just admitted and is emitted only after admission, so a client keeps the message it sent and a rejected run leaves its history untouched.

### Changed

- A run admits every new user message it carries into one DSH turn, in arrival order, and a run without new messages only synchronizes history; `INVALID_MESSAGE_BATCH` remains for batches mixing user messages with frontend Tool results.
- Runs of one thread now queue in arrival order behind the active run instead of failing with `RUN_IN_PROGRESS`; a waiting client that disconnects is never admitted.
- Updated Gateway and adapter peers to DeepSeek Harness `0.1.5-alpha.1`; live text now consumes `agent/assistant-stream`, history uses session snapshots, and Agent setup uses the explicit callback argument.
- Resume now creates a session only for `SessionPersistenceNotFoundError`, preserving corruption and format-refusal errors.
- Verified v3 session persistence and migration from the recorded `0.1.1-rc.2` log; file Tool results project as `[file result]`.

- Browser Tool names now accept standard AG-UI-compatible ASCII identifiers while reserving the internal state Tool name.
- Consolidated internal Tool-call and Run-event bookkeeping and removed redundant source fixtures without changing protocol behavior.
- Upgraded the exact DeepSeek Harness compatibility target to `0.1.2-alpha.3` and replaced the removed composition package with supported explicit Agent-core rows.

## [0.1.0] - 2026-08-22

### Added

- Authenticated AG-UI `0.0.58` HTTP and SSE Gateway for DSH Agents.
- Process-local authenticated thread bindings and run idempotency.
- Browser-owned Tool registration and Promise Park/Resume continuation.
- Backend Tool result projection and frontend result echo suppression.
- Bounded inputs, event buffers, run ledgers, threads, and Tool waits.
- Installable DSH Profile Bundle with dormant environment configuration.
- English and Simplified Chinese documentation.
- Strict TypeScript, per-file coverage, publint, and GitHub Actions checks.

[Unreleased]: https://github.com/CaiZongyuan/dsh-ag-ui/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/CaiZongyuan/dsh-ag-ui/releases/tag/v0.1.0
