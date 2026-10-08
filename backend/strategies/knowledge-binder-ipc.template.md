<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Android Binder IPC

## Mechanism

Binder is Android's primary inter-process communication mechanism. A synchronous binder call works as follows:

1. **Client thread** issues a `binder transaction` and **sleeps** (blocked in kernel)
2. **Kernel** transfers the call data to the target (server) process
3. **Server thread** wakes up, executes the requested method, and produces a result
4. **Kernel** copies the result back to the client
5. **Client thread** wakes up and continues execution

During the entire round-trip, the client thread cannot do anything else. When this happens on the main thread, it cannot process input events, run animations, or draw frames.

## Why It Blocks the UI

The main thread is single-threaded for UI work. A synchronous binder call on the main thread means:
- No Choreographer callbacks fire (frame deadlines missed)
- Input events queue up (touch latency increases)
- Animations freeze

The blocking duration is set by delivery and the server side -- the client has no control over how long the call takes once issued.

## Common Slow Servers

| Server Process | Service | Why It's Slow |
|---------------|---------|---------------|
| system_server | ActivityManagerService (AMS) | Lock contention, process lookup |
| system_server | PackageManagerService (PMS) | Package resolution, permission checks |
| system_server | WindowManagerService (WMS) | Window state transitions |
| surfaceflinger | SurfaceComposer | Buffer management, layer updates |
| mediaserver | MediaCodec/AudioFlinger | Codec allocation, audio routing |

## Trace Signatures

| What to Look For | Meaning |
|-----------------|---------|
| `binder transaction` slice on client thread | Client-side blocking duration |
| `binder reply` slice on server thread | Server-side execution time |
| blocked_function = `binder_wait_for_work` | Thread idle waiting for incoming binder work |
| `android_binder_client_server_breakdown` | Detailed server-side blame breakdown |

Server-side blame reasons from `android_binder_client_server_breakdown`:
- **monitor_contention** -- server thread waiting on a Java monitor lock
- **io** -- server performing disk or network I/O while handling the call
- **memory_reclaim** -- kernel reclaiming memory during the call
- **art_lock_contention** -- ART runtime internal lock contention

## Attributing a Slow Call

Split every slow synchronous call before naming a side. `android_binder_txns` records the client's blocked duration (`client_dur`), the server's reply execution (`server_dur`) and, from `server_ts - client_ts`, the dispatch delay before a server thread starts; the `binder_blocking_in_range` Skill reports client and server totals per server interface.

| Observation | Candidate | Evidence still needed |
|-------------|-----------|-----------------------|
| `client_dur` close to `server_dur` | The server's execution is the wait | Server-thread states and blame reasons during the reply; a nested binder call the server makes while replying moves the question one hop further |
| High dispatch delay (`client_dur` much longer than `server_dur`) | Delivery, server-thread wakeup/Runnable delay, or no free binder thread (pool saturation) | Server thread state before the reply starts, and whether every pool thread was busy then; pool size or utilisation alone does not prove queueing |
| Many short calls adding up | Call frequency, not a slow server | Per-call count and total inside the critical window |
| `oneway` (async) transaction | No client-side block | Only server-side queue ordering matters |

Name the server process, interface and method when available. The calling app owns the choice to make the call synchronously on a latency-critical thread; the length of the wait belongs to the delivery and server path.

For a root-cause question, investigate available server-thread and lock-owner evidence in the slow call's window before proposing that investigation as future work. In systrace, missing stdlib pairing can still permit raw slices and thread states; it does not establish a peer relationship. Keep client, server, waiter and owner identities separate: TID is not PID/UPID. A lock on another thread or an overlapping interval alone does not prove this transaction waited on it. Do not explain mismatched identities or timing as clock/collection error without evidence. If the pairing or owner remains unavailable, state that boundary.

## Typical Solutions

- Switch to async binder (`oneway`) where result is not needed immediately
- Batch multiple IPC calls into a single transaction
- Defer non-critical IPC to a background thread
- Cache results of frequent queries (e.g., PackageManager info)
- Use `ContentResolver.query()` with a projection to minimize data transfer
- Pre-fetch data during idle time rather than on-demand during frame rendering
