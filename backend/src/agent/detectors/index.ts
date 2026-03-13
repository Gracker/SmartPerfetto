/**
 * Architecture Detectors Module
 *
 * 导出所有架构检测相关的类型和实现
 */

// 类型导出
export * from './types';

// 基础检测器
export { BaseDetector } from './baseDetector';

// 具体检测器
export { FlutterDetector } from './flutterDetector';
export { WebViewDetector } from './webviewDetector';
export { ComposeDetector } from './composeDetector';
export { StandardDetector } from './standardDetector';
export { GameDetector } from './gameDetector';
export { CameraDetector } from './cameraDetector';
export { VideoOverlayDetector } from './videoOverlayDetector';

// 主检测器
export {
  ArchitectureDetector,
  createArchitectureDetector,
} from './architectureDetector';
