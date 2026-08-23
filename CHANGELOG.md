# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Bidirectional shared state with `STATE_SNAPSHOT` and the reserved `ag_ui_update_state` Tool.
- Dojo-compatible keyless examples for chat, backend Tools, shared state, HITL, and tool-based generative UI.

### Changed

- Browser Tool names now accept standard AG-UI-compatible ASCII identifiers while reserving the internal state Tool name.

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
