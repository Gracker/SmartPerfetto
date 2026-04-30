// backend/src/routes/providerRoutes.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import express from 'express';
import { getProviderService, officialTemplates } from '../services/providerManager';
import type { ProviderCreateInput, ProviderUpdateInput } from '../services/providerManager';
import { testProviderConnection } from '../services/providerManager/connectionTester';
import { authenticate } from '../middleware/auth';

const router = express.Router();

router.use(authenticate);

router.get('/', (req, res) => {
  const svc = getProviderService();
  res.json({ success: true, providers: svc.list() });
});

router.get('/templates', (_req, res) => {
  res.json({ success: true, templates: officialTemplates });
});

router.get('/effective', (_req, res) => {
  const svc = getProviderService();
  const env = svc.getEffectiveEnv();
  if (env) {
    const active = svc.list().find(p => p.isActive);
    res.json({ success: true, source: 'provider-manager', provider: active, env: maskEnvKeys(env) });
  } else {
    res.json({ success: true, source: 'env-fallback', provider: null });
  }
});

router.get('/:id', (req, res) => {
  const svc = getProviderService();
  const provider = svc.get(req.params.id);
  if (!provider) return res.status(404).json({ success: false, error: 'Provider not found' });
  res.json({ success: true, provider });
});

router.post('/', (req, res) => {
  try {
    const svc = getProviderService();
    const input: ProviderCreateInput = req.body;
    const provider = svc.create(input);
    res.status(201).json({ success: true, provider: svc.get(provider.id) });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const svc = getProviderService();
    const input: ProviderUpdateInput = req.body;
    svc.update(req.params.id, input);
    res.json({ success: true, provider: svc.get(req.params.id) });
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const svc = getProviderService();
    svc.delete(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

router.post('/deactivate', (_req, res) => {
  const svc = getProviderService();
  svc.deactivateAll();
  res.json({ success: true });
});

router.post('/:id/activate', (req, res) => {
  try {
    const svc = getProviderService();
    svc.activate(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ success: false, error: err.message });
  }
});

router.post('/:id/test', async (req, res) => {
  const svc = getProviderService();
  const provider = svc.getRaw(req.params.id);
  if (!provider) return res.status(404).json({ success: false, error: 'Provider not found' });

  const result = await testProviderConnection(provider);
  res.json({ success: true, result });
});

function maskEnvKeys(env: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  const sensitivePatterns = ['KEY', 'TOKEN', 'SECRET'];
  for (const [k, v] of Object.entries(env)) {
    if (sensitivePatterns.some(p => k.includes(p)) && v.length > 8) {
      masked[k] = `****${v.slice(-4)}`;
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

export default router;
