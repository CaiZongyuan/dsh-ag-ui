# Security Policy

## Supported versions

Only the latest released version receives security fixes while this project remains in developer preview.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository, or contact the repository owner through a private channel.

Include:

- affected version or commit
- deployment topology
- reproduction steps
- expected and observed behavior
- potential impact
- any suggested mitigation

## Security model

The Gateway authenticates a trusted Backend-for-Frontend with a bearer secret and trusted identity headers. It does not implement browser login, user sessions, CSRF protection, tenant policy, application authorization, or business audit.

Deployments must:

- keep the Gateway secret out of browser code and responses
- authenticate users in the BFF
- authorize business resources before proxying a run
- derive backend Tool authority from server-owned mappings
- configure request and lifecycle limits for their environment
- prefer loopback binding between the BFF and Gateway
- protect retained DSH Session context according to application data policy

Client context, shared state, Tool arguments, `forwardedProps`, and request body identity fields are never authorization evidence. Shared state is collaboration data, not a durable business record or approval decision.
