<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: network
investigation_contract:
  schema_version: 1
  profiles:
    - {id: system_execution, version: 1}
    - {id: causal_reasoning, version: 1}
  requirements:
    - id: network_critical_path
      domain: critical_path
      description: "Bind the request or packet and application-processing window. Investigate network/callback task scheduling when application latency is involved; packet-only questions do not require unrelated CPU tables."
    - id: network_dependencies
      domain: dependency_chain
      description: "Separate packet timing, retransmission, request queueing and app callback service. Packet-only data does not establish DNS/TLS or remote-server duration; disclose missing protocol endpoints."
classification_description: "Network traffic, packet activity, connectivity and communication performance."
priority: 6
effort: medium
required_capabilities: []
optional_capabilities:
  - network_packets
  - power_rails
  - battery_counters
keywords:
  - network
  - okhttp
  - cronet
  - dns
  - tls
  - tcp
  - 网络
  - 请求
  - 流量
  - 数据包
  - traffic
  - packet
  - wifi
  - cellular
  - 4g
  - 5g
  - udp
  - ttfb
  - httpdns
  - httpengine
  - http/3
  - quic
  - ech
  - networkcallback
  - networkcapabilities
  - local network permission

final_report_contract:
  required_sections:
    - id: request_stage_evidence_boundary
      label: 请求阶段证据边界
      description: '当问题涉及 DNS/connect/TLS/TTFB/body/decode/HTTPDNS/OkHttp/Cronet/APM/接入层日志时，区分 packet trace、request telemetry、日志/APM、时间窗/request_id 对齐和缺失证据。'
      condition:
        kind: semantic
        description: '当问题要求定位网络请求耗时、失败或具体阶段瓶颈，或把包级 trace 与请求事件、客户端或服务端日志、APM 对照时适用。'
      pattern_groups:
        - ['请求阶段证据边界', 'request[- ]stage evidence', 'DNS/TCP/TLS/TTFB', '阶段证据']
        - ['packet[- ]level', 'trace_direct:packet_activity', 'request[- ]level', 'request telemetry', 'OkHttp', 'Cronet', 'HttpEngine', 'EventListener', 'APM', '接入层', '日志']
        - ['DNS', 'connect', 'TLS', 'TTFB', 'first byte', 'request body', 'response body', 'decode', 'HTTPDNS', 'cache', 'retry', '首包', '首字节']
        - ['request_id', 'trace_id', '时间窗', 'window', 'align', '对齐', 'missing', '缺失', '置信', 'confidence', '不能', '不可', 'not prove']
    - id: network_stack_policy_boundary
      label: 网络栈/版本策略边界
      description: '当问题涉及 Cronet/HttpEngine/HTTP3/QUIC/ECH/CT/NetworkCallback/local-network permission/validated/metered/satellite/constrained network 时，区分网络栈、API/targetSdk/Extension、设备/服务端支持、配置/权限和 trace packet 证据。'
      condition:
        kind: semantic
        description: '当问题要求解释网络协议栈、连接状态、网络权限或平台策略的行为及版本差异时适用。'
      pattern_groups:
        - ['网络栈/版本策略边界', 'stack policy boundary', '版本策略', 'network stack']
        - ['Cronet', 'HttpEngine', 'HTTP/3', 'HTTP3', 'QUIC', 'NetworkCallback', 'NetworkCapabilities', 'ECH', 'Encrypted Client Hello', 'Certificate Transparency', 'local network permission', 'ACCESS_LOCAL_NETWORK']
        - ['Android\s*1[67]', 'API\s*3[4-7]', 'targetSdk', 'Extension', 'SDK', '版本', '配置', 'server support', 'permission', 'policy', '能力']
        - ['trace_direct', 'packet', 'config', 'log', 'dumpsys', 'APM', 'missing', '缺失', '置信', 'confidence', '不能', '不可']

phase_hints:
  - id: network_packets
    keywords: ['network', 'traffic', 'packet', '网络', '流量', '数据包', 'tcp', 'udp']
    constraints: '优先调用 network_analysis。若 android_network_packets 不存在或为空，必须标注 trace 未启用 network_packets，不能解释为没有网络活动。'
    critical_tools: ['network_analysis']
    critical: true
  - id: network_power
    keywords: ['battery', 'power', 'wakeup', '耗电', '唤醒', '掉电']
    constraints: '网络耗电问题需要把 network_analysis 与 battery_drain_attribution / power_consumption_overview 组合，区分网络事件链和 rail 级功耗归因。'
    critical_tools: ['network_analysis', 'battery_drain_attribution', 'power_consumption_overview']
    critical: false
  - id: request_stage_boundary
    keywords: ['DNS', 'TLS', 'TTFB', 'HTTPDNS', 'OkHttp', 'Cronet', 'HttpEngine', 'EventListener', 'APM', 'request-stage', '首包', '首字节']
    constraints: 'request-stage 归因必须先说明 packet-level trace 只能证明包/接口/协议/活跃窗口；只有存在 OkHttp/Cronet/HttpEngine 事件、request_id、app trace slice、接入层日志或 APM 且与当前时间窗对齐时，才能拆 DNS/connect/TLS/TTFB/body/decode/cache/retry。缺失时输出采集建议。'
    critical_tools: ['network_analysis', 'lookup_knowledge']
    critical: false
  - id: network_state_policy_boundary
    keywords: ['ECH', 'Encrypted Client Hello', 'Certificate Transparency', 'HTTP/3', 'QUIC', 'NetworkCallback', 'NetworkCapabilities', 'validated', 'metered', 'local network permission', 'ACCESS_LOCAL_NETWORK', 'satellite', 'constrained network']
    constraints: '网络栈/政策问题必须把当前 trace packet 证据、client stack/config、Android/API/targetSdk/Extension、NetworkCallback/NetworkCapabilities、dumpsys/connectivity、服务端支持和外部错误日志分开；版本或配置未知时不得提升为确定根因。'
    critical_tools: ['network_analysis', 'lookup_knowledge']
    critical: false

plan_template:
  mandatory_aspects:
    - id: network_data
      match_keywords: ['network_analysis', 'network', '网络', '流量', 'packet']
      suggestion: '网络场景必须先调用 network_analysis 或明确说明 network_packets 数据缺失'
      required_expected_calls:
        - tool: invoke_skill
          skill_id: network_analysis
    - id: network_power_context
      match_keywords: ['battery_drain_attribution', 'power_consumption_overview', '耗电', '唤醒', 'power']
      suggestion: '网络耗电/唤醒问题需要补充功耗或唤醒上下文'
      required_expected_call_alternatives:
        - tool: invoke_skill
          skill_id: battery_drain_attribution
        - tool: invoke_skill
          skill_id: power_consumption_overview
---

#### network Core Strategy

**Route card**: 网络 / 流量 / 数据包 / network / traffic / packet / wifi / cellular / 4g / 5g

**Capabilities**: required=[none], optional=[network_packets, power_rails, battery_counters]

**Execution contract**
- 先 submit_plan；计划必须覆盖下列 frontmatter mandatory aspects，并在 expectedCalls 中声明关键 Skill/工具。
- 条件触发项只在 plan/证据命中对应 trigger 时强制；数据缺失时用 skipped+reason 或 waiver，不把缺失证据改写成通过。
- detail 是 informational：只指导如何执行，不能替代 invoke_skill / execute_sql / fetch_artifact 的 trace 证据。

**Mandatory aspects**
- network_data: 网络场景必须先调用 network_analysis 或明确说明 network_packets 数据缺失 (required: invoke_skill(network_analysis))
- network_power_context: 网络耗电/唤醒问题需要补充功耗或唤醒上下文 (requires one of: invoke_skill(battery_drain_attribution), invoke_skill(power_consumption_overview))

**Phase reminders**
- network_packets: 优先调用 network_analysis。若 android_network_packets 不存在或为空，必须标注 trace 未启用 network_packets，不能解释为没有网络活动。 工具: network_analysis
- network_power: 网络耗电问题需要把 network_analysis 与 battery_drain_attribution / power_consumption_overview 组合，区分网络事件链和 rail 级功耗归因。 工具: network_analysis, battery_drain_attribution, power_consumption_overview
- request_stage_boundary: request-stage 归因必须先说明 packet-level trace 只能证明包/接口/协议/活跃窗口；只有存在 OkHttp/Cronet/HttpEngine 事件、request_id、app trace slice、接入层日志或 APM 且与当前时间窗对齐时，才能拆 DNS/connect/TLS/TTFB/body/decode/cache/retry。缺失时输出采集建议。 工具: network_analysis, lookup_knowledge
- network_state_policy_boundary: 网络栈/政策问题必须把当前 trace packet 证据、client stack/config、Android/API/targetSdk/Extension、NetworkCallback/NetworkCapabilities、dumpsys/connectivity、服务端支持和外部错误日志分开；版本或配置未知时不得提升为确定根因。 工具: network_analysis, lookup_knowledge

**Final report contract summary**
- 请求阶段证据边界
- 网络栈/版本策略边界


**Detail ref**
- `network:full`: 网络活动分析 的完整 phase recipe、SQL、fetch_artifact 表、决策树和边界说明。


<!-- strategy-detail id="full" title="network full strategy detail" keywords="network,网络,流量,数据包,network,traffic,packet,wifi,cellular,4g,5g,tcp,udp,网络活动分析,detail,full" default="true" -->
#### 网络活动分析

网络场景先判断 trace 是否真的采集了 `android.network_packets`。如果没有该数据源，只能给采集建议，不能把空结果解释为"没有网络问题"。

`network_analysis` 的 packet-level 证据只能说明包收发、接口、协议、socket tag、远程端口、活跃周期和流量规模。它不能直接证明 DNS/TCP/TLS/TTFB/服务端处理这些 request-stage 根因；只有同时存在 OkHttp/Cronet/自研网络库阶段埋点、业务 trace/request id、接入层日志或系统网络状态快照时，才允许按请求阶段归因。

**Phase 1 — 网络流量/协议/接口总览：**

```
invoke_skill("network_analysis", { package: "<包名>" })
```

重点看接口分布、方向、协议、socket tag、活跃周期。如果用户关心具体时间段，必须传入 `start_ts` / `end_ts`。

如果问题是"请求期间 App 在等什么"，对发起请求的线程跑一次 `analyze_wait_chain({ process_name, thread_name, start_ts, end_ts })`，
窗口取该请求区间。`wake_source_class = network_receive_candidate` 只是候选标签：它和 `timer_or_device_wake`
共享同一个 IRQ 上下文唤醒信号，只靠睡眠线程的角色区分，必须再叠加 request-level telemetry 或 rx 包时间相关
才能升级为网络结论。

输出时把证据类型写清楚：
1. `trace_direct`: packet/activity/traffic 证据，可用于流量、频繁活跃、功耗相关性。
2. `missing_evidence`: 没有 request-stage telemetry 时，DNS/连接/TLS/TTFB 只能列为待补证方向。
3. `external_context`: 若用户提供 APM/接入层指标，只能作为上下文，必须和当前 trace 窗口对齐后再提升置信度。

**Phase 1.5 — 请求阶段证据边界（按需）：**

当用户问“网络慢”“请求慢”“DNS/TLS/TTFB 慢”“HTTPDNS 缓存/TTL”“OkHttp/Cronet/HttpEngine 阶段耗时”时，先把证据分层：

1. `packet_trace`: `network_analysis` 只能证明包收发、接口、协议、远端端口、socket tag、活跃窗口和流量规模。
2. `request_telemetry`: OkHttp `EventListener`、Cronet/HttpEngine 事件、app trace slice、request_id/trace_id 才能拆 DNS/connect/TLS/request body/TTFB/response body/decode/cache/retry。
3. `log_or_snapshot`: 接入层日志、客户端错误码、`NetworkCallback` 状态、`dumpsys connectivity` 可提供语义和网络状态，但必须和当前 trace 时间窗对齐。
4. `external_aggregate`: APM、服务端指标、线上弱网统计只能作为背景，不能替代当前 trace 证据。

缺少 request-level telemetry 时，结论必须写成 `missing_evidence`：当前只能证明网络活动/流量候选，不能直接把根因定为 DNS、TLS、首包、服务端处理或解码慢。需要机制背景（含链式请求与客户端排队的判断）时调用：

```
lookup_knowledge("network-evidence")
```

**Phase 1.6 — 网络栈/版本策略边界（按需）：**

当问题涉及 ECH、Certificate Transparency、HTTP/3/QUIC、0-RTT、Cronet、HttpEngine、`NetworkCallback`、validated/metered/bandwidth、satellite/constrained network 或 local network permission 时，必须拆开：

1. `client_stack`: OkHttp、Cronet、HttpEngine、自研 socket 栈，不同栈的 DNS/TLS/QUIC/HTTP3 能力和事件命名不同。
2. `platform_policy`: Android/API/targetSdk/Extension、权限、Network Security Config、证书/CT/ECH 配置、服务端支持。
3. `network_state`: `NetworkCapabilities` 的 validated internet、metered、transport、bandwidth estimate 是网络状态，不是请求阶段耗时本身。
4. `trace_scope`: packet trace 只能看到流量和活跃窗口；没有 app/config/log 证据时，不能把 ECH、CT、local-network permission 或 HTTP3/QUIC 配置写成确定根因。

截至 2026-05-30 核对的官方边界：HttpEngine 是 Android 版本化网络 API，通常由 Cronet 提供实现；Android 16 local-network protection 是 opt-in，Android 17 targetSdk 37+ 才强制本地网络权限；Android 17 ECH 需要目标 SDK、网络库集成和服务端支持共同满足。目标设备版本、targetSdk、网络栈和服务端能力未知时，一律标为版本/配置缺失。

**Phase 2 — 网络耗电/唤醒链路：**

```
invoke_skill("battery_drain_attribution", { package: "<包名>", start_ts: "<start>", end_ts: "<end>" })
```

如果 power_rails 可用，再补：

```
invoke_skill("power_consumption_overview", { package: "<包名>", start_ts: "<start>", end_ts: "<end>" })
```

输出时明确区分：
1. 网络包/活跃周期证据
2. wakelock / suspend-wakeup / job 事件链
3. rail 级能耗归因是否可用
<!-- /strategy-detail -->
