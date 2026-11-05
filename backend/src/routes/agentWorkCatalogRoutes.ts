// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)

import type express from 'express';
import {requireRequestContext} from '../middleware/auth';
import {sendRouteError} from '../middleware/routeFailure';
import {hasRbacPermission, sendForbidden} from '../services/rbac';
import {ownerFieldsFromContext} from '../services/resourceOwnership';
import {openEnterpriseDb} from '../services/enterpriseDb';
import {AssistantWorkCatalogService, AssistantWorkCatalogRequestError, parseAssistantWorkCatalogQuery,
  type AssistantWorkLiveReader} from '../services/assistantWorkCatalogService';

export function registerAgentWorkCatalogRoutes(router: express.Router, readLiveWork: AssistantWorkLiveReader): void {
  router.get('/work', (req, res) => {
    try {
      const context = requireRequestContext(req);
      if (!hasRbacPermission(context, 'agent:run')) {
        sendForbidden(res, 'Work overview access requires agent:run permission'); return;
      }
      const query = parseAssistantWorkCatalogQuery(req.query);
      const db = openEnterpriseDb();
      try { res.json(new AssistantWorkCatalogService(db, {readLiveWork,
        canReadSnapshots: hasRbacPermission(context, 'analysis_result:read'),
        canReadReports: hasRbacPermission(context, 'report:read')}).list(ownerFieldsFromContext(context), query)); }
      finally { db.close(); }
    } catch (error: unknown) {
      sendRouteError(res, error, {code: 'work_catalog_failed', error: 'Could not read work overview',
        logLabel: '[AgentWorkCatalog] Read failed'}, [AssistantWorkCatalogRequestError]);
    }
  });
}
