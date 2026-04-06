# ART Garbage Collection Dynamics

## Mechanism

Android Runtime (ART) uses a generational, mostly-concurrent garbage collector. Objects are allocated in managed heap regions and automatically reclaimed when no longer reachable.

### GC Types

| GC Type | Trigger | Typical Duration | Impact |
|---------|---------|-----------------|--------|
| **Young (minor)** | Young generation full | 1-5ms | Low -- only scans young objects |
| **Full (major)** | Old generation pressure | 50-200ms | High -- scans entire heap |
| **Explicit** | `System.gc()` call | 50-200ms | Avoidable -- developer triggered |
| **Alloc** | Allocation failure (no free space) | Variable | Critical -- allocation blocked until GC completes |

### Concurrent vs Stop-the-World

Most of the GC work runs concurrently on a background thread. However, the **final marking phase** requires a brief stop-the-world pause where ALL application threads are suspended. During this pause:
- No UI thread work proceeds
- No RenderThread drawing
- All threads frozen until marking completes

## Impact on Frame Rendering

When the main thread encounters `GC: Wait For Completion`, it is blocked waiting for a GC cycle to finish. This directly steals time from the frame budget. High heap pressure creates a vicious cycle: more allocations trigger more GCs, each stealing CPU time and causing thread pauses.

**Allocation rate** is the key metric. A high allocation rate (e.g., during RecyclerView scrolling) triggers frequent young GCs, increasing cumulative CPU overhead and pause frequency.

## Trace Signatures

| What to Look For | Meaning |
|-----------------|---------|
| `android_garbage_collection_events` table | GC events with gc_type, duration, reclaimed_mb |
| `GC: Wait For Completion` slice on main thread | Main thread blocked by GC |
| `gc_running_dur` vs `gc_wall_dur` | Concurrent time vs total wall time |
| gc_type = `young` with high frequency | Allocation pressure |
| gc_type = `full` or `explicit` | Major collection -- significant pause risk |
| Large `reclaimed_mb` | High allocation rate (allocating and discarding rapidly) |

## Typical Solutions

- **Reduce allocations in hot loops**: RecyclerView.onBindViewHolder, animation ticks, onDraw -- avoid creating objects per frame
- **Use object pools**: Reuse Message, Rect, Paint objects instead of allocating new ones
- **Avoid autoboxing**: Use SparseIntArray instead of HashMap<Integer, Integer>
- **Remove explicit GC calls**: `System.gc()` forces a full collection -- almost never appropriate
- **Avoid finalizers and weak references in hot paths**: They add GC pressure
- **Increase heap if justified**: `android:largeHeap="true"` raises ceiling but does not fix the root cause
- **Profile with allocation tracking**: Identify top allocating call sites and eliminate unnecessary allocations

### Android 10+ CC GC (Concurrent Copying)

Android 10+ 默认使用 CC GC，而非传统 CMS。

**Trace 中的名称映射**：
- `young concurrent copying GC` → Young (minor) GC 的 CC 实现
- `concurrent copying GC` → Full GC 的 CC 实现
- `GC: Wait For Completion` → CC GC 中等待并发标记/复制完成后的最终同步

**CC GC 暂停模型**：
- `FlipThreadRoots` 暂停：~1-3ms，所有线程短暂停顿完成根集翻转
- 并发标记/复制阶段：不暂停应用线程，但消耗 CPU 和内存带宽
- 频繁的 young CC GC（>5 次/秒）说明分配率过高
