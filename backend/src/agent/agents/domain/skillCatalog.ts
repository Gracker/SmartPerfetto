import type { SkillDefinitionForAgent } from '../base/baseAgent';

export const FRAME_SKILLS: SkillDefinitionForAgent[] = [
  { skillId: 'jank_frame_detail', toolName: 'get_frame_detail', category: 'frame', descriptionHint: '用于单帧深度诊断（L4）' },
  { skillId: 'scrolling_analysis', toolName: 'analyze_scrolling', category: 'frame', descriptionHint: '用于滑动会话概览与掉帧列表' },
  { skillId: 'consumer_jank_detection', toolName: 'detect_consumer_jank', category: 'frame', descriptionHint: '用于识别 SF/GPU 消费端掉帧' },
  { skillId: 'sf_frame_consumption', toolName: 'analyze_sf_frames', category: 'frame', descriptionHint: '用于分析 SurfaceFlinger 帧消费时序' },
  { skillId: 'app_frame_production', toolName: 'analyze_app_frames', category: 'frame', descriptionHint: '用于分析应用帧生产节奏与 VSYNC 对齐' },
  { skillId: 'present_fence_timing', toolName: 'analyze_present_fence', category: 'frame', descriptionHint: '用于分析显示/围栏等待时序' },
  { skillId: 'gpu_analysis', toolName: 'analyze_gpu', category: 'frame', descriptionHint: '用于 GPU 频率、负载与渲染耗时概览' },
  { skillId: 'surfaceflinger_analysis', toolName: 'analyze_surfaceflinger', category: 'frame', descriptionHint: '用于系统合成链路瓶颈分析' },
  { skillId: 'game_fps_analysis', toolName: 'analyze_game_fps', category: 'frame', descriptionHint: '用于游戏目标 FPS 与抖动分析' },
];

export const CPU_SKILLS: SkillDefinitionForAgent[] = [
  { skillId: 'cpu_analysis', toolName: 'analyze_cpu_overview', category: 'cpu', descriptionHint: '用于全局 CPU 负载概览' },
  { skillId: 'scheduling_analysis', toolName: 'analyze_scheduling', category: 'cpu', descriptionHint: '用于调度延迟与 Runnable 等待分析' },
  { skillId: 'cpu_freq_timeline', toolName: 'get_cpu_freq_timeline', category: 'cpu', descriptionHint: '用于频率变化与降频事件分析' },
  { skillId: 'cpu_load_in_range', toolName: 'analyze_cpu_load', category: 'cpu', descriptionHint: '用于区间 CPU 负载分析' },
  { skillId: 'cpu_slice_analysis', toolName: 'analyze_cpu_slices', category: 'cpu', descriptionHint: '用于 CPU 时间片热点分析' },
  { skillId: 'cpu_profiling', toolName: 'profile_cpu_hotspots', category: 'cpu', descriptionHint: '用于函数级 CPU 热点分析（需 perf 数据）' },
  { skillId: 'callstack_analysis', toolName: 'analyze_callstacks', category: 'cpu', descriptionHint: '用于采样调用栈聚合分析' },
  { skillId: 'cpu_cluster_load_in_range', toolName: 'analyze_cpu_cluster_load', category: 'cpu', descriptionHint: '用于大小核负载分布分析' },
  { skillId: 'cpu_throttling_in_range', toolName: 'analyze_cpu_throttling', category: 'cpu', descriptionHint: '用于区间限频检测' },
  { skillId: 'task_migration_in_range', toolName: 'analyze_task_migration', category: 'cpu', descriptionHint: '用于区间线程迁移分析' },
];

export const MEMORY_SKILLS: SkillDefinitionForAgent[] = [
  { skillId: 'memory_analysis', toolName: 'analyze_memory_overview', category: 'memory', descriptionHint: '用于内存全景与进程占用分析' },
  { skillId: 'gc_analysis', toolName: 'analyze_gc', category: 'memory', descriptionHint: '用于 GC 事件与耗时分析' },
  { skillId: 'lmk_analysis', toolName: 'analyze_lmk', category: 'memory', descriptionHint: '用于 LMK 杀进程与内存压力分析' },
  { skillId: 'dmabuf_analysis', toolName: 'analyze_dmabuf', category: 'memory', descriptionHint: '用于 DMA-BUF/图形内存分析' },
  { skillId: 'memory_pressure_in_range', toolName: 'analyze_memory_pressure', category: 'memory', descriptionHint: '用于区间内存压力评估' },
  { skillId: 'gc_events_in_range', toolName: 'analyze_gc_events', category: 'memory', descriptionHint: '用于区间 GC 事件分类分析' },
];

export const BINDER_SKILLS: SkillDefinitionForAgent[] = [
  { skillId: 'binder_analysis', toolName: 'analyze_binder_overview', category: 'binder', descriptionHint: '用于全局 Binder 调用概览' },
  { skillId: 'binder_detail', toolName: 'get_binder_detail', category: 'binder', descriptionHint: '用于单次 Binder 事务深度分析' },
  { skillId: 'binder_in_range', toolName: 'analyze_binder_range', category: 'binder', descriptionHint: '用于区间 Binder 调用分析' },
  { skillId: 'lock_contention_analysis', toolName: 'analyze_lock_contention', category: 'binder', descriptionHint: '用于锁竞争热点分析' },
  { skillId: 'lock_contention_in_range', toolName: 'analyze_lock_range', category: 'binder', descriptionHint: '用于区间锁竞争分析' },
];

export const STARTUP_SKILLS: SkillDefinitionForAgent[] = [
  { skillId: 'startup_analysis', toolName: 'analyze_startup', category: 'startup', descriptionHint: '用于启动全景与慢启动识别' },
  { skillId: 'startup_detail', toolName: 'get_startup_detail', category: 'startup', descriptionHint: '用于单次启动阶段耗时分解' },
];

export const INTERACTION_SKILLS: SkillDefinitionForAgent[] = [
  { skillId: 'click_response_analysis', toolName: 'analyze_click_response', category: 'interaction', descriptionHint: '用于点击响应时延分析' },
  { skillId: 'click_response_detail', toolName: 'get_click_detail', category: 'interaction', descriptionHint: '用于单次点击响应分解分析' },
  { skillId: 'navigation_analysis', toolName: 'analyze_navigation', category: 'interaction', descriptionHint: '用于页面切换与导航耗时分析' },
];

export const ANR_SKILLS: SkillDefinitionForAgent[] = [
  { skillId: 'anr_analysis', toolName: 'analyze_anr', category: 'system', descriptionHint: '用于 ANR 概览与阻塞分类' },
  { skillId: 'anr_detail', toolName: 'get_anr_detail', category: 'system', descriptionHint: '用于单次 ANR 事件深度分析' },
];

export const SYSTEM_SKILLS: SkillDefinitionForAgent[] = [
  { skillId: 'thermal_throttling', toolName: 'analyze_thermal', category: 'system', descriptionHint: '用于热节流与降频分析' },
  { skillId: 'io_pressure', toolName: 'analyze_io_pressure', category: 'system', descriptionHint: '用于 IO 压力与阻塞分析' },
  { skillId: 'suspend_wakeup_analysis', toolName: 'analyze_suspend_wakeup', category: 'system', descriptionHint: '用于休眠唤醒行为分析' },
  { skillId: 'block_io_analysis', toolName: 'analyze_block_io', category: 'system', descriptionHint: '用于块设备 IO 读写延迟分析' },
  { skillId: 'irq_analysis', toolName: 'analyze_irq', category: 'system', descriptionHint: '用于中断负载与时延分析' },
  { skillId: 'network_analysis', toolName: 'analyze_network', category: 'system', descriptionHint: '用于网络请求/链路时延分析' },
];
