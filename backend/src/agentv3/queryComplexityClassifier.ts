// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Query Complexity Classifier — routes queries to quick vs full analysis pipeline.
 *
 * Two-stage classification:
 * 1. Local rules (instant, no LLM): pure confirmation keywords,
 *    then comparison → full
 * 2. AI classification (Haiku, ~1-2s): for remaining queries, determine if the question
 *    is a simple factual lookup or requires multi-step analysis, using recent turn context
 *
 * Graceful degradation: if Haiku call fails, defaults to 'full' (safe fallback).
 */

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createSdkEnv, getSdkBinaryOption, type ClaudeAgentConfig } from './claudeConfig';
import type { ProviderScope } from '../services/providerManager';
import {
  SCROLLING_TRIAGE_LOOKUP_REASON,
  shouldUseQuickScrollingTriageIntent,
} from './quickScrollingTriageIntent';
import { buildComplexityClassifierPrompt } from './queryComplexityPrompt';
import { matchesLongestProcessSlicesFactQuery } from './longestProcessSlicesIntent';
import type { ComplexityClassifierInput, QueryComplexity } from './types';

/** Confirm-like keywords force 'quick' when the query is short — covers "谢谢"/"ok" style follow-ups. */
const CONFIRM_KEYWORDS = [
  // 中文
  '谢谢', '好的', '明白', '明白了', '嗯', '收到', '知道了', '了解', '了解了',
  // 英文
  'thanks', 'thank you', 'ok', 'okay', 'got it', 'understood',
];
const NORMALIZED_CONFIRM_KEYWORDS = CONFIRM_KEYWORDS
  .map(normalizeAcknowledgement)
  .sort((a, b) => b.length - a.length);

export const TRACE_IDENTITY_FACT_LOOKUP_REASON = 'trace identity fact lookup';
export const TRACE_FACT_LOOKUP_REASON = 'trace fact lookup';
export const ACKNOWLEDGEMENT_FOLLOWUP_REASON_PREFIX = 'confirm-like follow-up:';

const IDENTITY_FACT_PATTERNS = [
  /包名|应用包|package\s*name|application\s*id|app\s*id/i,
  /^\s*(?:canonical_)?package_name\s*[?？.。!！]*\s*$/i,
  /^\s*(?:what|which)\s+(?:app(?:lication)?\s+)?package(?:\s+name)?\s*[?？.。!！]*$/i,
  /^\s*(?:what|which)\s+(?:is|was)\s+(?:the\s+)?(?:current|foreground|focused|target|trace)\s+(?:app(?:lication)?\s+)?package(?:\s+name)?\s*[?？.。!！]*$/i,
  /^\s*(?:current|foreground|focused|target|trace)\s+(?:app(?:lication)?\s+)?package(?:\s+name)?\s*[?？.。!！]*$/i,
  /(?:应用|app)(?:包名)?(?:是什么|是哪个|是哪一个|是哪款|叫什么|是谁)(?:[？?。.!\s]*)$/i,
  /(?:这个|当前|本次|该)?\s*(?:trace\s*)?(?:是|是什么|是哪一个|是哪个|哪个|哪款|什么)?\s*(?:应用|app)(?:包名)?(?:[？?。.!\s]*$|录(?:制|的)?|采集|抓取|记录)/i,
  /(?:哪个|哪一个|什么)应用/i,
  /(?:哪个|哪一个|什么)应用(?:在|处于)?(?:前台|焦点)(?:[？?。.!\s]*)$/i,
  /\b(?:what|which)\s+(?:app|application)\s+(?:is|was)\s+(?:this|this\s+trace|the\s+trace)\b/i,
  /\b(?:what|which)\s+(?:app|application)\s+(?:is|was)\s+(?:being\s+)?(?:traced|recorded|captured)\b/i,
  /\b(?:what|which)\s+(?:app|application)\s+is\s+(?:this\s+)?trace\s+from\b|\b(?:app|application)\s+package\b/i,
  /主要进程|主进程|进程名|process\s*name|main\s+process/i,
  /^\s*(?:recommended_process_name_param|(?:main_)?process_name|main_process)\s*[?？.。!！]*\s*$/i,
  /^\s*(?:current|target|focused|trace|main)\s+process(?:\s+name)?\s*[?？.。!！]*$/i,
  /(?:当前|这个|本次|该)?\s*(?:trace\s*)?(?:的)?\s*(?:当前|主要|主)?进程(?:名)?(?:是什么|是哪个|是哪一个|叫什么|是谁)(?:[？?。.!\s]*)$/i,
  /(?:当前|这个|本次|该)?\s*(?:trace\s*)?(?:是|是什么|是哪一个|是哪个|属于|来自).{0,8}进程(?:[？?。.!\s]*)$/i,
  /\b(?:what|which)\s+process\s+(?:is|was)\s+(?:this|this\s+trace|the\s+trace)(?:\s+from)?\b/i,
  /\b(?:what|which)\s+(?:is|was)\s+(?:the\s+)?(?:current|target|focused)\s+process\b/i,
  /\b(?:this|the)\s+trace\s+(?:is|was|comes?\s+from|belongs?\s+to)\s+(?:what|which)\s+process\b/i,
  /(?:哪个|哪一个|什么)进程/i,
  /\b(?:what|which)\s+(?:app|application|package)\s+(?:generated|created|produced|recorded|captured)\s+(?:this|the)\s+trace\b/i,
  /\b(?:what|which)\s+(?:app|application|package)\b.{0,24}\b(?:and|&)\b/i,
  /\b(?:app|application|package)\b.{0,24}\b(?:and|&)\b/i,
  /(?:应用|包名).{0,12}(?:和|以及|并且)/i,
  /\b(?:what|which)\s+process\b.{0,24}\b(?:and|&)\b/i,
  /\bprocess\b.{0,24}\b(?:and|&)\b/i,
  /进程.{0,12}(?:和|以及|并且)/i,
  /\b(?:pid|upid)\b/i,
];
const PROCESS_LIST_FACT_QUERY_PATTERN = /(?:有哪些|哪些|列出|显示|给我|告诉我).{0,12}进程(?:名)?|进程(?:名)?.{0,8}(?:有哪些|哪些|列表)|\b(?:list|show)\s+process(?:es)?\b|\b(?:which|what)\s+processes\b|\bprocess(?:es)?\s+(?:names|list)\b/i;

const TRACE_FACT_PATTERNS = [
  /^\s*(?:(?:is|are)\s+there|does\s+this\s+trace\s+have|有没有|有无|是否存在)?\s*(?:a\s+)?trace[_\s-]?bounds(?:\s*(?:table|rows?|data|range|duration|表|有吗|存在吗))?\s*[?？。.!]*\s*$/i,
  /(?:trace|recording)\s*(?:duration|length)|(?:trace|录制|采集|抓取|记录).*(?:时长|多长|多久|长度|时间范围)|(?:时长|多长|多久|长度|时间范围).*(?:trace|录制|采集|抓取|记录)/i,
  /(?:采样|录屏|录制|采集|抓取|抓|记录|录)(?:了)?(?:多久|多长(?:时间)?|时长|长度|时间范围)|(?:性能数据|trace\s*数据|trace\s*data).*(?:时长|多长(?:时间)?|多久|长度|时间范围)/i,
  /(?:trace|recording|capture)\s*(?:time\s*range|timespan|time\s*span|span|range)|(?:recording|capture)\s*(?:duration|length|time)/i,
  /how\s+long\s+(?:is|was)\s+(?:(?:this|the)\s+)?(?:trace|recording|capture)(?:\s+recorded)?|recording\s+length/i,
  /(?:trace|录制|采集|抓取|记录).*(?:起止|开始时间|结束时间|起始|终止|什么时候|何时|start(?:\s*time)?|end(?:\s*time)?|timestamps?)/i,
  /(?:trace|录制|采集|抓取|记录).*(?:时间|范围|时段|开始|结束)/i,
  /(?:什么时候|何时).*(?:trace|录制|采集|抓取|记录).*(?:开始|结束)|(?:trace|recording).*(?:start|end)\s*(?:time|timestamp)?/i,
  /帧率|\bfps\b|frame\s*rate/i,
  /总帧数|帧数|多少帧|frame\s*count|total\s*frames/i,
  /how\s+many\s+frames?(?:\s+(?:are\s+(?:there|in)|in\s+(?:this\s+)?trace|does\s+(?:this\s+)?trace\s+have))/i,
  /(?:cpu\s*)?(?:核心|核)(?:数量|数)|(?:多少|几个|几).*(?:cpu\s*)?(?:核心|核)|cpu.*(?:几|多少).*(?:核心|核)|cpu\s*(?:核心|核)\s*[?？]?$|\bcpu\s*cores?\s*[?？]?$|cpu\s*core\s*count|how\s+many\s+cpu\s+cores/i,
  /^\s*cpu\s+(?:count|rows?|table(?:\s+rows?)?)\s*[?？.。!！]*\s*$/i,
  /掉帧率|丢帧率|卡顿率|jank\s*rate|janky\s*frame\s*rate|dropped\s*frames?\s*rate|dropped\s*frame\s*percentage|percentage\s+of\s+(?:janky|dropped)\s+frames?/i,
  /(?:掉帧|丢帧|卡顿)(?:比例|占比)(?:是多少|多少|[？?。\s]*$)|\bjanky?\s*(?:percentage|ratio)\s*[?]?\s*$|what\s+percentage\s+of\s+frames\s+(?:are|were)\s+(?:janky?|dropped)/i,
  /(?:有没有|是否|有无).*(?:掉帧|丢帧|卡顿)|(?:掉帧|丢帧|卡顿).*(?:吗|么)(?:[？?。.!\s]*)$|\b(?:has|have|contains?)\b.*(?:jank|dropped\s*frames?)|\bany\s+jank\s*[?？.。!]*$|\b(?:is|was|are|were)\s+there\s+(?:any\s+)?jank(?:\s+in\s+(?:this\s+|the\s+)?(?:trace|recording|capture))?\s*[?？.。!]*$|\bjank\s+(?:present|detected)\s*[?？.。!]*$/i,
  /(?:掉帧|丢帧|卡顿)帧?(?:数量|数)|(?:多少|几个|几).*(?:掉帧|丢帧|卡顿)|(?:janky?|dropped)\s*frames?\s*(?:count|number)?\b|\bframe\s*drops?\s*(?:count|number)?\b|\bjank\s*frames?\s*(?:count|number)?\b|\bjank\s*count\b|how\s+many\s+(?:janky?|dropped)\s*frames?/i,
];
const TRACE_METRIC_EVALUATION_DIAGNOSTIC_PATTERN = /(?:帧率低|帧率高|fps\s*(?:low|high)|卡顿率高|掉帧率高|丢帧率高|帧数(?:高|低)|总帧数(?:高|低)|(?:高|低|偏高|偏低|过高|过低|太高|太低|正常|异常|合理)(?:吗|么|[？?])|(?:是否|是不是).{0,12}(?:正常|异常|合理)|\b(?:fps|frame\s*rate|jank\s*rate|janky\s*frame\s*rate|janky?\s*frames?(?:\s*(?:count|number))?|jank\s*count|dropped\s*frames?(?:\s*(?:count|number|rate))?|dropped\s*frame\s*percentage|frame\s*drops?(?:\s*(?:count|number|rate))?|frame\s*count|total\s*frames?)\b.{0,24}\b(?:high|low|slow|bad|normal|abnormal|too\s+high|too\s+low)\b|\b(?:is|are|was|were|seems?|looks?)\b.{0,24}\b(?:fps|frame\s*rate|jank\s*rate|janky\s*frame\s*rate|janky?\s*frames?(?:\s*(?:count|number))?|jank\s*count|dropped\s*frames?(?:\s*(?:count|number|rate))?|dropped\s*frame\s*percentage|frame\s*drops?(?:\s*(?:count|number|rate))?|frame\s*count|total\s*frames?)\b.{0,24}\b(?:high|low|slow|bad|normal|abnormal)\b)/i;
const TRACE_DURATION_EVALUATION_DIAGNOSTIC_PATTERN = /(?:时长|多长(?:时间)?|多久|长度|时间范围|duration|length|time\s*range|how\s+long).{0,24}(?:正常|异常|合理|过长|过短|太长|太短|高|低|normal|abnormal|reasonable|too\s+long|too\s+short|high|low)|(?:正常|异常|合理|过长|过短|太长|太短|normal|abnormal|reasonable|too\s+long|too\s+short|high|low).{0,24}(?:时长|长度|时间范围|duration|length|time\s*range)/i;
const SELECTION_DURATION_FACT_PATTERNS = [
  /(?:选区|选中(?:的)?|选择(?:的)?范围|当前范围|这个范围|范围|selected\s+range|selection|selected\s+slice|slice).*(?:时长|多长|多久|长度|duration|length|time\s*range)/i,
  /(?:时长|多长|多久|长度|duration|length).*(?:选区|选中(?:的)?|选择(?:的)?范围|当前范围|这个范围|selected\s+range|selection|selected\s+slice|slice)/i,
  /^\s*(?:selection|selected\s+range|selected\s+slice|slice)\s+(?:duration|length|time\s*range)\s*[?？.。!！]*\s*$/i,
];

const THREAD_TRACE_FACT_PATTERNS = [
  /^\s*(?:线程|threads?)\s*[？?.!。]*\s*$/i,
  /^\s*(?:线程|threads?)\s+(?:rows?|table(?:\s+rows?)?)\s*[?？.。!！]*\s*$/i,
  /线程(?:数量|数|总数)|(?:有|共有|一共有|总共|总计|一共)?\s*(?:多少|几个|几)个?线程(?:[？?。.!\s]*)$|多少线程(?:[？?。.!\s]*)$|threads?\s*count|total\s+threads?|how\s+many\s+threads?(?:\s+(?:are\s+there(?:\s+in\s+(?:this\s+)?trace)?|are\s+in\s+(?:this\s+)?trace|in\s+(?:this\s+)?trace|does\s+(?:this\s+)?trace\s+have))?(?:[?.!\s]*)$/i,
  /how\s+many\s+threads?\s+(?:does|do)\s+(?:the\s+)?(?:current|focus|focused|target|selected)\s+app(?:lication)?\s+have(?:[?.!\s]*)$/i,
];
const THREAD_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:卡顿|卡住|卡吗|慢|耗时|延迟|阻塞|原因|为什么|根因|分析|诊断|优化|建议|性能|过多|太多|很多|偏高|过高|数量高|数高|blocked|blocking|latency|slow|jank|high|too\s+many|excessive|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|performance)/i;

const PROCESS_TRACE_FACT_PATTERNS = [
  /^\s*(?:进程|processes)\s*[？?.!。]*\s*$/i,
  /^\s*process(?:es)?\s+(?:rows?|table(?:\s+rows?)?)\s*[?？.。!！]*\s*$/i,
  /进程(?:数量|数|总数)|(?:有|共有|一共有|总共|总计|一共)?\s*(?:多少|几个|几)个?进程(?:[？?。.!\s]*)$|多少进程(?:[？?。.!\s]*)$|process(?:es)?\s*count|total\s+process(?:es)?|how\s+many\s+process(?:es)?(?:\s+(?:are\s+there(?:\s+in\s+(?:this\s+)?trace)?|are\s+in\s+(?:this\s+)?trace|in\s+(?:this\s+)?trace|does\s+(?:this\s+)?trace\s+have))?(?:[?.!\s]*)$/i,
  /how\s+many\s+process(?:es)?\s+(?:does|do)\s+(?:the\s+)?(?:current|focus|focused|target|selected)\s+app(?:lication)?\s+have(?:[?.!\s]*)$/i,
  /(?:有哪些|哪些|列出|显示|给我|告诉我).{0,12}进程(?:名)?|进程(?:名)?.{0,8}(?:有哪些|哪些|列表)|\b(?:list|show)\s+process(?:es)?\b|\b(?:which|what)\s+processes\b|\bprocess(?:es)?\s+(?:names|list)\b/i,
];
const PROCESS_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:卡顿|卡住|卡吗|慢|耗时|延迟|阻塞|原因|为什么|根因|分析|诊断|优化|建议|性能|过多|太多|很多|偏高|过高|数量高|数高|cpu|内存|memory|blocked|blocking|latency|slow|jank|high|too\s+many|excessive|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|performance)/i;
const DEVICE_INFO_TRACE_FACT_PATTERNS = [
  /设备信息|设备型号|机型|device\s*(?:info|model)|os\s*(?:version|info)|android\s*version/i,
  /(?:安卓|Android)\s*(?:SDK\s*)?版本|SDK\s*版本|android\s*sdk\s*version/i,
  /\bandroid\s*sdk\b/i,
  /^\s*(?:android\s+)?sdk\s*(?:version)?\s*[?？.。!！]*\s*$/i,
  /(?:android\s*)?build\s*fingerprint|device\s*fingerprint|build\s*fingerprint/i,
  /内核(?:版本)?|kernel\s*(?:release|version)|system\s*release/i,
  /(?:系统|设备|CPU|cpu)\s*架构|\b(?:device|cpu|system)\s+architecture\b|\bsystem\s+machine\b|\bwhat\s+architecture\s+(?:is|was)\s+(?:this|this\s+trace|the\s+trace)\s+from\b/i,
  /(?:设备|手机).*(?:厂商|制造商|manufacturer|vendor|brand)|(?:device|phone)\s*(?:manufacturer|vendor|brand)/i,
  /(?:SoC|soc|芯片|处理器).*(?:型号|信息|是什么|是哪款|model)|(?:soc|chipset|processor)\s*(?:model|info|information)/i,
  /^\s*soc\s*(?:model|info|information)?\s*[?？.。!！]*\s*$/i,
  /手机(?:信息|型号|机型|系统(?:版本)?|安卓(?:版本)?)/i,
  /(?:这|当前|本次|该)?(?:是|是什么|是哪台|是哪款|是哪部)?(?:哪台|哪款|哪部|什么)手机(?:[？?。.!\s]*$|录(?:制|的)?|采集|抓取|记录)/i,
  /(?:trace|录制|采集|抓取|记录).*(?:哪台|哪款|哪部|什么)手机/i,
  /\b(?:phone|device)\s*(?:model|info|information|os|system|android\s*version)\b/i,
  /\b(?:what|which)\s+(?:phone|device)\s+(?:is|was)\s+(?:this|this\s+trace|the\s+trace|this\s+recording|the\s+recording)\b/i,
  /\b(?:what|which)\s+(?:phone|device).*\b(?:recorded|captured|traced)\b/i,
];
const DEVICE_INFO_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|问题|异常|影响|支持|瓶颈|卡顿|卡住|慢|延迟|耗时|性能|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|issues?|problems?|abnormal|affect|impact|support|bottleneck|slow|jank|latency|performance)/i;
const TRACE_HEALTH_TRACE_FACT_PATTERN = /(?:trace\s*(?:health|errors?|issues?)|(?:trace|录制|采集|解析).*(?:错误|异常|问题)|(?:采集|解析)(?:错误|异常|问题)|数据丢失|丢包|packet\s+loss|data\s*loss|stats?\s+errors?)/i;
const TRACE_HEALTH_TRACE_FACT_SHAPE_PATTERN = /(?:有没有|是否|有无|有.*[吗么]|多少|几个|几|数量|次数|列出|哪些|存在|any|has|have|is\s+there|are\s+there|how\s+many|list|show|which|what|[?？]\s*$)/i;
const TRACE_HEALTH_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|怎么修|如何修|修复|有哪些问题|什么问题|问题(?:是什么|在哪|原因)|丢包|packet\s+loss|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|fix|repair)/i;
const TRACE_DATA_INVENTORY_TRACE_FACT_PATTERN = /(?:trace|录制|采集|抓取|记录|本次|当前).*(?:有哪些|哪些|什么|有什么|有啥|包含|包括|采集了|记录了|可用).*(?:数据源|数据|信息|表|tables?|sources?)|(?:数据源|采集数据|trace\s*数据|trace\s*data|available\s+data|data\s+sources?).*(?:有哪些|哪些|什么|列表|列出|显示|show|list|available|availability|contains?|include|包含)|(?:what|which).*(?:data|tables?|data\s+sources?).*(?:available|captured|recorded|included?|contained?|in).*(?:trace|recording)|(?:what|which).*(?:does|is).*(?:trace|recording).*(?:contain|include|have|capture|record)|(?:counter[_\s-]?track|process[_\s-]?counter[_\s-]?track|cpu[_\s-]?counter[_\s-]?track|gpu[_\s-]?counter[_\s-]?track|counter\s+tracks?|counter\s+tables?|counter\s+rows?|counter\s+samples?|counter\s+data|\bcounters?\b)(?:.*(?:数据|样本|表|行|rows?|数量|多少|几个|几|count|有没有|是否|有无|存在|采集|记录|available|availability|samples?|tables?))?|(?:有没有|是否|有无|存在|采集|记录|多少|几个|几|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many).*(?:counter[_\s-]?track|process[_\s-]?counter[_\s-]?track|cpu[_\s-]?counter[_\s-]?track|gpu[_\s-]?counter[_\s-]?track|counter\s+tracks?|counter\s+tables?|counter\s+rows?|counter\s+samples?|counter\s+data|\bcounters?\b)/i;
const TRACE_DATA_INVENTORY_RAW_TRACE_FACT_COLUMN_PATTERN = /^\s*(?:slice|track|process|thread|process_track|thread_track|sched_slice|thread_state|counter_track|process_counter_track|cpu_counter_track|gpu_counter_track|counter_sample|cpufreq_sample|actual_frame_timeline_slice|expected_frame_timeline_slice|gpu_slice|gpu_counter_sample|network_packet_event|android_log)_count\s*[?？.。!！]*\s*$/i;
const TRACE_DATA_INVENTORY_BARE_TRACE_FACT_PATTERN = /^(?:(?:有哪些|哪些|什么|有什么|有啥|列出|显示|show|list|what|which)\s*)?(?:数据源|采集数据|trace\s*数据|trace\s*data|available\s+data(?:\s+sources?)?|data\s+sources?|tables?|counter[_\s-]?track|process[_\s-]?counter[_\s-]?track|cpu[_\s-]?counter[_\s-]?track|gpu[_\s-]?counter[_\s-]?track|counter|counters?|counter\s+tracks?|counter\s+tables?|counter\s+rows?|counter\s+samples?|counter\s+data)(?:\s*(?:有哪些|哪些|什么|列表|列出|显示|show|list|available|availability|contains?|include|包含|rows?|samples?|tables?|数据|样本|表|行))?[？?。.!\s]*$/i;
const TRACE_DATA_INVENTORY_BARE_TABLE_TRACE_FACT_PATTERN = /^\s*(?:(?:有哪些|哪些|什么|有什么|有啥|列出|显示)\s*(?:数据)?表|(?:数据)?表\s*(?:有哪些|哪些|列表|列出|显示|可用)|available\s+tables?)\s*[?？.。!！]*\s*$/i;
const TRACE_DATA_INVENTORY_TRACE_FACT_SHAPE_PATTERN = /(?:有哪些|哪些|什么|有什么|有啥|列表|列出|显示|show|list|available|availability|contains?|include|包含|包括|采集了|记录了|[?？]\s*$)/i;
const TRACE_DATA_INVENTORY_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:问题|错误|异常|为什么|原因|根因|分析|诊断|优化|建议|卡顿|卡住|慢|高|低|峰值|过高|偏高|过低|偏低|延迟|耗时|性能|怎么修|如何修|修复|缺失原因|issue|problem|error|abnormal|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|slow|high|low|spike|latency|delay|performance|fix|repair)/i;
const FRAME_TIMELINE_TRACE_FACT_PATTERN = /(?:frame[_\s-]?timeline|frametimeline|actual_frame_timeline_slice|expected_frame_timeline_slice|帧时间线|帧\s*timeline|帧渲染时间线)(?:.*(?:数据|事件|表|行|数量|多少|几个|几|slice|slices|有没有|是否|有无|存在|采集|记录|available|availability|data|events?|table|tables?|rows?|counts?))?|(?:有没有|是否|有无|存在|采集|记录|多少|几个|几|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many).*(?:frame[_\s-]?timeline|frametimeline|actual_frame_timeline_slice|expected_frame_timeline_slice|帧时间线|帧\s*timeline|帧渲染时间线)/i;
const FRAME_TIMELINE_TRACE_FACT_SHAPE_PATTERN = /(?:数据|事件|表|行|数量|多少|几个|几|slice|slices|有没有|是否|有无|有.*[吗么]|存在|采集|记录|available|availability|data|events?|table|tables?|rows?|counts?|how\s+many|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|[?？]\s*$)/i;
const FRAME_TIMELINE_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|卡顿|掉帧|丢帧|慢|耗时|延迟|瓶颈|负载|占用|高|低|异常|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|jank|slow|latency|delay|bottleneck|load|usage|utili[sz]ation|high|low|abnormal)/i;
const REFRESH_RATE_TRACE_FACT_PATTERN = /(?:(?:trace|录制|采集|抓取|记录|当前|本次|该).*(?:观测|推断|检测|测到|reported|observed|detected|inferred)?.*(?:刷新率|refresh\s*rate|vsync\s*(?:period|周期)|帧周期|frame\s*budget)|(?:观测|推断|检测|测到|reported|observed|detected|inferred).*(?:刷新率|refresh\s*rate|vsync\s*(?:period|周期)|帧周期|frame\s*budget).*(?:trace|录制|采集|recording)|(?:刷新率|refresh\s*rate|vsync\s*(?:period|周期)|帧周期|frame\s*budget).*(?:trace|录制|采集|抓取|记录|观测|推断|检测|reported|observed|detected|inferred))/i;
const BARE_REFRESH_RATE_TRACE_FACT_PATTERN = /^\s*(?:(?:what|which)\s+(?:is|was)\s+(?:the\s+)?)?(?:(?:(?:(?:current|observed|detected|inferred|display|screen)\s+|(?:当前|屏幕|显示|观测(?:到的|的)?|检测(?:到的|的)?|测到的?|推断(?:出的|的)?)\s*)?)(?:刷新率|refresh\s*rate|vsync\s*(?:period|周期)?|帧周期|frame\s*budget)|(?:display|screen|current|observed|detected|inferred)\s+hz)(?:\s*(?:是多少|是什么|多少|几|hz|ms|rate|period))?\s*[?？.。!！]*\s*$/i;
const REFRESH_RATE_TRACE_FACT_SHAPE_PATTERN = /(?:多少|几|是什么|是多少|Hz|hz|ms|毫秒|周期|rate|period|what|which|detected|observed|inferred|[?？]\s*$)/i;
const REFRESH_RATE_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:支持|support|vrr|variable\s+refresh|adaptive\s+sync|ltpo|策略|policy|切换|switch|为什么|原因|根因|分析|诊断|优化|建议|卡顿|掉帧|丢帧|慢|异常|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|jank|slow|abnormal)/i;
const CPU_FREQUENCY_TRACE_FACT_PATTERN = /(?:cpu\s*)?(?:频率|freq(?:uency)?|cpufreq|dvfs)(?:.*(?:数据|计数器|counter|counters?|有没有|是否|有无|存在|采集|记录))?|(?:有没有|是否|有无|存在|采集|记录).*(?:cpu\s*)?(?:频率|freq(?:uency)?|cpufreq|dvfs)|\b(?:cpufreq|cpu\s+freq(?:uency)?\s+(?:data|counters?)|cpu\s+frequency\s+counters?|dvfs\s+(?:data|counters?))\b/i;
const CPU_FREQUENCY_TRACE_FACT_SHAPE_PATTERN = /(?:数据|计数器|有没有|是否|有无|有.*[吗么]|存在|采集|记录|available|availability|data|counters?|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|[?？]\s*$)/i;
const CPU_FREQUENCY_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|升频|降频|频率低|频率高|不足|异常|慢|卡顿|卡住|耗时|延迟|性能|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|boost|throttl|slow|jank|latency|performance|low|high)/i;
const POWER_COUNTER_TRACE_FACT_PATTERN = /(?:功耗|耗电|电量|电池|电源|电流|电压|power|battery|energy|charge|watt).*(?:数据|计数器|counter|counters?|有没有|是否|有无|存在|采集|记录|样本|行|available|availability|rows?|samples?|sample\s+count)|(?:有没有|是否|有无|存在|采集|记录|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have).*(?:功耗|耗电|电量|电池|电源|电流|电压|power|battery|energy|charge|watt)|\b(?:power|battery|energy|charge)\s+(?:data|counters?|metrics?|rows?|samples?|sample\s+count)\b/i;
const POWER_COUNTER_TRACE_FACT_SHAPE_PATTERN = /(?:数据|计数器|有没有|是否|有无|有.*[吗么]|存在|采集|记录|样本|行|available|availability|data|counters?|metrics?|rows?|samples?|sample\s+count|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|[?？]\s*$)/i;
const POWER_COUNTER_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|耗电快|耗电高|功耗高|电流大|异常|偏高|偏低|过高|过低|高|低|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|drain|consume|consumption|power\s+draw|high|low|abnormal)/i;
const MEMORY_COUNTER_TRACE_FACT_PATTERN = /(?:内存|memory|rss|swap).*(?:数据|计数器|counter|counters?|有没有|是否|有无|存在|采集|记录|样本|行|available|availability|rows?|samples?|sample\s+count)|(?:有没有|是否|有无|存在|采集|记录|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have).*(?:内存|memory|rss|swap)|\b(?:memory|rss|swap)\s+(?:data|counters?|metrics?|rows?|samples?|sample\s+count)\b|(?:oom[_\s-]?score|oom).*(?:数据|计数器|counter|counters?|metrics?|available|availability)|(?:有没有|是否|有无|存在|采集|记录|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have).*(?:oom[_\s-]?score|oom).*(?:数据|计数器|counter|counters?|metrics?)/i;
const MEMORY_COUNTER_TRACE_FACT_SHAPE_PATTERN = /(?:数据|计数器|有没有|是否|有无|有.*[吗么]|存在|采集|记录|样本|行|available|availability|data|counters?|metrics?|rows?|samples?|sample\s+count|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|[?？]\s*$)/i;
const MEMORY_COUNTER_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|泄漏|过高|偏高|高|异常|增长|上涨|占用|压力|oom\s*原因|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|leak|high|abnormal|growth|pressure)/i;
const SCHEDULER_DATA_TRACE_FACT_PATTERN = /(?:调度|线程状态|thread[_\s-]?state|sched[_\s-]?slice|scheduler|scheduling).*(?:数据|事件|表|行|数量|多少|几个|几|计数|有没有|是否|有无|存在|采集|记录|available|availability|data|events?|table|tables?|rows?|count)|(?:有没有|是否|有无|存在|采集|记录|多少|几个|几|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many).*(?:调度|线程状态|thread[_\s-]?state|sched[_\s-]?slice|scheduler|scheduling)|\b(?:sched[_\s-]?slice|thread[_\s-]?state|scheduler|scheduling|sched)\s+(?:data|events?|tables?|table\s+rows?|rows?|counts?|availability)\b|\b(?:running|runnable)\s+(?:thread[_\s-]?states?|thread[_\s-]?state|states?)\s+(?:rows?|counts?|count)\b|\b(?:how\s+many|count|counts?|rows?).{0,24}\b(?:running|runnable)\s+(?:thread[_\s-]?states?|states?)\b|^\s*(?:sched[_\s-]?slice|thread[_\s-]?state|sched|scheduler)\s*[?？.。!！]*\s*$/i;
const SCHEDULER_THREAD_STATE_TRACE_FACT_PATTERN = /(?:(?:thread[_\s-]?state|线程状态).{0,32}(?:\b(?:R\+|D|DK|S|I)\b|preempted\s+runnable|running|runnable|sleeping|uninterruptible(?:\s+sleep)?|idle|抢占|运行|可运行|睡眠|不可中断|空闲).{0,32}(?:rows?|counts?|count|行|数量|多少|几个|几|计数|[?？]\s*$))|(?:(?:how\s+many|count|counts?|rows?|多少|几个|几|数量|计数).{0,32}(?:\b(?:R\+|D|DK|S|I)\b|preempted\s+runnable|running|runnable|sleeping|uninterruptible(?:\s+sleep)?|idle|抢占|运行|可运行|睡眠|不可中断|空闲).{0,32}(?:thread[_\s-]?states?|states?|线程状态|线程))|\b(?:preempted\s+runnable|running|runnable|sleeping|uninterruptible(?:\s+sleep)?|idle)\s+(?:thread[_\s-]?states?|thread[_\s-]?state|states?)\s+(?:rows?|counts?|count)\b/i;
const SCHEDULER_SHORT_THREAD_STATE_TRACE_FACT_PATTERN = /^\s*(?:(?:thread[_\s-]?state|线程状态)\s+)?(?:R\+|D|DK|S|I|preempted\s+runnable|running|runnable|sleeping|uninterruptible(?:\s+sleep)?|idle|抢占(?:等待)?|运行|可运行|睡眠|不可中断|空闲)(?:[-\s]+state|\s*状态)?\s*(?:thread[_\s-]?states?\s+|states?\s+)?(?:rows?|row\s+count|counts?|count|行数|行|数量|多少|几个|几|计数)\s*[?？.。!！]*\s*$/i;
const SCHEDULER_DATA_TRACE_FACT_SHAPE_PATTERN = /(?:数据|事件|表|行|数量|多少|几个|几|计数|有没有|是否|有无|有.*[吗么]|存在|采集|记录|available|availability|data|events?|table|tables?|rows?|counts?|how\s+many|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|[?？]\s*$)/i;
const SCHEDULER_DATA_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|延迟|调度等待|调度不足|调度问题|卡顿|卡住|慢|阻塞|抢占|过多|很多|高|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|latency|delay|jank|slow|blocked|blocking|preempt|contention|high|too\s+many|excessive|spike)/i;
const SCHEDULER_THREAD_STATE_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|延迟|调度等待|调度不足|调度问题|卡顿|卡住|慢|阻塞|过多|很多|高|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|latency|delay|jank|slow|blocked|blocking|contention|high|too\s+many|excessive|spike)/i;
const GPU_DATA_TRACE_FACT_PATTERN = /(?:gpu|图形|图像|渲染器|显卡).*(?:数据|事件|切片|slice|slices|计数器|counter|counters?|表|行|rows?|样本|样本数|samples?|sample\s+count|数量|count|有没有|是否|有无|存在|采集|记录|available|availability|metrics?)|(?:gpu[_\s-]?(?:slice|slices|counter|counters?|data|samples?)|gpu\s+(?:data|events?|slices?|counters?|metrics?|tables?|table\s+rows?|rows?|samples?|sample\s+count|counts?|availability))|(?:有没有|是否|有无|存在|采集|记录|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have).*(?:gpu|图形|图像|渲染器|显卡)/i;
const GPU_DATA_TRACE_FACT_SHAPE_PATTERN = /(?:数据|事件|切片|slice|slices|计数器|counter|counters?|样本|样本数|samples?|sample\s+count|有没有|是否|有无|有.*[吗么]|存在|采集|记录|available|availability|data|events?|metrics?|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|[?？]\s*$)/i;
const GPU_DATA_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|卡顿|掉帧|丢帧|慢|耗时|延迟|瓶颈|负载|占用|高|低|异常|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|jank|slow|latency|delay|bottleneck|load|usage|utili[sz]ation|high|low|abnormal)/i;
const SLICE_DATA_TRACE_FACT_PATTERN = /(?:\bslices?\b|切片|\btracks?\b|process_track|thread_track|时间线事件|timeline\s+events?)(?:.*(?:数据|事件|表|行|rows?|数量|多少|几个|几|count|有没有|是否|有无|存在|采集|记录|available|availability|table|tables?))?|(?:有没有|是否|有无|存在|采集|记录|多少|几个|几|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many).*(?:\bslices?\b|切片|\btracks?\b|process_track|thread_track|时间线事件|timeline\s+events?)/i;
const SLICE_DATA_TRACE_FACT_SHAPE_PATTERN = /(?:数据|事件|表|行|rows?|数量|多少|几个|几|count|有没有|是否|有无|有.*[吗么]|存在|采集|记录|available|availability|table|tables?|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many|[?？]\s*$)/i;
const SLICE_DATA_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|卡顿|掉帧|丢帧|慢|耗时|时长|延迟|瓶颈|负载|占用|高|低|异常|阻塞|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|jank|slow|latency|delay|duration|bottleneck|load|usage|utili[sz]ation|high|low|abnormal|blocked|blocking)/i;
const NETWORK_PACKET_TRACE_FACT_PATTERN = /(?:android[_\s.-]?network[_\s.-]?packets?|network[_\s-]?packets?|network\s+traffic|packet[-_\s]?level\s+network|网络包|网络数据包|网络数据|网络流量|网络字节(?:数|量)?|流量数据|数据包)(?:.*(?:数据|事件|表|行|rows?|数量|多少|几个|几|count|bytes?|字节|有没有|是否|有无|存在|采集|记录|available|availability|traffic|packets?))?|(?:有没有|是否|有无|存在|采集|记录|多少|几个|几|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many).*(?:android[_\s.-]?network[_\s.-]?packets?|network[_\s-]?packets?|network\s+traffic|packet[-_\s]?level\s+network|网络包|网络数据包|网络数据|网络流量|网络字节(?:数|量)?|流量数据|数据包)|\b(?:network|traffic|packets?)\s+(?:data|events?|tables?|table\s+rows?|rows?|counts?|bytes?|packet\s+bytes?)\b|^\s*packets\s*[?？.。!！]*\s*$/i;
const NETWORK_PACKET_TRACE_FACT_SHAPE_PATTERN = /(?:数据|事件|表|行|rows?|数量|多少|几个|几|count|bytes?|字节|有没有|是否|有无|有.*[吗么]|存在|采集|记录|available|availability|traffic|packets?|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many|[?？]\s*$)/i;
const NETWORK_PACKET_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|慢|延迟|耗时|失败|错误|丢包|丢失|掉包|重传|超时|请求|带宽|高|低|异常|耗电|功耗|dns|tls|ttfb|http|quic|ech|certificate|networkcallback|networkcapabilities|local\s+network\s+permission|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|slow|latency|delay|timeout|request|failed|failure|loss|lost|drop|dropped|retransmit|retransmission|bandwidth|high|low|abnormal|drain|power)/i;
const LOGCAT_TRACE_FACT_PATTERN = /(?:logcat|android[_\s-]?logs?|日志|系统日志)(?:.*(?:数据|日志|事件|表|行|rows?|数量|多少|几个|几|count|有没有|是否|有无|存在|采集|记录|available|availability))?|(?:有没有|是否|有无|存在|采集|记录|多少|几个|几|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many).*(?:logcat|android[_\s-]?logs?|日志|系统日志)|\blogs?\s+(?:tables?|table\s+rows?|rows?|counts?)\b|^\s*logs\s*[?？.。!！]*\s*$/i;
const LOGCAT_TRACE_FACT_SHAPE_PATTERN = /(?:数据|日志|事件|表|行|rows?|数量|多少|几个|几|count|有没有|是否|有无|有.*[吗么]|存在|采集|记录|available|availability|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many|[?？]\s*$)/i;
const LOGCAT_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|问题|异常|报错|错误|崩溃|卡顿|慢|延迟|耗时|失败|告警|警告|很多|过多|太多|大量|频繁|根因|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|issues?|problems?|errors?|exceptions?|crash|slow|jank|latency|delay|failure|warning|too\s+many|frequent)/i;
const LOGCAT_SEVERITY_COUNT_FACT_PATTERN = /(?:(?:logcat|android[_\s-]?logs?|\blogs?\b|日志|系统日志).{0,40}(?:warn(?:ings?)?|errors?|fatal|警告|告警|错误|报错|严重).{0,40}(?:rows?|counts?|count|多少|几个|几|数量|条|any|有没有|是否|有无|[?？]\s*$)|(?:how\s+many|count|counts?|rows?|any|are\s+there|is\s+there|有没有|是否|有无|多少|几个|几|数量|条).{0,40}(?:(?:logcat|android[_\s-]?logs?|\blogs?\b|日志|系统日志).{0,40}(?:warn(?:ings?)?|errors?|fatal|警告|告警|错误|报错|严重)|(?:warn(?:ings?)?|errors?|fatal|警告|告警|错误|报错|严重).{0,40}(?:logcat|android[_\s-]?logs?|\blogs?\b|日志|系统日志))|(?:warn(?:ings?)?|errors?|fatal|警告|告警|错误|报错|严重).{0,20}\b(?:in|from)\s+(?:logcat|android[_\s-]?logs?|\blogs?\b|日志|系统日志)\b(?:[?？.。!！]*\s*$)|(?:warn(?:ings?)?|errors?|fatal)\s+logs?\s*(?:rows?|counts?|count|[?？.。!！]*\s*$))/i;
const LOGCAT_CHINESE_SEVERITY_COUNT_FACT_PATTERN = /(?:(?:有|有没有|是否|有无).{0,12}(?:警告|告警|错误|报错|严重).{0,12}(?:日志|系统日志|logcat)(?:.{0,6}(?:有吗|吗|么|多少|几|数量|条))?|(?:警告|告警|错误|报错|严重).{0,8}(?:日志|系统日志|logcat)(?:.{0,8}(?:有吗|吗|么|多少|几|数量|条))?)\s*[?？.。!！]*$/i;
const LOGCAT_SEVERITY_EVALUATION_DIAGNOSTIC_PATTERN = /(?:很多|过多|太多|大量|频繁|偏高|过高|太高|正常|异常|合理|很严重|严重(?:吗|么|[?？])|too\s+many|frequent|normal|abnormal|reasonable)/i;
const LOGCAT_AMBIGUOUS_ROW_ERROR_PATTERN = /^\s*logs?\s+rows?\s+errors?\s*[?？.。!！]*\s*$/i;
const LOGCAT_CAUSAL_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|问题|异常|崩溃|卡顿|慢|延迟|耗时|失败|why|causes?|reasons?|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|issues?|problems?|exceptions?|crash|slow|jank|latency|delay|failure)/i;
const BINDER_TRACE_FACT_PATTERN = /(?:\bbinder\b|android[_\s-]?binder[_\s-]?txns?)/i;
const BINDER_TRACE_FACT_SHAPE_PATTERN = /(?:数量|次数|总数|多少|几个|几|count|how\s+many|is\s+there|are\s+there|有没有|是否|有无|[?？]\s*$)/i;
const BINDER_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:阻塞|耗时|延迟|慢|原因|为什么|blocked|blocking|latency|slow|why|root\s*cause|diagnos(?:e|is)|analy[sz]e)/i;
const ANR_TRACE_FACT_PATTERN = /(?:\banrs?\b|android[_\s-]?anrs?|app\s+not\s+responding|应用无响应|无响应)/i;
const ANR_TRACE_FACT_SHAPE_PATTERN = /(?:数量|次数|总数|多少|几个|几|count|how\s+many|is\s+there|are\s+there|any|有没有|是否|有无|存在|[?？]\s*$)/i;
const ANR_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:原因|为什么|根因|分析|诊断|优化|建议|阻塞|死锁|卡死|卡住|blocked|blocking|deadlock|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend)/i;
const STARTUP_TRACE_FACT_PATTERN = /(?:启动|launch(?:es|ed|ing)?|startup(?:s)?|android[_\s-]?startups?)/i;
const STARTUP_TRACE_FACT_SHAPE_PATTERN = /(?:数据|data|事件|events?|表|行|rows?|tables?|数量|次数|总数|多少|几个|几次|count|how\s+many|is\s+there|are\s+there|any|有没有|是否|有无|存在|有.*[吗么]|has|have|does|android[_\s-]?startups?|\bapp\s+launches\s*[?？]\s*$)/i;
const STARTUP_DURATION_TRACE_FACT_SHAPE_PATTERN = /(?:(?:冷)?启动时间|耗时|时长|用时|用了多久|花了多久|持续多久|持续时间|多久|多长时间|duration|how\s+long|startup\s+time|startup\s+took|launch\s+(?:time|took)|app\s+launch\s+time|app\s+launch\s+duration)/i;
const STARTUP_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:开始时间|结束时间|起止|ttid|ttfd|慢|性能|原因|为什么|根因|分析|诊断|优化|建议|卡顿|阻塞|高|低|偏高|偏低|过高|过低|太高|太低|正常|异常|合理|timing|start\s*time|end\s*time|timestamps?|time\s+to\s+display|slow|latency|\b(?:high|low|normal|abnormal|bad|good)\b|too\s+(?:high|low)|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|jank|blocked|blocking)/i;
const SCROLL_TRACE_FACT_PATTERN = /(?:滑动|滚动|\bscroll(?:ing|s)?\b|\bscroll\s*gestures?\b|\bswipes?\b)/i;
const SCROLL_TRACE_FACT_SHAPE_PATTERN = /(?:次数|多少|几个|几次|手势|表|行|scrolls?|gesture|gestures?|swipes?|table|tables?|rows?|count|how\s+many|is\s+there|are\s+there|any|有没有|是否|有无|存在|has|have|does)/i;
const SCROLL_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:fps|帧率|帧|掉帧|丢帧|卡顿|流畅|性能|耗时|时延|延迟|慢|高|过多|很多|原因|为什么|根因|分析|诊断|优化|建议|jank|frame|rate|latency|slow|smooth|high|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend)/i;
const INPUT_EVENT_TRACE_FACT_PATTERN = /(?:输入事件|触摸事件|触摸(?:次数|数量)|按键事件|按键次数|键盘事件|\binput\s*(?:events?|事件)|\btouch\s*(?:events?|事件)|\btouches?(?:\s+(?:events?|rows?|counts?|count))?\b|\bkey\s*(?:events?|事件)|\b(?:key|keyboard)\s*(?:events?|press(?:es)?)\b|android[_\s-]?input[_\s-]?events?|\b(?:input|touch|key)\s+(?:tables?|table\s+rows?|rows?|counts?)\b|(?:\b(?:android|input|touch)\b).{0,20}\bmotion\s*events?\b|\bmotion\s+(?:input|touch|rows?|counts?|count)\b|\bmotion\s+(?:input|touch)\s*events?\b|(?:how\s+many|count|counts?|rows?).{0,20}\b(?:motion\s*events?|touches?)\b|\bmotion\s*events?(?:\s+(?:count|counts?|rows?))?\b|(?:有|多少|几个|几).{0,12}motion.{0,8}事件|\bmotion\s*事件\s*(?:数量|次数))/i;
const INPUT_EVENT_TRACE_FACT_SHAPE_PATTERN = /(?:数量|次数|总数|多少|几个|几次|表|行|rows?|tables?|count|how\s+many|is\s+there|are\s+there|any|有没有|是否|有无|存在|has|have|does|[?？]\s*$)/i;
const INPUT_EVENT_TRACE_FACT_DIAGNOSTIC_PATTERN = /(?:延迟|时延|耗时|慢|卡顿|掉帧|丢帧|原因|为什么|根因|分析|诊断|优化|建议|跟手|响应|导致|造成|latency|delay|slow|jank|dropped\s+frames?|frame\s+drops?|caus(?:e|es|ed|ing)|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|response|responsiveness)/i;

const FACT_QUERY_SHAPE_PATTERNS = [
  /多少|几|多长|多久|什么时候|何时|起止|开始|结束|是什么|是哪|哪台|哪款|哪部|哪些|有没有|是否|有无|列出|显示|给我|告诉我/,
  /\b(?:what|which|how\s+(?:many|long)|is\s+there|are\s+there|does\s+it|show|list|tell\s+me)\b/i,
  /(?:率|rate|percentage|start|end|timestamp|[?？]\s*$)/i,
];
const PLAIN_CHINESE_PRESENCE_QUERY_PATTERN = /(?:^|[\s,，;；。.!！?？])有.{0,40}(?:吗|么)(?:[？?。.!！\s]*)$|有(?:吗|么)(?:[？?。.!！\s]*)$/;

const DIAGNOSTIC_SCOPE_PATTERNS = [
  /为什么|原因|根因|分析|诊断|优化|建议|有哪些问题|什么问题|问题(?:是什么|在哪|原因)|卡顿|卡住|卡吗|很卡|滑动卡|卡$|慢|延迟|耗时|性能/,
  /\b(?:why|root\s*cause|analy[sz]e|diagnos(?:e|is)|optimi[sz]e|recommend|what\s+(?:issues?|problems?)|which\s+(?:issues?|problems?)|slow|jank|latency|compare)\b/i,
  /对比|比较|差异/,
];

const IDENTITY_MIXED_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|有哪些问题|什么问题|问题(?:是什么|在哪|原因)|卡顿(?!率|比例|占比)|卡住|卡吗|很卡|滑动卡|卡$|慢|延迟|耗时|性能|\b(?:why|root\s*cause|analy[sz]e|diagnos(?:e|is)|optimi[sz]e|recommend|what\s+(?:issues?|problems?)|which\s+(?:issues?|problems?)|slow|latency|compare)\b|对比|比较|差异)/i;

const DEEP_DIAGNOSTIC_INTENT_PATTERNS = [
  /为什么|原因|根因|分析|诊断|优化|建议|导致|造成|对比|比较|差异/,
  /\b(?:why|caus(?:e|es|ed|ing)|reasons?|root\s*cause|analy[sz]e|diagnos(?:e|is)|optimi[sz]e|recommend|compare)\b/i,
];

/** Upper bound for treating CONFIRM_KEYWORDS as a pure confirmation.
 *  Longer queries (e.g., "谢谢你，但具体第几帧最卡") mix confirmation with real follow-up intent. */
const CONFIRM_MAX_LENGTH = 20;

/**
 * Local-only classification using non-negotiable scope and acknowledgement rules.
 * Returns null when no local rule matches, so callers can decide their own
 * AI fallback. Provider-agnostic: zero LLM/SDK dependency.
 */
export function classifyQueryComplexityLocal(
  input: ComplexityClassifierInput,
): { complexity: QueryComplexity; reason: string; source: 'hard_rule' } | null {
  const acknowledgementResult = applyAcknowledgementRule(input.query);
  if (acknowledgementResult) {
    console.log(
      `[ComplexityClassifier] Acknowledgement rule → ${acknowledgementResult.complexity}: ${acknowledgementResult.reason}`,
    );
    return { ...acknowledgementResult, source: 'hard_rule' };
  }

  const scopeResult = applyScopeHardRules(input);
  if (scopeResult) {
    console.log(`[ComplexityClassifier] Scope rule → ${scopeResult.complexity}: ${scopeResult.reason}`);
    return { ...scopeResult, source: 'hard_rule' };
  }

  const identityFactResult = applyIdentityFactRule(input.query);
  if (identityFactResult) {
    console.log(
      `[ComplexityClassifier] Identity fact rule → ${identityFactResult.complexity}: ${identityFactResult.reason}`,
    );
    return { ...identityFactResult, source: 'hard_rule' };
  }

  const traceFactResult = applyTraceFactRule(input);
  if (traceFactResult) {
    console.log(
      `[ComplexityClassifier] Trace fact rule → ${traceFactResult.complexity}: ${traceFactResult.reason}`,
    );
    return { ...traceFactResult, source: 'hard_rule' };
  }

  const scrollingTriageResult = applyScrollingTriageRule(input.query);
  if (scrollingTriageResult) {
    console.log(
      `[ComplexityClassifier] Scrolling triage rule → ${scrollingTriageResult.complexity}: ${scrollingTriageResult.reason}`,
    );
    return { ...scrollingTriageResult, source: 'hard_rule' };
  }

  return null;
}

/** Classify query complexity using local safety rules + semantic AI classification. */
type QueryComplexityClassifierConfig =
  Pick<ClaudeAgentConfig, 'lightModel' | 'classifierTimeoutMs'> & {
    providerId?: string | null;
    providerScope?: ProviderScope;
  };

export async function classifyQueryComplexity(
  input: ComplexityClassifierInput,
  config?: QueryComplexityClassifierConfig,
): Promise<{ complexity: QueryComplexity; reason: string; source: 'hard_rule' | 'ai' }> {
  const local = classifyQueryComplexityLocal(input);
  if (local) return local;

  try {
    const aiResult = await classifyWithHaiku(input, config);
    console.log(`[ComplexityClassifier] AI → ${aiResult.complexity}: ${aiResult.reason}`);
    return { ...aiResult, source: 'ai' };
  } catch (err) {
    console.warn('[ComplexityClassifier] Haiku classification failed, defaulting to full:', (err as Error).message);
    return { complexity: 'full', reason: 'AI classification failed (graceful degradation)', source: 'ai' };
  }
}

/**
 * Scope rules that route before semantic classification.
 * Keep this list minimal: selection is a range signal, not a complexity
 * signal, so selection-aware quick/full decisions belong in the shared
 * classifier prompt rather than a local hard lock.
 */
function applyScopeHardRules(
  input: ComplexityClassifierInput,
): { complexity: QueryComplexity; reason: string } | null {
  if (input.hasReferenceTrace) {
    return { complexity: 'full', reason: 'comparison mode' };
  }
  return null;
}

function applyIdentityFactRule(
  query: string,
): { complexity: QueryComplexity; reason: string } | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  if (queryMentionsProcessListFact(trimmed)) return null;
  if (!queryMentionsTraceIdentityFact(trimmed)) return null;
  if (DIAGNOSTIC_SCOPE_PATTERNS.some(pattern => pattern.test(trimmed))) return null;
  return { complexity: 'quick', reason: TRACE_IDENTITY_FACT_LOOKUP_REASON };
}

export function queryMentionsProcessListFact(query: string): boolean {
  const trimmed = query.trim();
  return trimmed !== '' && PROCESS_LIST_FACT_QUERY_PATTERN.test(trimmed);
}

export function queryMentionsTraceIdentityFact(query: string): boolean {
  const trimmed = query.trim();
  return trimmed !== '' && IDENTITY_FACT_PATTERNS.some(pattern => pattern.test(trimmed));
}

function applyTraceFactRule(
  input: ComplexityClassifierInput,
): { complexity: QueryComplexity; reason: string } | null {
  const query = input.query;
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > 120) return null;
  if (
    input.selectionContext &&
    SELECTION_DURATION_FACT_PATTERNS.some(pattern => pattern.test(trimmed)) &&
    !DEEP_DIAGNOSTIC_INTENT_PATTERNS.some(pattern => pattern.test(trimmed))
  ) {
    return { complexity: 'quick', reason: TRACE_FACT_LOOKUP_REASON };
  }
  if (
    matchesLongestProcessSlicesFactQuery(trimmed)
    && !DEEP_DIAGNOSTIC_INTENT_PATTERNS.some(pattern => pattern.test(trimmed))
  ) {
    return { complexity: 'quick', reason: TRACE_FACT_LOOKUP_REASON };
  }
  if (!matchesTraceFactPattern(trimmed)) return null;
  if (!FACT_QUERY_SHAPE_PATTERNS.some(pattern => pattern.test(trimmed))
    && !PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed)) {
    return null;
  }
  if (queryMentionsTraceIdentityFact(trimmed) && IDENTITY_MIXED_DIAGNOSTIC_PATTERN.test(trimmed)) return null;
  if (DEEP_DIAGNOSTIC_INTENT_PATTERNS.some(pattern => pattern.test(trimmed))) return null;
  return { complexity: 'quick', reason: TRACE_FACT_LOOKUP_REASON };
}

function applyScrollingTriageRule(
  query: string,
): { complexity: QueryComplexity; reason: string } | null {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > 160) return null;
  if (!shouldUseQuickScrollingTriageIntent({ query: trimmed, requireExplicitOverview: true })) return null;
  return { complexity: 'quick', reason: SCROLLING_TRIAGE_LOOKUP_REASON };
}

function matchesTraceFactPattern(trimmed: string): boolean {
  const hasPlainChinesePresenceShape = PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed);
  if (TRACE_FACT_PATTERNS.some(pattern => pattern.test(trimmed))
    && !TRACE_METRIC_EVALUATION_DIAGNOSTIC_PATTERN.test(trimmed)
    && !TRACE_DURATION_EVALUATION_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  if (THREAD_TRACE_FACT_PATTERNS.some(pattern => pattern.test(trimmed))
    && !THREAD_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  if (PROCESS_TRACE_FACT_PATTERNS.some(pattern => pattern.test(trimmed))
    && !PROCESS_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  if (DEVICE_INFO_TRACE_FACT_PATTERNS.some(pattern => pattern.test(trimmed))
    && !DEVICE_INFO_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  if (TRACE_HEALTH_TRACE_FACT_PATTERN.test(trimmed)
    && (TRACE_HEALTH_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
    && !TRACE_HEALTH_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  const isBareTraceDataInventoryFact = TRACE_DATA_INVENTORY_BARE_TRACE_FACT_PATTERN.test(trimmed);
  const isBareTraceDataInventoryTableFact = TRACE_DATA_INVENTORY_BARE_TABLE_TRACE_FACT_PATTERN.test(trimmed);
  const isRawTraceDataInventoryColumnFact = TRACE_DATA_INVENTORY_RAW_TRACE_FACT_COLUMN_PATTERN.test(trimmed);
  if ((TRACE_DATA_INVENTORY_TRACE_FACT_PATTERN.test(trimmed)
    || isBareTraceDataInventoryFact
    || isBareTraceDataInventoryTableFact
    || isRawTraceDataInventoryColumnFact)
    && (isBareTraceDataInventoryFact
      || isBareTraceDataInventoryTableFact
      || isRawTraceDataInventoryColumnFact
      || TRACE_DATA_INVENTORY_TRACE_FACT_SHAPE_PATTERN.test(trimmed)
      || hasPlainChinesePresenceShape)
    && !matchesSpecificDataPresenceFactPattern(trimmed, hasPlainChinesePresenceShape)
    && !TRACE_DATA_INVENTORY_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  if (FRAME_TIMELINE_TRACE_FACT_PATTERN.test(trimmed)
    && (FRAME_TIMELINE_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
    && !FRAME_TIMELINE_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  const isBareRefreshRateFact = BARE_REFRESH_RATE_TRACE_FACT_PATTERN.test(trimmed);
  if ((REFRESH_RATE_TRACE_FACT_PATTERN.test(trimmed) || isBareRefreshRateFact)
    && (isBareRefreshRateFact
      || REFRESH_RATE_TRACE_FACT_SHAPE_PATTERN.test(trimmed)
      || hasPlainChinesePresenceShape)
    && !REFRESH_RATE_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  if (CPU_FREQUENCY_TRACE_FACT_PATTERN.test(trimmed)
    && (CPU_FREQUENCY_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
    && !CPU_FREQUENCY_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  if (POWER_COUNTER_TRACE_FACT_PATTERN.test(trimmed)
    && (POWER_COUNTER_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
    && !POWER_COUNTER_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  if (MEMORY_COUNTER_TRACE_FACT_PATTERN.test(trimmed)
    && (MEMORY_COUNTER_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
    && !MEMORY_COUNTER_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  if (matchesSchedulerDataTraceFactPattern(trimmed, hasPlainChinesePresenceShape)) {
    return true;
  }
  if (GPU_DATA_TRACE_FACT_PATTERN.test(trimmed)
    && (GPU_DATA_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
    && !GPU_DATA_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  if (SLICE_DATA_TRACE_FACT_PATTERN.test(trimmed)
    && (SLICE_DATA_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
    && !SLICE_DATA_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  if (NETWORK_PACKET_TRACE_FACT_PATTERN.test(trimmed)
    && (NETWORK_PACKET_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
    && !NETWORK_PACKET_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  if (matchesLogcatTraceFactPattern(trimmed, hasPlainChinesePresenceShape)) {
    return true;
  }
  if (BINDER_TRACE_FACT_PATTERN.test(trimmed)
    && (BINDER_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
    && !BINDER_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  if (ANR_TRACE_FACT_PATTERN.test(trimmed)
    && (ANR_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
    && !ANR_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  if (STARTUP_TRACE_FACT_PATTERN.test(trimmed)
    && (
      STARTUP_TRACE_FACT_SHAPE_PATTERN.test(trimmed)
      || STARTUP_DURATION_TRACE_FACT_SHAPE_PATTERN.test(trimmed)
      || hasPlainChinesePresenceShape
    )
    && !STARTUP_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  if (SCROLL_TRACE_FACT_PATTERN.test(trimmed)
    && (SCROLL_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
    && !SCROLL_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed)) {
    return true;
  }
  return INPUT_EVENT_TRACE_FACT_PATTERN.test(trimmed)
    && (INPUT_EVENT_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
    && !INPUT_EVENT_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesSpecificDataPresenceFactPattern(
  trimmed: string,
  hasPlainChinesePresenceShape: boolean,
): boolean {
  return (CPU_FREQUENCY_TRACE_FACT_PATTERN.test(trimmed)
    && (CPU_FREQUENCY_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
    && !CPU_FREQUENCY_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed))
    || (POWER_COUNTER_TRACE_FACT_PATTERN.test(trimmed)
      && (POWER_COUNTER_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
      && !POWER_COUNTER_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed))
    || (MEMORY_COUNTER_TRACE_FACT_PATTERN.test(trimmed)
      && (MEMORY_COUNTER_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
      && !MEMORY_COUNTER_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed))
    || matchesSchedulerDataTraceFactPattern(trimmed, hasPlainChinesePresenceShape)
    || (GPU_DATA_TRACE_FACT_PATTERN.test(trimmed)
      && (GPU_DATA_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
      && !GPU_DATA_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed))
    || (SLICE_DATA_TRACE_FACT_PATTERN.test(trimmed)
      && (SLICE_DATA_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
      && !SLICE_DATA_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed))
    || (NETWORK_PACKET_TRACE_FACT_PATTERN.test(trimmed)
      && (NETWORK_PACKET_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape)
      && !NETWORK_PACKET_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed))
    || matchesLogcatTraceFactPattern(trimmed, hasPlainChinesePresenceShape);
}

function matchesLogcatTraceFactPattern(
  trimmed: string,
  hasPlainChinesePresenceShape: boolean,
): boolean {
  const isSeverityCountFact = (LOGCAT_SEVERITY_COUNT_FACT_PATTERN.test(trimmed)
    || LOGCAT_CHINESE_SEVERITY_COUNT_FACT_PATTERN.test(trimmed))
    && !LOGCAT_AMBIGUOUS_ROW_ERROR_PATTERN.test(trimmed)
    && !LOGCAT_SEVERITY_EVALUATION_DIAGNOSTIC_PATTERN.test(trimmed)
    && !LOGCAT_CAUSAL_DIAGNOSTIC_PATTERN.test(trimmed);
  return (LOGCAT_TRACE_FACT_PATTERN.test(trimmed) || isSeverityCountFact)
    && (LOGCAT_TRACE_FACT_SHAPE_PATTERN.test(trimmed) || hasPlainChinesePresenceShape || isSeverityCountFact)
    && (!LOGCAT_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed) || isSeverityCountFact);
}

function matchesSchedulerDataTraceFactPattern(
  trimmed: string,
  hasPlainChinesePresenceShape: boolean,
): boolean {
  const isThreadStateCountFact = SCHEDULER_THREAD_STATE_TRACE_FACT_PATTERN.test(trimmed)
    || SCHEDULER_SHORT_THREAD_STATE_TRACE_FACT_PATTERN.test(trimmed);
  const isNonDiagnosticThreadStateCountFact = isThreadStateCountFact
    && !SCHEDULER_THREAD_STATE_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed);
  return (SCHEDULER_DATA_TRACE_FACT_PATTERN.test(trimmed) || isThreadStateCountFact)
    && (
      isThreadStateCountFact
      || SCHEDULER_DATA_TRACE_FACT_SHAPE_PATTERN.test(trimmed)
      || hasPlainChinesePresenceShape
    )
    && (!SCHEDULER_DATA_TRACE_FACT_DIAGNOSTIC_PATTERN.test(trimmed) || isNonDiagnosticThreadStateCountFact);
}

/**
 * Acknowledgement pre-filter (runs before scope rules and semantic AI classification).
 * Keep this intentionally narrow: "why/root cause/deep" needs semantic scope judgment,
 * because it may refer to a specific thread/slice/range rather than a whole-scene diagnosis.
 * - Confirm-like keywords in short queries → force quick (pure acknowledgement follow-ups)
 * Returns null when nothing matches, so Haiku still gets a turn.
 */
function applyAcknowledgementRule(
  query: string,
): { complexity: QueryComplexity; reason: string } | null {
  if (query.length >= CONFIRM_MAX_LENGTH) return null;
  const normalizedQuery = normalizeAcknowledgement(query);
  if (normalizedQuery && isPureAcknowledgementSequence(normalizedQuery)) {
    return { complexity: 'quick', reason: `${ACKNOWLEDGEMENT_FOLLOWUP_REASON_PREFIX} "${query.trim()}"` };
  }
  return null;
}

export function isAcknowledgementFollowupReason(reason: string): boolean {
  return reason.startsWith(ACKNOWLEDGEMENT_FOLLOWUP_REASON_PREFIX);
}

function normalizeAcknowledgement(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s,，.。!！?？~～…、;；:：]+/g, '');
}

function isPureAcknowledgementSequence(normalizedQuery: string): boolean {
  const matchable = Array(normalizedQuery.length + 1).fill(false) as boolean[];
  matchable[0] = true;
  for (let start = 0; start < normalizedQuery.length; start += 1) {
    if (!matchable[start]) continue;
    for (const keyword of NORMALIZED_CONFIRM_KEYWORDS) {
      if (normalizedQuery.startsWith(keyword, start)) {
        matchable[start + keyword.length] = true;
      }
    }
  }
  return matchable[normalizedQuery.length] === true;
}

function successfulSdkResultText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const record = message as Record<string, unknown>;
  if (record.type !== 'result' || record.subtype !== 'success') return undefined;
  return typeof record.result === 'string' ? record.result : '';
}

/**
 * AI-based classification using Claude Haiku.
 * Prompt loaded from prompt-complexity-classifier.template.md.
 */
async function classifyWithHaiku(
  input: ComplexityClassifierInput,
  options?: QueryComplexityClassifierConfig,
): Promise<{ complexity: QueryComplexity; reason: string }> {
  const prompt = buildComplexityClassifierPrompt(input);

  // Default 30s; Haiku usually finishes in 1-2s, but non-Haiku light models can need longer.
  const CLASSIFY_TIMEOUT_MS = options?.classifierTimeoutMs ?? 30_000;
  const sdkEnv = createSdkEnv(options?.providerId, options?.providerScope);
  const stream = sdkQuery({
    prompt,
    options: {
      model: options?.lightModel ?? 'claude-haiku-4-5',
      maxTurns: 1,
      settingSources: [],
      tools: [],
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      env: sdkEnv,
      stderr: (data: string) => {
        console.warn(`[ComplexityClassifier] SDK stderr: ${data.trimEnd()}`);
      },
      ...getSdkBinaryOption(sdkEnv),
    },
  });

  let result = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.warn(`[ComplexityClassifier] Classification timed out after ${CLASSIFY_TIMEOUT_MS / 1000}s`);
    try { stream.close(); } catch { /* ignore */ }
  }, CLASSIFY_TIMEOUT_MS);

  try {
    for await (const msg of stream) {
      if (timedOut) break;
      result = successfulSdkResultText(msg) ?? result;
    }
  } finally {
    clearTimeout(timer);
    try { stream.close(); } catch { /* ignore */ }
  }

  if (timedOut) {
    return { complexity: 'full', reason: 'classification timed out (graceful degradation)' };
  }

  const jsonMatch = result.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const complexity: QueryComplexity = parsed.complexity === 'quick' ? 'quick' : 'full';
      return { complexity, reason: parsed.reason || 'AI classification' };
    } catch {
      return { complexity: 'full', reason: 'failed to parse AI JSON response' };
    }
  }

  return { complexity: 'full', reason: 'no JSON in AI response' };
}
