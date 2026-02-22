import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AgentTool, AgentToolContext, AgentToolResult } from '../../types/agentProtocol';
import {
  AdbCollaborationConfig,
  AdbContext,
  detectAdbContext,
  getAdbService,
} from '../../../services/adb';

function now(): number {
  return Date.now();
}

function resolveAdbConfig(params: Record<string, any>, context: AgentToolContext): AdbCollaborationConfig | undefined {
  const fromContext = (context.additionalContext as any)?.adb;
  const fromParams: AdbCollaborationConfig = {};

  if (typeof params.serial === 'string') fromParams.serial = params.serial;
  if (typeof params.requireTraceMatch === 'boolean') fromParams.requireTraceMatch = params.requireTraceMatch;

  const merged = {
    ...(fromContext && typeof fromContext === 'object' ? fromContext : {}),
    ...fromParams,
  } as AdbCollaborationConfig;

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function isSafeReadOnlyShellCommand(command: string): { ok: boolean; reason?: string } {
  const cmd = (command || '').trim();
  if (!cmd) return { ok: false, reason: 'command 为空' };

  // Disallow common shell chaining / redirection to reduce risk.
  if (/[;&|><`$\\\n]/.test(cmd)) {
    return { ok: false, reason: 'command 包含潜在危险的 shell 字符（如 ; & | > < 等）' };
  }

  const parts = cmd.split(/\s+/);
  const head = parts[0]?.toLowerCase();
  if (!head) return { ok: false, reason: 'command 无法解析' };

  if (head === 'su' || head === 'sh' || head === 'bash') {
    return { ok: false, reason: '只读模式禁止使用 su/sh' };
  }

  const allowed = new Set(['getprop', 'dumpsys', 'pm', 'ps', 'top', 'logcat', 'cat', 'ls']);
  if (!allowed.has(head)) {
    return { ok: false, reason: `只读模式仅允许: ${Array.from(allowed).join(', ')}` };
  }

  if (head === 'cat') {
    const target = parts[1] || '';
    if (!target.startsWith('/proc/') && !target.startsWith('/sys/')) {
      return { ok: false, reason: 'cat 仅允许读取 /proc 或 /sys 下的路径' };
    }
  }

  if (head === 'ls') {
    const target = parts[1] || '/';
    const ok =
      target === '/' ||
      target.startsWith('/proc') ||
      target.startsWith('/sys') ||
      target.startsWith('/data/local/tmp') ||
      target.startsWith('/sdcard');
    if (!ok) {
      return { ok: false, reason: 'ls 仅允许 /, /proc, /sys, /data/local/tmp, /sdcard' };
    }
  }

  return { ok: true };
}

async function getEnabledAdbContext(
  params: Record<string, any>,
  context: AgentToolContext
): Promise<AdbContext> {
  const adbConfig = resolveAdbConfig(params, context);
  return detectAdbContext(adbConfig, context.traceProcessorService, context.traceId);
}

function redactDeviceProps(deviceInfo: any): any {
  if (!deviceInfo || typeof deviceInfo !== 'object') return deviceInfo;
  const { props, ...rest } = deviceInfo as any;
  return rest;
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + `\n…(truncated, maxChars=${maxChars})`, truncated: true };
}

function isAgentFullModeAllowed(context: AgentToolContext): boolean {
  const adbContext = (context.additionalContext as any)?.adb || {};
  const userApproved = adbContext.allowAgentFullMode === true
    || adbContext.userApprovedFullMode === true
    || adbContext.fullModeApproved === true;
  const adminFlag = String(process.env.SMARTPERFETTO_ALLOW_AGENT_ADB_FULL_MODE || '').trim().toLowerCase();
  const adminEnabled = adminFlag === '1' || adminFlag === 'true' || adminFlag === 'yes';
  return userApproved && adminEnabled;
}

export function getAdbAgentTools(options: { includeRecorder?: boolean } = {}): AgentTool[] {
  const adb = getAdbService();

  const baseTools: AgentTool[] = [
    {
      name: 'adb_status',
      description: '检测当前 ADB 是否可用、连接设备列表、选中设备、以及 trace↔device 匹配结果（如可用）',
      category: 'system',
      parameters: [
        { name: 'serial', type: 'string', required: false, description: '指定设备 serial（可选）' },
        { name: 'requireTraceMatch', type: 'boolean', required: false, description: 'auto 模式下是否要求 trace 匹配（可选）' },
      ],
      execute: async (params: Record<string, any>, context: AgentToolContext): Promise<AgentToolResult> => {
        const start = now();
        try {
          const adbContext = await getEnabledAdbContext(params, context);
          return {
            success: true,
            data: adbContext,
            executionTimeMs: now() - start,
          };
        } catch (e: any) {
          return {
            success: false,
            error: e?.message || 'adb_status failed',
            executionTimeMs: now() - start,
          };
        }
      },
    },
    {
      name: 'adb_get_device_info',
      description: '获取选中设备的基础信息（model/manufacturer/build_fingerprint/sdk 等）。需要 ADB 协同已启用。',
      category: 'system',
      parameters: [
        { name: 'serial', type: 'string', required: false, description: '指定设备 serial（可选）' },
        { name: 'includeProps', type: 'boolean', required: false, description: '是否包含完整 getprop（默认 false，避免输出过大）' },
      ],
      execute: async (params: Record<string, any>, context: AgentToolContext): Promise<AgentToolResult> => {
        const start = now();
        try {
          const adbContext = await getEnabledAdbContext(params, context);
          const selected = adbContext.availability.selectedSerial;
          if (!adbContext.enabled || !selected) {
            return {
              success: false,
              error: `ADB 协同未启用（mode=${adbContext.mode}, selected=${selected || 'none'}）`,
              data: adbContext,
              executionTimeMs: now() - start,
            };
          }

          const info = await adb.getDeviceInfo(selected);
          const includeProps = params.includeProps === true;
          return {
            success: true,
            data: includeProps ? info : redactDeviceProps(info),
            executionTimeMs: now() - start,
          };
        } catch (e: any) {
          return {
            success: false,
            error: e?.message || 'adb_get_device_info failed',
            executionTimeMs: now() - start,
          };
        }
      },
    },
    {
      name: 'adb_shell',
      description:
        '通过 ADB 执行设备 shell 命令。read_only/auto 模式下仅允许安全只读命令（getprop/dumpsys/pm/ps/top/logcat/cat/ls），且禁止管道/重定向/多命令链；full 模式需要管理员开关+用户显式批准。',
      category: 'system',
      parameters: [
        { name: 'command', type: 'string', required: true, description: '要执行的 shell 命令（单条）' },
        { name: 'serial', type: 'string', required: false, description: '指定设备 serial（可选）' },
        { name: 'timeoutMs', type: 'number', required: false, description: '超时时间（ms，默认 8000）' },
        { name: 'maxChars', type: 'number', required: false, description: '最大返回字符数（默认 20000）' },
      ],
      execute: async (params: Record<string, any>, context: AgentToolContext): Promise<AgentToolResult> => {
        const start = now();
        try {
          const command = typeof params.command === 'string' ? params.command : '';
          const adbContext = await getEnabledAdbContext(params, context);
          const selected = adbContext.availability.selectedSerial;
          if (!adbContext.enabled || !selected) {
            return {
              success: false,
              error: `ADB 协同未启用（mode=${adbContext.mode}, selected=${selected || 'none'}）`,
              data: adbContext,
              executionTimeMs: now() - start,
            };
          }

          if (adbContext.mode === 'full' && !isAgentFullModeAllowed(context)) {
            return {
              success: false,
              error: 'full 模式调用被拒绝：需要 SMARTPERFETTO_ALLOW_AGENT_ADB_FULL_MODE=true 且请求上下文显式批准 allowAgentFullMode=true',
              executionTimeMs: now() - start,
            };
          }

          if (adbContext.mode !== 'full') {
            const safety = isSafeReadOnlyShellCommand(command);
            if (!safety.ok) {
              return {
                success: false,
                error: `只读模式拒绝执行: ${safety.reason || 'unsafe command'}`,
                executionTimeMs: now() - start,
              };
            }
          } else {
            // Still disallow newlines to avoid accidental multi-command execution.
            if (/\n/.test(command)) {
              return {
                success: false,
                error: 'full 模式下仍禁止包含换行的命令',
                executionTimeMs: now() - start,
              };
            }
          }

          const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 8000;
          const raw = await adb.shell(selected, command, { timeoutMs, maxBufferBytes: 10 * 1024 * 1024 });
          const maxChars = typeof params.maxChars === 'number' ? params.maxChars : 20000;
          const truncated = truncateText(raw, maxChars);

          return {
            success: true,
            data: {
              serial: selected,
              command,
              output: truncated.text,
              truncated: truncated.truncated,
            },
            executionTimeMs: now() - start,
          };
        } catch (e: any) {
          return {
            success: false,
            error: e?.message || 'adb_shell failed',
            executionTimeMs: now() - start,
          };
        }
      },
    },
  ];

  const recorderTool: AgentTool = {
    name: 'adb_record_perfetto_trace',
    description:
      '通过 ADB 在设备上运行 perfetto 录制 trace，并拉取到后端注册为新 traceId（高权限/有副作用：需要 adb mode=full 且用户明确要求）。',
    category: 'system',
    parameters: [
      { name: 'configPbtxt', type: 'string', required: true, description: 'Perfetto pbtxt 配置内容' },
      { name: 'durationMs', type: 'number', required: false, description: '录制时长（ms，可选；会尝试传递给 perfetto --time）' },
      { name: 'remoteOut', type: 'string', required: false, description: '设备端输出路径（默认 /data/local/tmp/smartperfetto_<ts>.trace）' },
      { name: 'register', type: 'boolean', required: false, description: '是否注册到 TraceProcessorService（默认 true）' },
    ],
    execute: async (params: Record<string, any>, context: AgentToolContext): Promise<AgentToolResult> => {
      const start = now();
      try {
        const adbContext = await getEnabledAdbContext(params, context);
        const selected = adbContext.availability.selectedSerial;
        if (!adbContext.enabled || !selected) {
          return {
            success: false,
            error: `ADB 协同未启用（mode=${adbContext.mode}, selected=${selected || 'none'}）`,
            data: adbContext,
            executionTimeMs: now() - start,
          };
        }
        if (adbContext.mode !== 'full') {
          return {
            success: false,
            error: `该工具需要 adb mode=full（当前为 ${adbContext.mode}）`,
            executionTimeMs: now() - start,
          };
        }
        if (!isAgentFullModeAllowed(context)) {
          return {
            success: false,
            error: 'full 模式调用被拒绝：需要 SMARTPERFETTO_ALLOW_AGENT_ADB_FULL_MODE=true 且请求上下文显式批准 allowAgentFullMode=true',
            executionTimeMs: now() - start,
          };
        }

        const cfg = typeof params.configPbtxt === 'string' ? params.configPbtxt : '';
        if (!cfg.trim()) {
          return {
            success: false,
            error: 'configPbtxt 为空',
            executionTimeMs: now() - start,
          };
        }

        const durationMs = typeof params.durationMs === 'number' ? params.durationMs : undefined;
        const remoteOut =
          (typeof params.remoteOut === 'string' && params.remoteOut.trim()) ||
          `/data/local/tmp/smartperfetto_${now()}.trace`;

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-adb-'));
        const localCfg = path.join(tmpDir, 'config.pbtxt');
        const localTrace = path.join(tmpDir, path.basename(remoteOut));

        const remoteCfg = `/data/local/tmp/smartperfetto_cfg_${now()}.pbtxt`;
        await fs.writeFile(localCfg, cfg, 'utf8');
        await adb.push(selected, localCfg, remoteCfg, { timeoutMs: 120000 });

        const timeArg = durationMs ? ` --time ${Math.max(1, Math.ceil(durationMs / 1000))}s` : '';
        // Normal mode with pbtxt config.
        const recordCmd = `perfetto --txt -c ${remoteCfg} -o ${remoteOut}${timeArg}`;
        const recordOut = await adb.shell(selected, recordCmd, { timeoutMs: (durationMs || 10000) + 120000, maxBufferBytes: 10 * 1024 * 1024 });

        await adb.pull(selected, remoteOut, localTrace, { timeoutMs: 120000 });

        const shouldRegister = params.register !== false;
        let newTraceId: string | undefined = undefined;
        if (shouldRegister && context.traceProcessorService?.loadTraceFromFilePath) {
          newTraceId = await context.traceProcessorService.loadTraceFromFilePath(localTrace);
        }

        return {
          success: true,
          data: {
            serial: selected,
            remoteCfg,
            remoteOut,
            localTrace,
            traceId: newTraceId,
            perfettoOutput: recordOut,
          },
          executionTimeMs: now() - start,
        };
      } catch (e: any) {
        return {
          success: false,
          error: e?.message || 'adb_record_perfetto_trace failed',
          executionTimeMs: now() - start,
        };
      }
    },
  };

  // Default: do NOT include recorder tool to avoid accidental invocation.
  // Callers must explicitly opt in.
  return options.includeRecorder ? [...baseTools, recorderTool] : baseTools;
}
