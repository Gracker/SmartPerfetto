/**
 * Architecture Detector Types
 *
 * 定义渲染架构检测相关的类型
 */

/**
 * 渲染架构类型
 */
export type RenderingArchitectureType =
  | 'STANDARD'      // 标准 Android View + RenderThread
  | 'FLUTTER'       // Flutter 应用
  | 'WEBVIEW'       // WebView/Chrome/Chromium
  | 'COMPOSE'       // Jetpack Compose
  | 'SURFACEVIEW'   // SurfaceView 独立渲染
  | 'GLSURFACEVIEW' // GLSurfaceView (OpenGL)
  | 'SOFTWARE'      // 软件渲染 (无 RenderThread)
  | 'MIXED'         // 混合渲染 (如 SurfaceView + RecyclerView)
  | 'GAME_ENGINE'   // 游戏引擎 (Unity/Unreal/Godot/Cocos)
  | 'CAMERA'        // 相机管线 (HAL3/Camera2)
  | 'VIDEO_OVERLAY'  // 视频 Overlay (HWC 硬件合成)
  | 'UNKNOWN';      // 未知架构

/**
 * Flutter 渲染引擎类型
 */
export type FlutterEngine = 'SKIA' | 'IMPELLER' | 'UNKNOWN';

/**
 * WebView Surface 类型
 */
export type WebViewSurfaceType =
  | 'SURFACEVIEW'     // SurfaceView 模式
  | 'TEXTUREVIEW'     // TextureView 模式
  | 'SURFACECONTROL'  // SurfaceControl 模式 (Android 10+)
  | 'UNKNOWN';

/**
 * WebView 内核类型
 */
export type WebViewEngine =
  | 'CHROMIUM'        // 标准 Chromium
  | 'X5'              // 腾讯 X5 内核
  | 'UC'              // UC 内核
  | 'CUSTOM'          // 其他定制内核
  | 'UNKNOWN';

/**
 * 检测证据
 */
export interface DetectionEvidence {
  /** 证据类型 */
  type: 'thread' | 'process' | 'slice' | 'counter';
  /** 匹配的值 */
  value: string;
  /** 证据来源的 SQL 查询 */
  source?: string;
  /** 该证据的权重 (0-1) */
  weight: number;
}

/**
 * 架构检测结果
 */
export interface ArchitectureInfo {
  /** 检测到的渲染架构类型 */
  type: RenderingArchitectureType;

  /** 置信度 (0-1) */
  confidence: number;

  /** 检测依据列表 */
  evidence: DetectionEvidence[];

  /** Flutter 特定信息 */
  flutter?: {
    /** 渲染引擎 */
    engine: FlutterEngine;
    /** 预估版本范围 */
    versionHint?: string;
    /** 是否使用新的线程模型 (3.29+) */
    newThreadModel?: boolean;
  };

  /** WebView 特定信息 */
  webview?: {
    /** 内核类型 */
    engine: WebViewEngine;
    /** Surface 类型 */
    surfaceType: WebViewSurfaceType;
    /** 是否是多进程架构 */
    multiProcess?: boolean;
  };

  /** Compose 特定信息 */
  compose?: {
    /** 是否检测到 Recomposition */
    hasRecomposition: boolean;
    /** 是否检测到 Lazy 列表 (LazyColumn/LazyRow/LazyVerticalGrid) */
    hasLazyLists: boolean;
    /** 是否是混合架构 (Compose 嵌入传统 View 体系) */
    isHybridView: boolean;
    /** 检测到的 Compose 特性列表 */
    features: string[];
  };

  /** 其他架构的附加信息 */
  additionalInfo?: Record<string, any>;
}

/**
 * 单个检测器的结果
 */
export interface DetectorResult {
  /** 检测到的架构类型 */
  type: RenderingArchitectureType;
  /** 置信度 */
  confidence: number;
  /** 检测证据 */
  evidence: DetectionEvidence[];
  /** 附加信息 */
  metadata?: Record<string, any>;
}

/**
 * 检测上下文
 */
export interface DetectorContext {
  /** Trace ID */
  traceId: string;
  /** TraceProcessorService 实例 */
  traceProcessorService: any;
  /** 可选的包名过滤 */
  packageName?: string;
}

/**
 * 基础检测器接口
 */
export interface IArchitectureDetector {
  /** 检测器名称 */
  readonly name: string;

  /** 执行检测 */
  detect(context: DetectorContext): Promise<DetectorResult>;
}
