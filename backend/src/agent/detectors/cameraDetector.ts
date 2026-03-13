/**
 * Camera Pipeline Architecture Detector
 *
 * 检测相机管线渲染架构，识别 Camera2/CameraX HAL3 管线
 * 相机应用有独立的帧处理管线 (preview + capture + processing)
 */

import { BaseDetector } from './baseDetector';
import {
  DetectorContext,
  DetectorResult,
  DetectionEvidence,
} from './types';

export class CameraDetector extends BaseDetector {
  readonly name = 'CameraDetector';
  readonly targetType = 'CAMERA' as const;

  async detect(context: DetectorContext): Promise<DetectorResult> {
    const evidence: DetectionEvidence[] = [];

    // 1. 检测 Camera HAL 线程
    const cameraHal = await this.hasThread(context, '%Camera%Hal%');
    if (cameraHal.exists) {
      evidence.push(
        this.createEvidence('thread', cameraHal.matches[0], 0.2, 'Camera HAL thread detected')
      );
    }

    // 2. 检测 Camera 相关进程
    const cameraProcess = await this.hasProcess(context, '%camera%');
    if (cameraProcess.exists) {
      evidence.push(
        this.createEvidence('process', cameraProcess.matches[0], 0.1, 'Camera process detected')
      );
    }

    // 3. 检测 Camera2/CameraX API slices
    const captureSession = await this.hasSlice(context, '%CaptureSession%');
    if (captureSession.exists) {
      evidence.push(
        this.createEvidence(
          'slice',
          `CaptureSession (${captureSession.count})`,
          0.25,
          'Camera2 CaptureSession detected'
        )
      );
    }

    const cameraSlice = await this.hasSlice(context, '%Camera2%');
    if (cameraSlice.exists) {
      evidence.push(
        this.createEvidence(
          'slice',
          `Camera2 (${cameraSlice.count})`,
          0.15,
          'Camera2 API slices detected'
        )
      );
    }

    // 4. 检测 CameraX slices
    const cameraxSlice = await this.hasSlice(context, '%CameraX%');
    if (cameraxSlice.exists) {
      evidence.push(
        this.createEvidence(
          'slice',
          `CameraX (${cameraxSlice.count})`,
          0.15,
          'CameraX slices detected'
        )
      );
    }

    // 5. 检测 ImageReader (camera capture 常用)
    const imageReader = await this.hasSlice(context, '%ImageReader%');
    if (imageReader.exists) {
      evidence.push(
        this.createEvidence(
          'slice',
          `ImageReader (${imageReader.count})`,
          0.1,
          'ImageReader detected (camera capture pipeline)'
        )
      );
    }

    const confidence = this.calculateConfidence(evidence);

    if (confidence < 0.3) {
      return this.createEmptyResult();
    }

    return {
      type: 'CAMERA',
      confidence,
      evidence,
      metadata: {
        camera: {
          hasCamera2: captureSession.exists || cameraSlice.exists,
          hasCameraX: cameraxSlice?.exists || false,
          hasImageReader: imageReader.exists,
        },
      },
    };
  }
}
