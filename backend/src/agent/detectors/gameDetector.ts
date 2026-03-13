/**
 * Game Engine Architecture Detector
 *
 * 检测游戏引擎渲染架构，识别 Unity/Unreal/Godot/Cocos 引擎
 * 游戏引擎不使用标准 HWUI/RenderThread 流程，需要独立检测
 */

import { BaseDetector } from './baseDetector';
import {
  DetectorContext,
  DetectorResult,
  DetectionEvidence,
} from './types';

export type GameEngineType = 'UNITY' | 'UNREAL' | 'GODOT' | 'COCOS' | 'UNKNOWN';

export class GameDetector extends BaseDetector {
  readonly name = 'GameDetector';
  readonly targetType = 'GAME_ENGINE' as const;

  async detect(context: DetectorContext): Promise<DetectorResult> {
    const evidence: DetectionEvidence[] = [];
    let engineType: GameEngineType = 'UNKNOWN';

    // 1. 检测 Unity 引擎
    const unityMain = await this.hasThread(context, '%UnityMain%');
    if (unityMain.exists) {
      engineType = 'UNITY';
      evidence.push(
        this.createEvidence('thread', unityMain.matches[0], 0.35, 'Unity main thread detected')
      );
    }

    const unityGfx = await this.hasThread(context, '%UnityGfx%');
    if (unityGfx.exists) {
      if (engineType !== 'UNITY') engineType = 'UNITY';
      evidence.push(
        this.createEvidence('thread', unityGfx.matches[0], 0.2, 'Unity graphics thread detected')
      );
    }

    const unitySlice = await this.hasSlice(context, '%PlayerLoop%');
    if (unitySlice.exists) {
      if (engineType !== 'UNITY') engineType = 'UNITY';
      evidence.push(
        this.createEvidence(
          'slice',
          `PlayerLoop (${unitySlice.count} occurrences)`,
          0.15,
          'Unity PlayerLoop slice detected'
        )
      );
    }

    // 2. 检测 Unreal 引擎
    const unrealGame = await this.hasThread(context, '%GameThread%');
    if (unrealGame.exists && engineType === 'UNKNOWN') {
      // GameThread 也可能出现在非 Unreal 场景，需要额外验证
      const unrealRhi = await this.hasThread(context, '%RHIThread%');
      if (unrealRhi.exists) {
        engineType = 'UNREAL';
        evidence.push(
          this.createEvidence('thread', unrealGame.matches[0], 0.3, 'Unreal GameThread detected')
        );
        evidence.push(
          this.createEvidence('thread', unrealRhi.matches[0], 0.25, 'Unreal RHI thread detected')
        );
      }
    }

    const unrealSlice = await this.hasSlice(context, '%FrameGameThread%');
    if (unrealSlice.exists) {
      if (engineType !== 'UNREAL') engineType = 'UNREAL';
      evidence.push(
        this.createEvidence(
          'slice',
          `FrameGameThread (${unrealSlice.count})`,
          0.15,
          'Unreal frame marker detected'
        )
      );
    }

    // 3. 检测 Godot 引擎
    const godotMain = await this.hasThread(context, '%GodotMain%');
    if (godotMain.exists) {
      engineType = 'GODOT';
      evidence.push(
        this.createEvidence('thread', godotMain.matches[0], 0.35, 'Godot main thread detected')
      );
    }

    const godotSlice = await this.hasSlice(context, '%godot%');
    if (godotSlice.exists && engineType === 'UNKNOWN') {
      engineType = 'GODOT';
      evidence.push(
        this.createEvidence(
          'slice',
          `godot (${godotSlice.count})`,
          0.2,
          'Godot slices detected'
        )
      );
    }

    // 4. 检测 Cocos 引擎
    const cocosThread = await this.hasThread(context, '%CocosThread%');
    if (cocosThread.exists) {
      engineType = 'COCOS';
      evidence.push(
        this.createEvidence('thread', cocosThread.matches[0], 0.3, 'Cocos thread detected')
      );
    }

    const cocosSlice = await this.hasSlice(context, '%cocos%');
    if (cocosSlice.exists && engineType === 'UNKNOWN') {
      engineType = 'COCOS';
      evidence.push(
        this.createEvidence(
          'slice',
          `cocos (${cocosSlice.count})`,
          0.2,
          'Cocos slices detected'
        )
      );
    }

    // 5. 通用游戏引擎信号 — OpenGL/Vulkan 高频 swap
    if (evidence.length === 0) {
      const vulkanSwap = await this.hasSlice(context, '%vkQueuePresentKHR%');
      if (vulkanSwap.exists && vulkanSwap.count > 100) {
        // 高频 Vulkan present + 无 RenderThread 是游戏信号
        const noRenderThread = await this.hasThread(context, 'RenderThread');
        if (!noRenderThread.exists) {
          evidence.push(
            this.createEvidence(
              'slice',
              `vkQueuePresentKHR (${vulkanSwap.count})`,
              0.2,
              'High-frequency Vulkan present without RenderThread — possible game'
            )
          );
        }
      }
    }

    const confidence = this.calculateConfidence(evidence);

    if (confidence < 0.3) {
      return this.createEmptyResult();
    }

    return {
      type: 'GAME_ENGINE',
      confidence,
      evidence,
      metadata: {
        gameEngine: {
          type: engineType,
        },
      },
    };
  }
}
