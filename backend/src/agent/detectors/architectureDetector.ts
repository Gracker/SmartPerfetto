/**
 * Architecture Detector
 *
 * 主架构检测器，聚合所有特定检测器的结果，返回最可能的渲染架构
 *
 * 检测优先级:
 * 1. Flutter (独特的线程模型，最容易区分)
 * 2. WebView/Chrome (Chromium 特征明显)
 * 3. Compose (有特殊的 Slice 但底层还是 RenderThread)
 * 4. Standard (默认架构，作为兜底)
 */

import {
  ArchitectureInfo,
  DetectorContext,
  DetectorResult,
  RenderingArchitectureType,
} from './types';
import { FlutterDetector } from './flutterDetector';
import { WebViewDetector } from './webviewDetector';
import { ComposeDetector } from './composeDetector';
import { StandardDetector } from './standardDetector';
import { GameDetector } from './gameDetector';
import { CameraDetector } from './cameraDetector';
import { VideoOverlayDetector } from './videoOverlayDetector';
import { BaseDetector } from './baseDetector';

/**
 * 检测器配置
 */
interface ArchitectureDetectorConfig {
  /** 最小置信度阈值，低于此值返回 UNKNOWN */
  minConfidenceThreshold: number;
  /** 是否启用并行检测 */
  parallelDetection: boolean;
  /** 检测超时时间 (ms) */
  timeoutMs: number;
}

const DEFAULT_CONFIG: ArchitectureDetectorConfig = {
  minConfidenceThreshold: 0.3,
  parallelDetection: true,
  timeoutMs: 10000,
};

/**
 * 主架构检测器
 */
export class ArchitectureDetector {
  private config: ArchitectureDetectorConfig;
  private detectors: BaseDetector[];

  constructor(config: Partial<ArchitectureDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // 按优先级注册检测器
    // Flutter/WebView/Compose 优先 (独特线程模型)
    // Game/Camera/Video 次之 (特殊渲染管线)
    // Standard 最低 (默认兜底)
    this.detectors = [
      new FlutterDetector(),
      new WebViewDetector(),
      new ComposeDetector(),
      new GameDetector(),
      new CameraDetector(),
      new VideoOverlayDetector(),
      new StandardDetector(),
    ];
  }

  /**
   * 执行架构检测
   */
  async detect(context: DetectorContext): Promise<ArchitectureInfo> {
    console.log(`[ArchitectureDetector] Starting detection for trace: ${context.traceId}`);
    const startTime = Date.now();

    try {
      // 执行所有检测器
      const results = await this.runDetectors(context);

      // 过滤有效结果
      const validResults = results.filter(
        (r) => r.confidence >= this.config.minConfidenceThreshold
      );

      console.log(`[ArchitectureDetector] Detection results:`,
        results.map(r => `${r.type}: ${(r.confidence * 100).toFixed(1)}%`).join(', ')
      );

      // 如果没有有效结果，返回 STANDARD 作为默认
      if (validResults.length === 0) {
        console.log(`[ArchitectureDetector] No confident detection, defaulting to STANDARD`);
        return this.createDefaultResult();
      }

      // 选择置信度最高的结果
      const bestResult = this.selectBestResult(validResults);

      console.log(`[ArchitectureDetector] Selected architecture: ${bestResult.type} (${(bestResult.confidence * 100).toFixed(1)}%)`);
      console.log(`[ArchitectureDetector] Detection completed in ${Date.now() - startTime}ms`);

      return this.buildArchitectureInfo(bestResult);
    } catch (error: any) {
      console.error(`[ArchitectureDetector] Detection failed:`, error.message);
      return this.createDefaultResult();
    }
  }

  /**
   * 运行所有检测器
   */
  private async runDetectors(context: DetectorContext): Promise<DetectorResult[]> {
    if (this.config.parallelDetection) {
      // 并行执行所有检测器
      const promises = this.detectors.map((detector) =>
        this.runWithTimeout(detector, context)
      );
      return Promise.all(promises);
    } else {
      // 顺序执行 (用于调试)
      const results: DetectorResult[] = [];
      for (const detector of this.detectors) {
        results.push(await this.runWithTimeout(detector, context));
      }
      return results;
    }
  }

  /**
   * 带超时的检测器执行
   */
  private async runWithTimeout(
    detector: BaseDetector,
    context: DetectorContext
  ): Promise<DetectorResult> {
    return new Promise(async (resolve) => {
      const timeout = setTimeout(() => {
        console.warn(`[ArchitectureDetector] ${detector.name} timed out`);
        resolve({ type: 'UNKNOWN', confidence: 0, evidence: [] });
      }, this.config.timeoutMs);

      try {
        const result = await detector.detect(context);
        clearTimeout(timeout);
        resolve(result);
      } catch (error: any) {
        clearTimeout(timeout);
        console.warn(`[ArchitectureDetector] ${detector.name} failed:`, error.message);
        resolve({ type: 'UNKNOWN', confidence: 0, evidence: [] });
      }
    });
  }

  /**
   * 选择最佳结果
   * 如果有多个高置信度结果，按优先级选择
   */
  private selectBestResult(results: DetectorResult[]): DetectorResult {
    // 按置信度排序
    const sorted = [...results].sort((a, b) => b.confidence - a.confidence);

    // 如果最高置信度的结果明显领先，直接选择
    if (sorted.length === 1 || sorted[0].confidence > sorted[1].confidence + 0.1) {
      return sorted[0];
    }

    // 如果多个结果置信度接近，按类型优先级选择
    // Flutter > WebView > Compose > Standard
    const priorityOrder: RenderingArchitectureType[] = [
      'FLUTTER',
      'WEBVIEW',
      'COMPOSE',
      'GAME_ENGINE',
      'CAMERA',
      'VIDEO_OVERLAY',
      'SURFACEVIEW',
      'GLSURFACEVIEW',
      'SOFTWARE',
      'MIXED',
      'STANDARD',
    ];

    const topResults = sorted.filter(
      (r) => r.confidence >= sorted[0].confidence - 0.1
    );

    for (const type of priorityOrder) {
      const match = topResults.find((r) => r.type === type);
      if (match) {
        return match;
      }
    }

    return sorted[0];
  }

  /**
   * 构建最终的架构信息
   */
  private buildArchitectureInfo(result: DetectorResult): ArchitectureInfo {
    const info: ArchitectureInfo = {
      type: result.type,
      confidence: result.confidence,
      evidence: result.evidence,
    };

    // 添加特定架构的元数据
    if (result.metadata) {
      if (result.metadata.flutter) {
        info.flutter = result.metadata.flutter;
      }
      if (result.metadata.webview) {
        info.webview = result.metadata.webview;
      }
      if (result.metadata.compose) {
        info.compose = result.metadata.compose;
      }
      if (result.metadata.additionalInfo) {
        info.additionalInfo = result.metadata.additionalInfo;
      }
    }

    return info;
  }

  /**
   * 创建默认结果 (标准 Android 架构)
   */
  private createDefaultResult(): ArchitectureInfo {
    return {
      type: 'STANDARD',
      confidence: 0.5,
      evidence: [
        {
          type: 'slice',
          value: 'Default assumption',
          weight: 0.5,
          source: 'No specific architecture detected, assuming standard Android',
        },
      ],
    };
  }

  /**
   * 获取所有注册的检测器
   */
  getDetectors(): string[] {
    return this.detectors.map((d) => d.name);
  }
}

/**
 * 创建架构检测器实例
 */
export function createArchitectureDetector(
  config?: Partial<ArchitectureDetectorConfig>
): ArchitectureDetector {
  return new ArchitectureDetector(config);
}
