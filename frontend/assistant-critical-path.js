(function smartPerfettoCriticalPathAssistant() {
  const SETTINGS_KEY = 'smartperfetto-ai-settings';
  const INLINE_BTN_CLASS = 'sp-critical-path-inline-btn';
  const DRAWER_CLASS = 'sp-critical-path-drawer';
  const state = {
    open: false,
    loading: false,
    traceId: '',
    analysis: null,
    aiSummary: null,
    error: '',
    status: '',
  };

  function getBackendUrl() {
    try {
      const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (typeof settings.backendUrl === 'string' && settings.backendUrl.trim()) {
        return settings.backendUrl.replace(/\/+$/, '');
      }
    } catch (_) {
      // ignore
    }
    return 'http://localhost:3000';
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.error || data.message || `HTTP ${response.status}`);
    }
    return data;
  }

  async function resolveCurrentTraceId() {
    const backendUrl = getBackendUrl();

    try {
      const stats = await fetchJson(`${backendUrl}/api/traces/stats`);
      const items = stats?.stats?.traces?.items;
      if (Array.isArray(items) && items.length > 0) {
        const readyItems = items
          .filter((trace) => trace.status === 'ready' && trace.id)
          .sort((a, b) => new Date(b.uploadedAt || b.uploadTime || 0) - new Date(a.uploadedAt || a.uploadTime || 0));
        if (readyItems.length > 0) {
          return readyItems[0].id;
        }
      }
      const traceIds = stats?.stats?.processors?.traceIds;
      if (Array.isArray(traceIds) && traceIds.length > 0) {
        return traceIds[traceIds.length - 1];
      }
    } catch (_) {
      // Fall through to /api/traces.
    }

    const traces = await fetchJson(`${backendUrl}/api/traces`);
    const list = Array.isArray(traces.traces) ? traces.traces : [];
    const ready = list
      .filter((trace) => trace.status === 'ready' && trace.id)
      .sort((a, b) => new Date(b.uploadedAt || b.uploadTime || 0) - new Date(a.uploadedAt || a.uploadTime || 0));
    if (ready.length > 0) {
      return ready[0].id;
    }
    throw new Error('当前网页还没有可用的后端 traceId，请先打开 Trace 并等待 AI Assistant 显示 RPC 已连接。');
  }

  function numericString(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
    const text = String(value).trim();
    return /^-?\d+$/.test(text) ? text : '';
  }

  function getSelectedTask() {
    const trace = window.app?.trace;
    const selection = trace?.selection?.selection;
    if (!trace || !selection || selection.kind !== 'track_event') {
      throw new Error('请先选中一个 thread_state task。');
    }

    const startTs = numericString(selection.ts);
    const dur = numericString(selection.dur);
    if (!startTs || !dur || dur === '-1' || dur === '0') {
      throw new Error('当前选中项没有有效持续时间，不能做 Critical path 分析。');
    }

    const track = trace.tracks?.getTrack?.(selection.trackUri);
    const utid = typeof track?.tags?.utid === 'number' ? track.tags.utid : undefined;
    return {
      threadStateId: selection.eventId,
      utid,
      startTs,
      dur,
      trackUri: selection.trackUri,
    };
  }

  function hasThreadStateTaskSelection() {
    const trace = window.app?.trace;
    const selection = trace?.selection?.selection;
    if (!trace || !selection || selection.kind !== 'track_event') return false;

    const startTs = numericString(selection.ts);
    const dur = numericString(selection.dur);
    if (!startTs || !dur || dur === '-1' || dur === '0') return false;

    const track = trace.tracks?.getTrack?.(selection.trackUri);
    const kinds = track?.tags?.kinds;
    return Array.isArray(kinds)
      ? kinds.includes('ThreadStateTrack')
      : String(selection.trackUri || '').endsWith('_state');
  }

  async function analyzeSelectedTask() {
    state.open = true;
    state.loading = true;
    state.error = '';
    state.aiSummary = null;
    state.status = '正在读取选中 task，并调用 Perfetto critical path stack...';
    renderDrawer();

    try {
      const backendUrl = getBackendUrl();
      const traceId = await resolveCurrentTraceId();
      state.traceId = traceId;
      const selectedTask = getSelectedTask();
      const result = await fetchJson(`${backendUrl}/api/critical-path/${encodeURIComponent(traceId)}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadStateId: selectedTask.threadStateId,
          utid: selectedTask.utid,
          startTs: selectedTask.startTs,
          dur: selectedTask.dur,
          maxSegments: 180,
          includeAi: true,
        }),
      });
      state.analysis = result.analysis;
      state.aiSummary = result.aiSummary || null;
      state.status = '';
      state.error = '';
    } catch (error) {
      state.error = `Critical path 分析失败：${error.message || error}`;
      state.status = '';
    } finally {
      state.loading = false;
      renderDrawer();
    }
  }

  function ensureInlineButtons() {
    const selectionButton = document.querySelector('.ai-preset-questions .ai-selection-btn');
    if (!selectionButton || !hasThreadStateTaskSelection()) {
      removeInlineButtons();
      return;
    }

    const parent = selectionButton.parentElement;
    if (!parent || parent.querySelector(`.${INLINE_BTN_CLASS}`)) return;

    const analyzeButton = document.createElement('button');
    analyzeButton.type = 'button';
    analyzeButton.className = `ai-preset-btn ${INLINE_BTN_CLASS}`;
    analyzeButton.innerHTML = '<i class="pf-icon">account_tree</i><span>Critical path 分析</span>';
    analyzeButton.title = '分析选中 thread_state task 的唤醒链、异常点和关联模块';
    analyzeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      analyzeSelectedTask();
    });
    selectionButton.insertAdjacentElement('afterend', analyzeButton);
  }

  function removeInlineButtons() {
    document.querySelectorAll(`.${INLINE_BTN_CLASS}`).forEach((button) => button.remove());
  }

  function ensureDrawer() {
    let drawer = document.querySelector(`.${DRAWER_CLASS}`);
    if (!drawer) {
      drawer = document.createElement('aside');
      drawer.className = DRAWER_CLASS;
      document.body.appendChild(drawer);
    }
    return drawer;
  }

  function renderDrawer() {
    const drawer = ensureDrawer();
    drawer.classList.toggle('active', state.open);
    if (!state.open) return;

    const analysis = state.analysis;
    drawer.innerHTML = `
      <div class="sp-critical-path-header">
        <div>
          <span>Critical Path</span>
          <h2>Critical path 分析</h2>
        </div>
        <button class="sp-critical-path-close" type="button" aria-label="关闭">×</button>
      </div>
      ${state.loading ? renderStatus('正在分析 selected task 的 critical path，并生成 AI 诊断...', false) : ''}
      ${state.error ? renderStatus(state.error, true) : ''}
      ${analysis ? renderAnalysis(analysis, state.aiSummary) : renderEmpty()}
    `;

    drawer.querySelector('.sp-critical-path-close')?.addEventListener('click', () => {
      state.open = false;
      renderDrawer();
    });

    drawer.querySelectorAll('.sp-critical-path-copy-btn').forEach((button) => {
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        const sql = button.getAttribute('data-sql');
        if (!sql) return;
        try {
          await navigator.clipboard.writeText(sql);
          const originalText = button.textContent;
          button.textContent = '✓ 已复制';
          setTimeout(() => {
            button.textContent = originalText;
          }, 1600);
        } catch (error) {
          button.textContent = '复制失败';
          console.error('[CriticalPath] clipboard error:', error);
        }
      });
    });
  }

  function renderStatus(message, isError) {
    return `<div class="sp-critical-path-status ${isError ? 'error' : ''}">${escapeHtml(message)}</div>`;
  }

  function renderEmpty() {
    if (state.loading || state.error) return '';
    return `
      <div class="sp-critical-path-empty">
        选中 thread_state task 后点击“Critical path 分析”，这里会显示唤醒链、异常判断和关联模块。
      </div>
    `;
  }

  function renderAnalysis(analysis, aiSummary) {
    const task = analysis.task || {};
    const counterfactual = analysis.quantification?.counterfactual;
    return `
      <div class="sp-critical-path-metrics">
        ${renderMetric('Task', `${formatMs(analysis.totalMs)}`)}
        ${renderMetric('外部链路', `${formatMs(analysis.blockingMs)}`)}
        ${renderMetric('占比', `${formatPercent(analysis.externalBlockingPercentage)}`)}
        ${counterfactual ? renderMetric('反事实上界', `${formatMs(counterfactual.upperBoundMs)}`, '消除最长段后的上界估算') : ''}
      </div>

      <section class="sp-critical-path-card">
        <h3>规则事实</h3>
        <div class="sp-critical-path-summary">${renderPlainText(analysis.summary)}</div>
        <div class="sp-critical-path-facts">
          <span>${escapeHtml(task.processName || '-')} / ${escapeHtml(task.threadName || '-')}</span>
          <span>${escapeHtml(task.state || 'unknown')}</span>
          ${renderWakerChip(analysis.directWaker, task)}
        </div>
        ${renderSemanticSources(analysis.semanticSources || {})}
      </section>

      ${renderAiSummary(aiSummary)}

      <section class="sp-critical-path-card">
        <h3>异常判断</h3>
        ${renderAnomalies(analysis.anomalies || [])}
      </section>

      <section class="sp-critical-path-card">
        <h3>唤醒链</h3>
        ${renderChain(analysis.wakeupChain || [], 0)}
      </section>

      <section class="sp-critical-path-card">
        <h3>关联模块</h3>
        ${renderModules(analysis.moduleBreakdown || [])}
      </section>

      ${renderFrameImpacts(analysis.quantification?.frameImpacts || [])}

      ${renderHypotheses(analysis.quantification?.hypotheses || [])}

      ${renderSlices(analysis.slices || [])}

      <section class="sp-critical-path-card">
        <h3>下一步</h3>
        ${renderList(analysis.recommendations || [])}
      </section>

      ${Array.isArray(analysis.warnings) && analysis.warnings.length ? renderStatus(analysis.warnings.join('；'), false) : ''}
    `;
  }

  function renderWakerChip(directWaker, task) {
    if (directWaker) {
      const kindLabel = ({irq: 'IRQ', swapper: 'swapper', thread: 'thread', unknown: '未知'})[directWaker.kind] || directWaker.kind;
      const name = directWaker.threadName ? ` ${directWaker.threadName}` : '';
      const proc = directWaker.processName ? ` (${directWaker.processName})` : '';
      const irq = directWaker.irqContext ? ' · IRQ' : '';
      return `<span>Waker: ${escapeHtml(kindLabel)}${escapeHtml(name)}${escapeHtml(proc)}${escapeHtml(irq)}</span>`;
    }
    if (task.waker?.threadName || task.waker?.interruptContext) {
      const label = task.waker.interruptContext ? 'Interrupt' : `${task.waker.processName || '-'} / ${task.waker.threadName || '-'}`;
      return `<span>Waker: ${escapeHtml(label)}</span>`;
    }
    return '';
  }

  function renderSemanticSources(sources) {
    const entries = Object.entries(sources);
    if (!entries.length) return '';
    const labels = {binder: 'Binder', monitor: 'Monitor', io: 'IO', gc: 'GC', cpu: 'CPU竞争'};
    return `
      <div class="sp-critical-path-sources">
        ${entries
          .map(([key, status]) => {
            const label = labels[key] || key;
            const cls = status === 'present' ? 'present' : status === 'empty' ? 'empty' : 'missing';
            return `<span class="sp-critical-path-source ${cls}" title="${escapeHtml(status)}">${escapeHtml(label)}</span>`;
          })
          .join('')}
      </div>
    `;
  }

  function renderFrameImpacts(impacts) {
    if (!impacts.length) return '';
    return `
      <section class="sp-critical-path-card">
        <h3>关联帧</h3>
        ${impacts
          .map(
            (impact) => `
            <div class="sp-critical-path-frame-row">
              <div>
                <b>frame ${escapeHtml(String(impact.frameId ?? '-'))}</b>
                <p>预期 ${formatMs(impact.expectedDeadlineDurMs)} · 重叠 ${formatMs(impact.overlapMs)}</p>
              </div>
              <div>
                <span>${escapeHtml(impact.jankType || '-')}</span>
                <span>${escapeHtml(impact.presentType || '-')}</span>
              </div>
            </div>
          `
          )
          .join('')}
      </section>
    `;
  }

  function renderHypotheses(hypotheses) {
    if (!hypotheses.length) return '';
    return `
      <section class="sp-critical-path-card">
        <h3>可证伪假设</h3>
        ${hypotheses
          .map(
            (hyp, idx) => `
            <div class="sp-critical-path-hypothesis ${escapeHtml(hyp.strength || 'weak')}">
              <div class="sp-critical-path-hypothesis-head">
                <b>${escapeHtml(hyp.statement)}</b>
                <span class="sp-critical-path-strength">${escapeHtml(hyp.strength || 'weak')}</span>
              </div>
              ${hyp.notes && hyp.notes.length ? `<div class="sp-critical-path-hypothesis-notes">${hyp.notes.map(n => `<span>${escapeHtml(n)}</span>`).join('')}</div>` : ''}
              <div class="sp-critical-path-sql-block">
                <pre>${escapeHtml(hyp.verificationSql)}</pre>
                <button type="button" class="sp-critical-path-copy-btn" data-hyp-idx="${idx}" data-sql="${encodeAttr(hyp.verificationSql)}">复制 SQL</button>
              </div>
            </div>
          `
          )
          .join('')}
      </section>
    `;
  }

  function renderSlices(slices) {
    if (!slices || slices.length <= 1) return '';
    return `
      <section class="sp-critical-path-card">
        <h3>选区切片 (${slices.length} segments)</h3>
        ${slices
          .map(
            (slice) => `
            <div class="sp-critical-path-slice-row ${escapeHtml(slice.kind || 'unknown')}">
              <span>${escapeHtml(slice.kind || 'unknown')}</span>
              <span>${formatMs(slice.durationMs)}</span>
              <span>${escapeHtml(slice.state || '-')}</span>
              ${slice.ioWait ? '<span class="sp-critical-path-iowait">io_wait</span>' : ''}
              ${slice.skippedReason ? `<small>${escapeHtml(slice.skippedReason)}</small>` : ''}
            </div>
          `
          )
          .join('')}
      </section>
    `;
  }

  function encodeAttr(value) {
    return String(value || '').replace(/"/g, '&quot;');
  }

  function renderAiSummary(aiSummary) {
    if (!aiSummary) return '';
    const badge = aiSummary.generated
      ? `LLM · ${aiSummary.model || 'model'}`
      : '规则兜底';
    return `
      <section class="sp-critical-path-card sp-critical-path-ai-card">
        <h3>AI 诊断 <span>${escapeHtml(badge)}</span></h3>
        <div class="sp-critical-path-summary">${renderPlainText(aiSummary.summary)}</div>
        ${aiSummary.redactionApplied ? renderStatus('已对发送给模型的数据做隐私脱敏。', false) : ''}
        ${Array.isArray(aiSummary.warnings) && aiSummary.warnings.length ? renderStatus(aiSummary.warnings.join('；'), false) : ''}
      </section>
    `;
  }

  function renderMetric(label, value, tooltip) {
    return `
      <div class="sp-critical-path-metric"${tooltip ? ` title="${escapeHtml(tooltip)}"` : ''}>
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `;
  }

  function renderAnomalies(items) {
    if (!items.length) return '<div class="sp-critical-path-muted">未发现明显异常。</div>';
    return items
      .map(
        (item) => `
        <div class="sp-critical-path-anomaly ${escapeHtml(item.severity || 'info')}">
          <b>${escapeHtml(item.title || '异常')}</b>
          <p>${escapeHtml(item.detail || '')}</p>
          ${renderEvidence(item.evidence || [])}
        </div>
      `
      )
      .join('');
  }

  function renderEvidence(items) {
    const values = items.filter(Boolean).slice(0, 5);
    if (!values.length) return '';
    return `<div class="sp-critical-path-evidence">${values.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>`;
  }

  const MAX_RECURSION_DEPTH = 3;

  function renderChain(items, depth) {
    if (!items.length) return '<div class="sp-critical-path-muted">没有取到外部 critical path 段。</div>';
    const indent = depth || 0;
    return items
      .slice(0, 24)
      .map(
        (item, index) => `
        <div class="sp-critical-path-chain-row" style="${indent ? `margin-left: ${indent * 16}px;` : ''}">
          <div class="sp-critical-path-chain-index">${escapeHtml(String(indent ? '↳' : index + 1))}</div>
          <div>
            <b>${escapeHtml(item.processName || '-')} / ${escapeHtml(item.threadName || '-')}</b>
            <p>${formatMs(item.durationMs)} · +${formatMs(item.startOffsetMs)} · ${escapeHtml(item.state || 'unknown')}</p>
            ${renderEvidence([...(item.modules || []), ...(item.reasons || []), ...(item.slices || [])])}
            ${item.semantics && item.semantics.binderTxns && item.semantics.binderTxns.length ? renderBinderHint(item.semantics.binderTxns[0]) : ''}
            ${item.children && item.children.length && indent < MAX_RECURSION_DEPTH ? `<details class="sp-critical-path-children"><summary>子链路 (${item.children.length})</summary>${renderChain(item.children, indent + 1)}</details>` : ''}
          </div>
        </div>
      `
      )
      .join('');
  }

  function renderBinderHint(txn) {
    const label = txn.side === 'server' ? 'binder server' : txn.side === 'both' ? 'binder client+server' : 'binder client';
    return `<div class="sp-critical-path-evidence"><span>${escapeHtml(label)}</span><span>${escapeHtml(txn.methodName || '-')}</span><span>${formatMs(txn.durMs || 0)}</span></div>`;
  }

  function renderModules(items) {
    if (!items.length) return '<div class="sp-critical-path-muted">暂无模块归因。</div>';
    return items
      .slice(0, 10)
      .map(
        (item) => `
        <div class="sp-critical-path-module-row">
          <span>
            <b>${escapeHtml(item.module)}</b>
            <small>${escapeHtml((item.examples || []).join('；') || `${item.segmentCount || 0} segments`)}</small>
          </span>
          <strong>${formatMs(item.durationMs)} · ${formatPercent(item.percentage)}</strong>
        </div>
      `
      )
      .join('');
  }

  function renderList(items) {
    if (!items.length) return '<div class="sp-critical-path-muted">暂无建议。</div>';
    return `<ul class="sp-critical-path-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  }

  function renderPlainText(value) {
    return String(value || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join('');
  }

  function formatMs(value) {
    const number = Number(value || 0);
    return `${number.toFixed(number >= 10 ? 1 : 2)} ms`;
  }

  function formatPercent(value) {
    const number = Number(value || 0);
    return `${number.toFixed(number >= 10 ? 1 : 2)}%`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (char) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[char]
    );
  }

  const observer = new MutationObserver(() => ensureInlineButtons());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureInlineButtons();
})();
