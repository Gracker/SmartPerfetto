// backend/src/services/providerManager/providerStore.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'fs';
import * as path from 'path';
import type { ProviderConfig } from './types';

export class ProviderStore {
  private providers = new Map<string, ProviderConfig>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): void {
    this.providers.clear();
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const arr: ProviderConfig[] = JSON.parse(raw);
      for (const p of arr) this.providers.set(p.id, p);
    } catch (err) {
      console.warn('[ProviderStore] Failed to load providers.json, starting fresh:', (err as Error).message);
    }
  }

  getAll(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  get(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  getActive(): ProviderConfig | undefined {
    for (const p of this.providers.values()) {
      if (p.isActive) return p;
    }
    return undefined;
  }

  set(provider: ProviderConfig): void {
    this.providers.set(provider.id, provider);
    this.persist();
  }

  delete(id: string): boolean {
    const deleted = this.providers.delete(id);
    if (deleted) this.persist();
    return deleted;
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.getAll(), null, 2));
    fs.renameSync(tmp, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* Windows */ }
  }
}
