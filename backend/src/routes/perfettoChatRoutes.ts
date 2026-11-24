// SPDX-License-Identifier: AGPL-3.0-or-later

import {Router, type Response} from 'express';
import {requireRequestContext} from '../middleware/auth';
import {chatConfigured, chatProfileRevision, loadChatProfile} from '../perfettoChat/config';
import {isSkillRunnerAvailable} from '../perfettoChat/runner';
import {loadSkillBundle, loadSkillRuntime, SKILL_COMMIT} from '../perfettoChat/skillBundle';
import {
  beginChatTurn, ChatAdmissionError, closeChatSession, executeChatTurn, findChatSession, openChatSession, stopChatTurn,
} from '../perfettoChat/sessions';
import {chatAssetUpload} from '../perfettoChat/assetUpload';
import {parseSelection} from '../perfettoChat/trace';

const router = Router();
const ID = /^[\w-]{1,100}$/;
const sendError = (res: Response, status: number, code: string) => res.status(status).json({code});

router.get('/capabilities', async (req, res) => {
  const enabled = chatConfigured() && requireRequestContext(req).authType === 'dev';
  const profile = enabled ? loadChatProfile() : undefined;
  const bundle = profile ? await loadSkillBundle() : undefined;
  const skills = bundle && isSkillRunnerAvailable() ? await loadSkillRuntime(bundle) : undefined;
  res.set('Cache-Control', 'no-store').json({
    version: 1, enabled, chat: !!profile, trace: !!skills, skills: bundle ? SKILL_COMMIT : undefined,
    ...(profile ? {profile: {id: 'local', model: profile.model, origin: profile.endpoint.origin, revision: chatProfileRevision(profile)}} : {}),
    ...(!enabled ? {code: 'FEATURE_UNAVAILABLE'} : !profile ? {code: 'MODEL_NOT_CONFIGURED'}
      : !skills ? {code: 'SKILL_RUNTIME_UNAVAILABLE'} : {}),
  });
});

router.use((req, res, next) => {
  if (!chatConfigured() || requireRequestContext(req).authType !== 'dev') {
    return sendError(res, 404, 'FEATURE_UNAVAILABLE');
  }
  if (!loadChatProfile()) return sendError(res, 503, 'MODEL_NOT_CONFIGURED');
  res.set('Cache-Control', 'no-store');
  next();
});

router.post('/trace-assets', ...chatAssetUpload);

router.post('/sessions', async (req, res) => {
  const context = requireRequestContext(req);
  const profile = loadChatProfile()!;
  const {traceId, consentOrigin, profileId, profileRevision} = req.body ?? {};
  if (profileRevision !== chatProfileRevision(profile)) {
    return sendError(res, 409, 'SESSION_CONFIGURATION_CHANGED');
  }
  if (profileId !== 'local' ||
      (traceId !== undefined && (typeof traceId !== 'string' || !ID.test(traceId) ||
        consentOrigin !== profile.endpoint.origin))) {
    return sendError(res, 400, 'INVALID_SESSION_REQUEST');
  }
  try {
    if (traceId && (!isSkillRunnerAvailable() || !await loadSkillRuntime(await loadSkillBundle()))) {
      return sendError(res, 503, 'SKILL_RUNTIME_UNAVAILABLE');
    }
    const sessionId = await openChatSession(context, profile, traceId);
    return res.status(201).json({sessionId, version: 1});
  } catch (error) {
    return error instanceof ChatAdmissionError
      ? sendError(res, 429, 'CAPACITY_EXCEEDED')
      : sendError(res, 404, 'TRACE_UNAVAILABLE');
  }
});

router.post('/sessions/:sessionId/turns', async (req, res) => {
  const context = requireRequestContext(req);
  const session = findChatSession(context, req.params.sessionId);
  if (!session) return sendError(res, 404, 'SESSION_UNAVAILABLE');
  const {clientTurnId, text, selection: input} = req.body ?? {};
  if (typeof clientTurnId !== 'string' || !ID.test(clientTurnId) ||
      typeof text !== 'string' || !text.trim() || text.length > 4000) {
    return sendError(res, 400, 'INVALID_TURN_REQUEST');
  }
  let selection;
  try { selection = parseSelection(input, session.asset?.id); }
  catch { return sendError(res, 400, 'INVALID_SELECTION'); }
  const profile = loadChatProfile()!;
  let turn;
  try { turn = beginChatTurn(session, clientTurnId, text, selection); }
  catch (error) {
    return error instanceof ChatAdmissionError
      ? sendError(res, 409, error.code)
      : sendError(res, 500, 'TURN_ADMISSION_FAILED');
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    'X-Accel-Buffering': 'no',
  });
  let seq = 0;
  const cancel = () => stopChatTurn(session, clientTurnId);
  res.on('close', cancel);
  try {
    try { res.flushHeaders(); }
    catch { cancel(); }
    await executeChatTurn(context, session, turn, profile, text, selection, event => {
      if (res.destroyed || res.writableEnded) return;
      const payload = {version: 1, sessionId: session.id, clientTurnId, seq: ++seq, ...event};
      if (res.writableLength > 256_000) {
        res.destroy();
        return;
      }
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });
  } finally {
    res.off('close', cancel);
    if (!res.destroyed) res.end();
  }
});

router.post('/sessions/:sessionId/turns/:turnId/cancel', (req, res) => {
  const session = findChatSession(requireRequestContext(req), req.params.sessionId);
  if (!session) return sendError(res, 404, 'SESSION_UNAVAILABLE');
  stopChatTurn(session, req.params.turnId);
  return res.sendStatus(204);
});

router.delete('/sessions/:sessionId', (req, res) => {
  const session = findChatSession(requireRequestContext(req), req.params.sessionId);
  if (session) closeChatSession(session);
  return res.sendStatus(204);
});

export default router;
