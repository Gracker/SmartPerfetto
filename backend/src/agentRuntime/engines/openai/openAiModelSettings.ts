// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {ModelSettings} from '@openai/agents';
import type {OpenAITextRequestPurposeOptions} from '../../../services/providerManager/openAiChatCompletionsCompat';

/** HTTP body fields and SDK settings are different contracts. The Runner drops
 * providerData.reasoning_effort before the serializer sees a non-GPT model. */
export function withOpenAITextPurposeOptions(settings: ModelSettings, options: OpenAITextRequestPurposeOptions | undefined): ModelSettings {
  if (!options) return settings;
  const {reasoning_effort, reasoning, ...providerData} = options;
  const effort = reasoning?.effort ?? reasoning_effort;
  return {...settings,
    ...(effort === undefined ? {} : {reasoning: {...settings.reasoning,
      effort: effort as NonNullable<ModelSettings['reasoning']>['effort']}}),
    ...(Object.keys(providerData).length ? {providerData: {...settings.providerData, ...providerData}} : {}),
  };
}
