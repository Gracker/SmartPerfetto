<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Network Evidence Boundaries

Use this topic when a network report needs to explain what can and cannot be
proven from packet traces, request telemetry, network stack policy, and online
metrics.

## Evidence Ladder

- `trace_direct:packet_activity`: `android_network_packets` proves packet
  activity, interface, protocol, socket tag, remote port, active windows, and
  traffic volume. It does not prove DNS, TCP connect, TLS handshake, TTFB,
  server processing, body transfer, decode, cache, retry, or request identity.
- `request_telemetry`: OkHttp `EventListener`, Cronet/HttpEngine events, app
  trace slices, request ids, and client timing logs can split DNS/connect/TLS,
  request body, TTFB, response body, decode, cache, and retry. These must be
  aligned to the current trace window before becoming root-cause evidence.
- `log_or_snapshot`: access-layer logs, client errors, `NetworkCallback`,
  `NetworkCapabilities`, `dumpsys connectivity`, and network configuration
  explain state or policy. They are not packet timing by themselves.
- `external_aggregate`: APM, server metrics, weak-network dashboards, and
  experiment results are background unless they line up with current trace
  evidence.
- `missing_evidence`: absent request telemetry is a reportable boundary. It
  lowers confidence and drives capture recommendations; it does not rule out
  DNS, TLS, server, cache, or decode issues.

## Stack And Policy Boundaries

- OkHttp, Cronet, platform HttpEngine, WebView/Chromium networking, and custom
  socket stacks have different DNS/TLS/HTTP3/QUIC behavior and event names.
  Identify the stack before comparing request phases.
- HttpEngine is the platform API surface for modern Android network features;
  Cronet commonly provides the implementation. HTTP/3/QUIC and 0-RTT claims
  require stack support, server support, and replay/idempotency guardrails.
- `NetworkCallback` and `NetworkCapabilities` report network availability,
  validation, metered state, transports, and bandwidth estimates. They explain
  network state selection, not DNS/TLS/TTFB timing unless paired with request
  telemetry.
- ECH, Certificate Transparency, cleartext policy, local-network permission,
  and Network Security Config failures are version/config/policy evidence.
  Packet traces alone cannot prove these causes.
- Android 16 local-network protection is opt-in. Android 17 targetSdk 37+
  makes local-network permission mandatory for in-scope local network access.
  ECH on Android 17 requires target SDK, network library integration, and remote
  endpoint support.

## Chained Requests

A user-visible wait can be a chain of requests rather than one slow request:
each request starts only after the previous one completes, or several requests
queue on a client dispatcher or connection pool. Every request can look fast
while the total wait is long. Establishing this needs each request's start/end
timestamps and request identity from request telemetry; gaps between packets
prove neither dependency nor queueing. When a chain is established, attribute
the wait to client request orchestration, not to one request or the server.

## Report Pattern

1. Name the network stack and evidence class.
2. Split packet activity, request telemetry, logs/snapshots, and external
   aggregates.
3. State the concrete stage: DNS, connect, TLS, request body, TTFB, response
   body, decode, cache, retry, network state, or policy.
4. State alignment: trace window, request id, trace id, client log timestamp,
   or server/APM timestamp.
5. If any boundary is missing, mark confidence as medium/low and give a capture
   step instead of upgrading the claim.
