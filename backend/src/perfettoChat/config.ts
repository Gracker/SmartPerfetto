// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHmac, randomBytes} from 'node:crypto';
import {isKeylessLocalMode, resolveServerConfig} from '../config';

let revisionSecret: Buffer | undefined;

export function chatProfileRevision(profile: ChatProfile): string {
  revisionSecret ??= randomBytes(32);
  return createHmac('sha256', revisionSecret).update(JSON.stringify([
    profile.endpoint.href, profile.model, profile.apiKey,
  ])).digest('base64url');
}

export interface ChatProfile {
  endpoint: URL;
  model: string;
  apiKey: string;
}

export function chatConfigured(): boolean {
  return process.env.SMARTPERFETTO_PERFETTO_CHAT === '1'
    && process.env.SMARTPERFETTO_DISTRIBUTION === 'source'
    && process.platform === 'darwin'
    && process.arch === 'arm64'
    && resolveServerConfig().bindHost === '127.0.0.1'
    && isKeylessLocalMode();
}

export function loadChatProfile(): ChatProfile | undefined {
  if (!chatConfigured()) return undefined;
  const {SMARTPERFETTO_PERFETTO_CHAT_BASE_URL: url,
    SMARTPERFETTO_PERFETTO_CHAT_MODEL: model,
    SMARTPERFETTO_PERFETTO_CHAT_API_KEY: apiKey} = process.env;
  if (!url || !model?.trim() || !apiKey?.trim()) return undefined;
  try {
    const endpoint = new URL(url);
    const secure = endpoint.protocol === 'https:';
    const local = endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1';
    if ((!secure && !local) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash) return undefined;
    return {endpoint, model: model.trim(), apiKey: apiKey.trim()};
  } catch {
    return undefined;
  }
}
