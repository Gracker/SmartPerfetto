(function () {
  const API_BASE_PATH = '/api/agent/v1';
  const LS_KEY = 'smartperfetto_assistant_web_shell_state_v1';
  const MAX_LOG_LINES = 300;
  const MAX_TIMELINE_LINES = 300;
  const MAX_ENVELOPES = 120;

  const state = {
    sessionId: '',
    runId: '',
    requestId: '',
    runSequence: 0,
    envelopes: [],
    eventAbort: null,
    isStreaming: false,
  };

  const el = {
    backendUrl: document.getElementById('backendUrl'),
    apiKey: document.getElementById('apiKey'),
    traceId: document.getElementById('traceId'),
    query: document.getElementById('query'),
    sessionId: document.getElementById('sessionId'),
    analyzeBtn: document.getElementById('analyzeBtn'),
    streamBtn: document.getElementById('streamBtn'),
    clearBtn: document.getElementById('clearBtn'),
    sseState: document.getElementById('sseState'),
    timelineLog: document.getElementById('timelineLog'),
    eventLog: document.getElementById('eventLog'),
    envelopeRows: document.getElementById('envelopeRows'),
    finalSummary: document.getElementById('finalSummary'),
  };

  function nowText() {
    return new Date().toLocaleTimeString();
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function toArray(value) {
    return Array.isArray(value) ? value : [value];
  }

  function trimTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
  }

  function buildApiUrl(path) {
    const backend = trimTrailingSlash(el.backendUrl.value.trim());
    const p = String(path || '').startsWith('/') ? path : `/${String(path || '')}`;
    return `${backend}${API_BASE_PATH}${p}`;
  }

  function buildHeaders(isJson) {
    const headers = {};
    if (isJson) {
      headers['Content-Type'] = 'application/json';
    }
    const apiKey = el.apiKey.value.trim();
    if (apiKey) {
      headers['x-api-key'] = apiKey;
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
  }

  function setSseState(text, cls) {
    el.sseState.textContent = text;
    el.sseState.className = `badge${cls ? ` ${cls}` : ''}`;
  }

  function appendLog(target, line, maxLines) {
    const prev = target.textContent ? target.textContent.split('\n') : [];
    prev.push(line);
    while (prev.length > maxLines) prev.shift();
    target.textContent = prev.join('\n');
    target.scrollTop = target.scrollHeight;
  }

  function logEvent(line) {
    appendLog(el.eventLog, `[${nowText()}] ${line}`, MAX_LOG_LINES);
  }

  function logTimeline(line) {
    appendLog(el.timelineLog, `[${nowText()}] ${line}`, MAX_TIMELINE_LINES);
  }

  function normalizeEventPayload(raw) {
    if (!raw || typeof raw !== 'object') return {};
    if (raw.data && typeof raw.data === 'object') return raw.data;
    return raw;
  }

  function updateObservability(payload) {
    if (!payload || typeof payload !== 'object') return false;
    let changed = false;
    if (typeof payload.runId === 'string' && payload.runId.trim() && payload.runId !== state.runId) {
      state.runId = payload.runId.trim();
      changed = true;
    }
    if (typeof payload.requestId === 'string' && payload.requestId.trim() && payload.requestId !== state.requestId) {
      state.requestId = payload.requestId.trim();
      changed = true;
    }
    if (typeof payload.runSequence === 'number' && Number.isFinite(payload.runSequence)) {
      const next = Math.max(0, Math.floor(payload.runSequence));
      if (next !== state.runSequence) {
        state.runSequence = next;
        changed = true;
      }
    }
    return changed;
  }

  function extractEnvelopeRowsCount(envelope) {
    const data = envelope && envelope.data;
    if (!data) return 0;
    if (Array.isArray(data)) return data.length;
    if (Array.isArray(data.rows)) return data.rows.length;
    if (Array.isArray(data.data)) return data.data.length;
    return 0;
  }

  function renderEnvelopes() {
    el.envelopeRows.innerHTML = '';
    for (const env of state.envelopes) {
      const tr = document.createElement('tr');
      const ts = env.meta && env.meta.timestamp ? new Date(env.meta.timestamp).toLocaleTimeString() : '-';
      const source = env.meta && env.meta.source ? env.meta.source : '-';
      const step = env.meta && env.meta.stepId ? env.meta.stepId : '-';
      const layer = env.display && env.display.layer ? env.display.layer : '-';
      const format = env.display && env.display.format ? env.display.format : '-';
      const rows = extractEnvelopeRowsCount(env);

      tr.innerHTML = [
        `<td>${escapeHtml(ts)}</td>`,
        `<td>${escapeHtml(source)}</td>`,
        `<td>${escapeHtml(step)}</td>`,
        `<td>${escapeHtml(layer)}</td>`,
        `<td>${escapeHtml(format)}</td>`,
        `<td>${rows}</td>`,
      ].join('');
      el.envelopeRows.appendChild(tr);
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderFinalSummary(payload) {
    const content = [];
    content.push(`Conclusion: ${payload.conclusion || '-'}`);
    content.push(`Confidence: ${payload.confidence != null ? payload.confidence : '-'}`);
    content.push(`Rounds: ${payload.rounds != null ? payload.rounds : '-'}`);
    content.push(`Duration(ms): ${payload.totalDurationMs != null ? payload.totalDurationMs : '-'}`);

    const contract = payload.resultContract || {};
    const envelopes = Array.isArray(contract.dataEnvelopes) ? contract.dataEnvelopes.length : 0;
    const diagnostics = Array.isArray(contract.diagnostics) ? contract.diagnostics.length : 0;
    const actions = Array.isArray(contract.actions) ? contract.actions.length : 0;
    content.push(`ResultContract version: ${contract.version || '-'}`);
    content.push(`ResultContract dataEnvelopes: ${envelopes}`);
    content.push(`ResultContract diagnostics: ${diagnostics}`);
    content.push(`ResultContract actions: ${actions}`);
    content.push(`Run ID: ${state.runId || '-'}`);
    content.push(`Request ID: ${state.requestId || '-'}`);
    content.push(`Run Sequence: ${state.runSequence || '-'}`);
    if (payload.reportUrl) {
      content.push(`Report URL: ${payload.reportUrl}`);
    }

    el.finalSummary.textContent = content.join('\n');
  }

  function persistState() {
    const saved = {
      backendUrl: el.backendUrl.value,
      apiKey: el.apiKey.value,
      traceId: el.traceId.value,
      sessionId: state.sessionId,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(saved));
  }

  function restoreState() {
    const saved = safeJsonParse(localStorage.getItem(LS_KEY) || '{}');
    const backendUrl = saved.backendUrl || window.location.origin;
    el.backendUrl.value = backendUrl;
    el.apiKey.value = saved.apiKey || '';
    el.traceId.value = saved.traceId || '';
    state.sessionId = saved.sessionId || '';
    el.sessionId.value = state.sessionId;
  }

  function setSessionId(sessionId) {
    state.sessionId = String(sessionId || '');
    el.sessionId.value = state.sessionId;
    persistState();
  }

  function stopStream(reason) {
    if (state.eventAbort) {
      state.eventAbort.abort();
      state.eventAbort = null;
    }
    state.isStreaming = false;
    if (reason) {
      logEvent(`stream closed: ${reason}`);
    }
    setSseState('disconnected', '');
  }

  function handleConversationStep(data) {
    const payload = normalizeEventPayload(data);
    const nestedContent = payload.content && typeof payload.content === 'object' ? payload.content : null;
    const text =
      payload.text ||
      (nestedContent && nestedContent.text) ||
      payload.message ||
      payload.phase ||
      JSON.stringify(payload);
    logTimeline(text);
  }

  function handleDataEvent(data) {
    const envelopePayload = data && data.envelope;
    const envelopes = toArray(envelopePayload).filter((env) => env && typeof env === 'object');
    if (envelopes.length === 0) return;

    state.envelopes.push.apply(state.envelopes, envelopes);
    while (state.envelopes.length > MAX_ENVELOPES) {
      state.envelopes.shift();
    }
    renderEnvelopes();
    logEvent(`data envelopes +${envelopes.length}`);
  }

  function handleAnalysisCompleted(data) {
    updateObservability(data);
    const payload = normalizeEventPayload(data);
    if (payload.observability) {
      updateObservability(payload.observability);
    }
    renderFinalSummary(payload);
    logEvent('analysis_completed received');

    const contractEnvelopes = payload.resultContract && payload.resultContract.dataEnvelopes;
    if (Array.isArray(contractEnvelopes) && contractEnvelopes.length > 0) {
      state.envelopes = contractEnvelopes.slice(-MAX_ENVELOPES);
      renderEnvelopes();
      logEvent(`resultContract envelopes loaded: ${contractEnvelopes.length}`);
    }
  }

  function handleSseEvent(eventType, eventData) {
    if (eventType === 'connected') {
      if (updateObservability(eventData)) {
        logEvent(`observability updated: run=${state.runId}, request=${state.requestId}, seq=${state.runSequence}`);
      }
      setSseState('connected', 'connected');
      logEvent('connected');
      return;
    }

    if (eventType === 'conversation_step') {
      handleConversationStep(eventData);
      return;
    }

    if (eventType === 'data') {
      handleDataEvent(eventData);
      return;
    }

    if (eventType === 'analysis_completed') {
      handleAnalysisCompleted(eventData);
      stopStream('completed');
      return;
    }

    if (eventType === 'error') {
      const payload = normalizeEventPayload(eventData);
      logEvent(`error: ${payload.message || payload.error || 'unknown'}`);
      stopStream('error');
      setSseState('error', 'error');
      return;
    }

    if (eventType === 'end') {
      stopStream('end');
      return;
    }

    if (eventType === 'progress') {
      const payload = normalizeEventPayload(eventData);
      if (payload.message) {
        logTimeline(payload.message);
      }
      return;
    }

    logEvent(`event: ${eventType}`);
  }

  async function connectStream(sessionId) {
    if (!sessionId) {
      throw new Error('sessionId required');
    }

    stopStream();
    const url = buildApiUrl(`/${sessionId}/stream`);
    const controller = new AbortController();
    state.eventAbort = controller;
    state.isStreaming = true;
    setSseState('connecting', '');
    logEvent(`connecting stream: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(false),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error('SSE body missing');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';

    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) continue;

        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
          continue;
        }

        if (line.startsWith('data:')) {
          const rawData = line.slice(5).trim();
          const parsed = safeJsonParse(rawData);
          const eventType = currentEvent || (parsed && parsed.type) || 'message';
          handleSseEvent(eventType, parsed);
          currentEvent = '';
        }
      }
    }

    stopStream('reader done');
  }

  async function startAnalyze() {
    const query = el.query.value.trim();
    const traceId = el.traceId.value.trim();
    if (!query) {
      throw new Error('query is required');
    }
    if (!traceId) {
      throw new Error('traceId is required');
    }

    const body = {
      query: query,
      traceId: traceId,
      options: {
        maxRounds: 3,
        confidenceThreshold: 0.5,
      },
    };
    if (state.sessionId) {
      body.sessionId = state.sessionId;
    }

    const url = buildApiUrl('/analyze');
    logEvent(`POST ${url}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(true),
      body: JSON.stringify(body),
    });
    const result = safeJsonParse(await response.text());
    if (!response.ok || !result || result.success !== true) {
      const message = result && result.error ? result.error : `HTTP ${response.status}`;
      throw new Error(message);
    }

    setSessionId(result.sessionId || '');
    const requestIdFromHeader = response.headers.get('x-request-id') || '';
    if (result && typeof result === 'object') {
      updateObservability({
        runId: result.runId,
        requestId: result.requestId || requestIdFromHeader,
        runSequence: result.runSequence,
      });
    } else if (requestIdFromHeader) {
      updateObservability({ requestId: requestIdFromHeader });
    }
    if (state.runId || state.requestId || state.runSequence) {
      logEvent(`analyze accepted: run=${state.runId || '-'}, request=${state.requestId || '-'}, seq=${state.runSequence || '-'}`);
    }
    if (result.sessionId) {
      await connectStream(result.sessionId);
    }
  }

  function clearSession() {
    stopStream('manual clear');
    setSessionId('');
    state.runId = '';
    state.requestId = '';
    state.runSequence = 0;
    state.envelopes = [];
    renderEnvelopes();
    el.finalSummary.textContent = '';
    el.eventLog.textContent = '';
    el.timelineLog.textContent = '';
    logEvent('session cleared');
  }

  async function onAnalyzeClick() {
    try {
      persistState();
      el.analyzeBtn.disabled = true;
      await startAnalyze();
    } catch (error) {
      logEvent(`analyze failed: ${error.message || String(error)}`);
      setSseState('error', 'error');
    } finally {
      el.analyzeBtn.disabled = false;
    }
  }

  async function onStreamClick() {
    try {
      const sessionId = (el.sessionId.value || '').trim();
      setSessionId(sessionId);
      if (!sessionId) throw new Error('sessionId is required');
      await connectStream(sessionId);
    } catch (error) {
      logEvent(`stream failed: ${error.message || String(error)}`);
      setSseState('error', 'error');
    }
  }

  function init() {
    restoreState();
    setSseState('disconnected', '');
    logEvent('web shell ready');
    el.analyzeBtn.addEventListener('click', onAnalyzeClick);
    el.streamBtn.addEventListener('click', onStreamClick);
    el.clearBtn.addEventListener('click', clearSession);
    el.backendUrl.addEventListener('change', persistState);
    el.apiKey.addEventListener('change', persistState);
    el.traceId.addEventListener('change', persistState);
    window.addEventListener('beforeunload', function () {
      stopStream('page unload');
      persistState();
    });
  }

  init();
})();
