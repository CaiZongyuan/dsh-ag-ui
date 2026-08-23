# Contributing

Thank you for contributing to `dsh-ag-ui`.

## Development requirements

- Node.js `^22.19.0` or `>=24.0.0`
- Corepack with the pnpm version declared in `package.json`
- English commit messages, source comments, JSDoc, diagnostics, and test descriptions
- English README changes accompanied by the equivalent `README.zh.md` update

## Setup

```bash
git clone https://github.com/CaiZongyuan/dsh-ag-ui.git
cd dsh-ag-ui
corepack enable
pnpm install
pnpm check
```

## Design rules

- Keep the Gateway in the DSH Host plane. It provides a process-level service and must not be moved into an Agent Preset.
- Own every registration, timer, Agent handle, pending call, and HTTP route through a Cordis fiber or an explicit lifecycle controller.
- Treat request bodies, AG-UI messages, context, state, and client Tool schemas as untrusted wire input.
- Never use client context, model arguments, or forwarded properties to grant backend authority.
- Keep frontend Tool definitions in the exact Agent scope and reserve `ag_ui_update_state` for protocol state management.
- Record real DSH Tool results. Suppress only the duplicate AG-UI wire echo for browser-originated results.
- Commit model-driven shared-state updates only after the durable DSH `tool/result` event exists.
- Preserve one terminal event per HTTP run and one settlement owner per pending frontend call.
- Add focused tests for every new success and failure path.

## Pull requests

1. Create a focused branch.
2. Add or update tests with the implementation.
3. Update both README languages when behavior, configuration, compatibility, or limitations change.
4. Run `pnpm check`.
5. Include the commands actually run in the pull request description.
6. Use an English pull request title and description.

## Commit messages

Use concise imperative English subjects:

```text
Add durable thread binding storage
Reject incompatible frontend Tool schemas
Document BFF authentication requirements
```

## Releases

- Update `CHANGELOG.md`.
- Verify `pnpm check` and `pnpm pack --dry-run`.
- Create an annotated `vX.Y.Z` tag.
- Publish with npm provenance from a protected GitHub release workflow or trusted local environment.

Do not commit credentials, access tokens, `.env` files, or real application data.
