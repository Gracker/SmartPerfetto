// backend/src/routes/providerRoutes.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import express from 'express';
import {
  getProviderModelCatalogService,
  getProviderService,
  isAgentRuntimeKind,
  mergeModelOptions,
  officialTemplates,
} from '../services/providerManager';
import type { AgentRuntimeKind, ProviderCreateInput, ProviderScope, ProviderUpdateInput } from '../services/providerManager';
import { testProviderConnection } from '../services/providerManager/connectionTester';
import { authenticate, requireRequestContext, type RequestContext } from '../middleware/auth';
import { recordEnterpriseAuditEventForContext } from '../services/enterpriseAuditService';
import { hasRbacPermission, sendForbidden } from '../services/rbac';
import { requireAiEnabledForHttp } from './aiCapabilityPolicyHttp';
import {
  PROVIDER_STORE_UNREADABLE_CODE,
  ProviderStoreUnreadableError,
} from '../services/providerManager/providerStore';

const router = express.Router();

type WorkspaceScopedRequest = express.Request & {
  workspaceRouteContext?: {
    workspaceId: string;
  };
};

router.use(authenticate);
router.use((req, res, next) => {
  const context = requireRequestContext(req);
  if (!hasRbacPermission(context, 'provider:manage_workspace')) {
    sendForbidden(res, 'Provider management requires provider:manage_workspace permission');
    return;
  }
  next();
});

function providerScopeForRequest(req: express.Request): ProviderScope {
  const context = requireRequestContext(req);
  const workspaceRouteContext = (req as WorkspaceScopedRequest).workspaceRouteContext;
  return {
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    ...(workspaceRouteContext ? {} : { userId: context.userId }),
  };
}

/** The stored-profile state, so a client can tell an empty store from an unreadable one. */
function providerStoreState(): {status: 'ok'} | {status: 'unreadable'; code: string} {
  return getProviderService().getStoreStatus() === 'unreadable'
    ? {status: 'unreadable', code: PROVIDER_STORE_UNREADABLE_CODE}
    : {status: 'ok'};
}

function sendProviderMutationError(res: express.Response, err: any): void {
  if (err instanceof ProviderStoreUnreadableError) {
    res.status(409).json({success: false, code: err.code, error: err.message});
    return;
  }
  res.status(err.message.includes('not found') ? 404 : 400).json({success: false, error: err.message});
}

function recordProviderAudit(
  context: RequestContext,
  action:
    | 'provider.read'
    | 'provider.created'
    | 'provider.updated'
    | 'provider.deleted'
    | 'provider.activated'
    | 'provider.deactivated'
    | 'provider.runtime_switched'
    | 'provider.secret_rotated'
    | 'provider.connection_tested',
  providerId: string | undefined,
  metadata: Record<string, unknown> = {},
): void {
  recordEnterpriseAuditEventForContext(context, {
    action,
    resourceType: 'provider',
    resourceId: providerId,
    metadata,
  });
}

router.get('/', (req, res) => {
  const svc = getProviderService();
  res.json({
    success: true,
    providers: svc.list(providerScopeForRequest(req)),
    store: providerStoreState(),
  });
});

router.get('/templates', (_req, res) => {
  res.json({ success: true, templates: officialTemplates });
});

router.get('/:id/models', async (req, res) => {
  const svc = getProviderService();
  const scope = providerScopeForRequest(req);
  const provider = svc.getRaw(req.params.id, scope);
  if (!provider) {
    return res.status(404).json({success: false, error: 'Provider not found'});
  }
  const template = officialTemplates.find(item => item.type === provider.type);
  if (!template) {
    return res.json({success: true, providerId: provider.id, models: []});
  }

  let catalog;
  try {
    catalog = await getProviderModelCatalogService().discover(
      provider,
      template,
      scope,
    );
  } catch {
    // Live discovery is only a convenience. Keep this read surface usable
    // when a provider omits /models or the endpoint is temporarily unavailable.
  }
  res.json({
    success: true,
    providerId: provider.id,
    models: mergeModelOptions(
      template.availableModels,
      catalog?.models ?? [],
    ),
    source: catalog ? 'curated+live' : 'curated',
    ...(catalog
      ? {fetchedAt: catalog.fetchedAt, cached: catalog.cached}
      : {}),
  });
});

router.get('/effective', (req, res) => {
  const svc = getProviderService();
  const scope = providerScopeForRequest(req);
  const env = svc.getEffectiveEnv(scope);
  const store = providerStoreState();
  if (env) {
    const active = svc.list(scope).find(p => p.isActive);
    res.json({ success: true, source: 'provider-manager', provider: active, env: maskEnvKeys(env), store });
  } else {
    res.json({ success: true, source: 'env-fallback', provider: null, store });
  }
});

router.get('/:id', (req, res) => {
  const svc = getProviderService();
  const context = requireRequestContext(req);
  const provider = svc.get(req.params.id, providerScopeForRequest(req));
  if (!provider) return res.status(404).json({ success: false, error: 'Provider not found' });
  recordProviderAudit(context, 'provider.read', provider.id, {
    type: provider.type,
    active: provider.isActive,
  });
  res.json({ success: true, provider });
});

router.post('/', (req, res) => {
  try {
    const svc = getProviderService();
    const input: ProviderCreateInput = req.body;
    const context = requireRequestContext(req);
    const scope = providerScopeForRequest(req);
    const provider = svc.create(input, scope);
    recordProviderAudit(context, 'provider.created', provider.id, {
      type: provider.type,
      category: provider.category,
      runtime: provider.connection.agentRuntime,
    });
    res.status(201).json({ success: true, provider: svc.get(provider.id, scope) });
  } catch (err: any) {
    sendProviderMutationError(res, err);
  }
});

router.patch('/:id', (req, res) => {
  try {
    const svc = getProviderService();
    const input: ProviderUpdateInput = req.body;
    const context = requireRequestContext(req);
    const scope = providerScopeForRequest(req);
    const updated = svc.update(req.params.id, input, scope);
    recordProviderAudit(context, 'provider.updated', updated.id, {
      type: updated.type,
      changedFields: Object.keys(input),
    });
    res.json({ success: true, provider: svc.get(req.params.id, scope) });
  } catch (err: any) {
    sendProviderMutationError(res, err);
  }
});

router.delete('/:id', (req, res) => {
  try {
    const svc = getProviderService();
    const context = requireRequestContext(req);
    const scope = providerScopeForRequest(req);
    const existing = svc.get(req.params.id, scope);
    svc.delete(req.params.id, scope);
    recordProviderAudit(context, 'provider.deleted', req.params.id, {
      type: existing?.type,
    });
    res.json({ success: true });
  } catch (err: any) {
    sendProviderMutationError(res, err);
  }
});

router.post('/deactivate', (req, res) => {
  try {
    const svc = getProviderService();
    const context = requireRequestContext(req);
    const scope = providerScopeForRequest(req);
    const active = svc.list(scope).find(provider => provider.isActive);
    svc.deactivateAll(scope);
    recordProviderAudit(context, 'provider.deactivated', active?.id, {
      type: active?.type,
    });
    res.json({ success: true });
  } catch (err: any) {
    sendProviderMutationError(res, err);
  }
});

router.post('/:id/activate', (req, res) => {
  try {
    const svc = getProviderService();
    const context = requireRequestContext(req);
    const scope = providerScopeForRequest(req);
    svc.activate(req.params.id, scope);
    const provider = svc.get(req.params.id, scope);
    recordProviderAudit(context, 'provider.activated', req.params.id, {
      type: provider?.type,
    });
    res.json({ success: true });
  } catch (err: any) {
    sendProviderMutationError(res, err);
  }
});

router.post('/:id/runtime', (req, res) => {
  try {
    const svc = getProviderService();
    const runtime = req.body?.agentRuntime as AgentRuntimeKind | undefined;
    if (!isAgentRuntimeKind(runtime)) {
      return res.status(400).json({ success: false, error: 'Invalid agentRuntime' });
    }
    const context = requireRequestContext(req);
    const scope = providerScopeForRequest(req);
    const provider = svc.switchAgentRuntime(req.params.id, runtime, scope);
    recordProviderAudit(context, 'provider.runtime_switched', req.params.id, {
      type: provider.type,
      runtime,
    });
    res.json({ success: true, provider: svc.get(req.params.id, scope) });
  } catch (err: any) {
    sendProviderMutationError(res, err);
  }
});

router.post('/:id/rotate-secret', (req, res) => {
  try {
    const svc = getProviderService();
    const context = requireRequestContext(req);
    const scope = providerScopeForRequest(req);
    const secretVersion = svc.rotateSecret(req.params.id, scope);
    const provider = svc.get(req.params.id, scope);
    recordProviderAudit(context, 'provider.secret_rotated', req.params.id, {
      type: provider?.type,
      secretVersion,
    });
    res.json({ success: true, secretVersion, provider: svc.get(req.params.id, scope) });
  } catch (err: any) {
    sendProviderMutationError(res, err);
  }
});

router.post('/:id/test', async (req, res) => {
  if (!requireAiEnabledForHttp(res, 'provider_test')) {
    return;
  }
  const svc = getProviderService();
  const context = requireRequestContext(req);
  const provider = svc.getRaw(req.params.id, providerScopeForRequest(req));
  if (!provider) return res.status(404).json({ success: false, error: 'Provider not found' });

  const result = await testProviderConnection(provider);
  recordProviderAudit(context, 'provider.connection_tested', req.params.id, {
    type: provider.type,
    success: result.success,
  });
  res.json({ success: true, result });
});

export function maskEnvKeys(env: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (/(?:key|token|secret|password|credential|authorization|cookie|model_json)/i.test(k)) {
      masked[k] = '****';
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

export default router;
