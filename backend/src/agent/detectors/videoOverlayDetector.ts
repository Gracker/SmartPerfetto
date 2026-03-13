/**
 * Video Overlay (HWC) Architecture Detector
 *
 * 检测视频 Overlay 渲染路径，识别硬件合成器直接渲染视频层的场景
 * 视频 Overlay 绕过 GPU 合成，直接通过 HWC 硬件合成器呈现
 */

import { BaseDetector } from './baseDetector';
import {
  DetectorContext,
  DetectorResult,
  DetectionEvidence,
} from './types';

export class VideoOverlayDetector extends BaseDetector {
  readonly name = 'VideoOverlayDetector';
  readonly targetType = 'VIDEO_OVERLAY' as const;

  async detect(context: DetectorContext): Promise<DetectorResult> {
    const evidence: DetectionEvidence[] = [];

    // 1. 检测 MediaCodec 解码线程
    const mediaCodec = await this.hasThread(context, '%MediaCodec%');
    if (mediaCodec.exists) {
      evidence.push(
        this.createEvidence('thread', mediaCodec.matches[0], 0.15, 'MediaCodec thread detected')
      );
    }

    // 2. 检测 MediaCodec slices (高频解码)
    const codecSlice = await this.hasSlice(context, '%MediaCodec%');
    if (codecSlice.exists && codecSlice.count > 30) {
      evidence.push(
        this.createEvidence(
          'slice',
          `MediaCodec (${codecSlice.count} occurrences)`,
          0.2,
          'High-frequency MediaCodec operations — video decoding'
        )
      );
    }

    // 3. 检测 HWC Overlay 信号
    const hwcSlice = await this.hasSlice(context, '%HWC%');
    if (hwcSlice.exists) {
      evidence.push(
        this.createEvidence(
          'slice',
          `HWC (${hwcSlice.count})`,
          0.15,
          'Hardware Composer slices detected'
        )
      );
    }

    // 4. 检测视频播放相关进程
    const videoProcess = await this.hasSlice(context, '%video%');
    if (videoProcess.exists && videoProcess.count > 20) {
      evidence.push(
        this.createEvidence(
          'slice',
          `video (${videoProcess.count})`,
          0.1,
          'Video-related slices detected'
        )
      );
    }

    // 5. 检测 SurfaceView + MediaCodec 组合 (视频播放典型模式)
    const surfaceView = await this.hasSlice(context, '%SurfaceView%');
    if (surfaceView.exists && mediaCodec.exists) {
      evidence.push(
        this.createEvidence(
          'slice',
          'SurfaceView + MediaCodec',
          0.15,
          'SurfaceView + MediaCodec combination — video playback pattern'
        )
      );
    }

    // 6. 检测 ExoPlayer/MediaPlayer
    const exoPlayer = await this.hasSlice(context, '%ExoPlayer%');
    if (exoPlayer.exists) {
      evidence.push(
        this.createEvidence(
          'slice',
          `ExoPlayer (${exoPlayer.count})`,
          0.1,
          'ExoPlayer detected — media playback'
        )
      );
    }

    const confidence = this.calculateConfidence(evidence);

    if (confidence < 0.3) {
      return this.createEmptyResult();
    }

    return {
      type: 'VIDEO_OVERLAY',
      confidence,
      evidence,
      metadata: {
        video: {
          hasMediaCodec: mediaCodec.exists,
          hasHwcOverlay: hwcSlice.exists,
          hasSurfaceView: surfaceView.exists,
        },
      },
    };
  }
}
