(function smartPerfettoAssistantFlamegraph() {
  const TAB_CLASS = 'sp-flamegraph-tab';
  const BODY_CLASS = 'sp-flamegraph-body';
  const SETTINGS_KEY = 'smartperfetto-ai-settings';
  const state = {
    active: false,
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
      if (Array.isArray(items) && items.length > 0 && items[0].id) {
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

  function setStatus(message, isError) {
    state.status = message || '';
    state.error = isError ? message || '' : '';
    renderBody();
  }

  async function analyzeFlamegraph() {
    state.loading = true;
    state.error = '';
    state.status = '正在自动获取当前 Trace，并检查是否包含 CPU 调用栈采样...';
    renderBody();

    try {
      const backendUrl = getBackendUrl();
      const traceId = await resolveCurrentTraceId();
      state.traceId = traceId;

      const availability = await fetchJson(`${backendUrl}/api/flamegraph/${encodeURIComponent(traceId)}/availability`);
      if (!availability.available) {
        state.analysis = null;
        state.aiSummary = null;
        const missing =
          Array.isArray(availability.missing) && availability.missing.length > 0
            ? `\n缺失字段/表：${availability.missing.join(', ')}`
            : '';
        setStatus(`这个 Trace 没有 CPU 调用栈采样，不能分析火焰图数据。${missing}`, true);
        return;
      }

      state.status = '已经找到 Perfetto 火焰图 summary tree，正在分析热点并生成 AI 总结...';
      renderBody();

      const result = await fetchJson(`${backendUrl}/api/flamegraph/${encodeURIComponent(traceId)}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          includeAi: true,
          maxNodes: 3000,
        }),
      });

      state.analysis = result.analysis;
      state.aiSummary = result.aiSummary;

      if (!result.analysis?.available || !result.analysis?.filteredSampleCount) {
        state.aiSummary = null;
        setStatus('这个 Trace 没有 CPU 调用栈采样，不能分析火焰图数据。', true);
        return;
      }

      state.status = '';
      state.error = '';
      renderBody();
    } catch (error) {
      setStatus(`火焰图分析失败：${error.message || error}`, true);
    } finally {
      state.loading = false;
      renderBody();
    }
  }

  function ensurePanel() {
    const panel = document.querySelector('.ai-panel');
    const tabs = panel?.querySelector('.ai-view-tabs');
    if (!panel || !tabs) {
      return;
    }

    if (!tabs.dataset.spFlamegraphBound) {
      tabs.dataset.spFlamegraphBound = 'true';
      tabs.addEventListener('click', (event) => {
        const target = event.target;
        if (target instanceof Element && !target.closest(`.${TAB_CLASS}`)) {
          state.active = false;
          syncVisibility();
        }
      });
    }

    let tab = tabs.querySelector(`.${TAB_CLASS}`);
    if (!tab) {
      tab = document.createElement('button');
      tab.className = `${TAB_CLASS} ai-view-tab`;
      tab.type = 'button';
      tab.title = 'CPU 火焰图数据分析';
      tab.textContent = '火焰图';
      tab.addEventListener('click', () => {
        state.active = true;
        syncVisibility();
        if (!state.analysis && !state.loading) {
          analyzeFlamegraph();
        }
      });
      tabs.appendChild(tab);
    }

    let body = panel.querySelector(`.${BODY_CLASS}`);
    if (!body) {
      body = document.createElement('div');
      body.className = BODY_CLASS;
      tabs.insertAdjacentElement('afterend', body);
      renderBody();
    }

    syncVisibility();
  }

  function syncVisibility() {
    const panel = document.querySelector('.ai-panel');
    if (!panel) return;
    const tab = panel.querySelector(`.${TAB_CLASS}`);
    const body = panel.querySelector(`.${BODY_CLASS}`);
    panel.classList.toggle('sp-flamegraph-active', state.active);
    if (tab) tab.classList.toggle('active', state.active);
    if (body) body.classList.toggle('active', state.active);
    panel.querySelectorAll('.ai-content-wrapper, .ai-story-body').forEach((element) => {
      setInlineOverride(element, 'display', state.active ? 'none' : null);
    });
    panel.querySelectorAll(`.ai-view-tab:not(.${TAB_CLASS})`).forEach((element) => {
      setInlineOverride(element, 'background', state.active ? 'transparent' : null);
      setInlineOverride(element, 'color', state.active ? 'var(--chat-text)' : null);
      setInlineOverride(element, 'fontWeight', state.active ? '400' : null);
    });
  }

  function setInlineOverride(element, property, value) {
    const key = `spFlamegraph${property}`;
    if (value !== null) {
      if (!(key in element.dataset)) {
        element.dataset[key] = element.style[property] || '';
      }
      element.style[property] = value;
      return;
    }
    if (key in element.dataset) {
      element.style[property] = element.dataset[key];
      delete element.dataset[key];
    }
  }

  function renderBody() {
    const body = document.querySelector(`.${BODY_CLASS}`);
    if (!body) return;

    const analysis = state.analysis;
    const hasSamples = !!analysis?.available && !!analysis?.filteredSampleCount;
    body.innerHTML = `
      <div class="sp-flamegraph-shell ${hasSamples ? 'has-data' : 'is-empty'}">
        <section class="sp-flamegraph-hero">
          <div class="sp-flamegraph-title">
            <div class="sp-flamegraph-kicker"><span></span> CPU Flamegraph</div>
            <h2>火焰图数据分析</h2>
            <p>${escapeHtml(state.traceId ? `已连接当前 Trace：${shortId(state.traceId)}` : '自动读取当前 Trace，不需要手动复制 traceId。')}</p>
          </div>
          <div class="sp-flamegraph-actions">
            <button class="sp-flamegraph-btn primary" data-action="analyze" ${state.loading ? 'disabled' : ''}>
              ${state.loading ? '分析中...' : '分析火焰图数据'}
            </button>
          </div>
        </section>

        <div class="sp-flamegraph-note">
          图形展示继续使用 Perfetto 自带 Flamegraph/CPU profiling 视图；这里仅读取 Perfetto 已产出的 summary tree，做热点归因、路径整理和 AI 解释。
        </div>

        ${state.status ? renderStatus() : ''}
        ${hasSamples ? renderMetrics(analysis) : ''}
        ${hasSamples ? renderPerfettoNotice(analysis) : ''}
        ${hasSamples ? renderAiSummary(state.aiSummary) : renderEmptyGuide(analysis)}
        ${hasSamples ? renderTables(analysis) : ''}
      </div>
    `;

    body.querySelector('[data-action="analyze"]')?.addEventListener('click', analyzeFlamegraph);
  }

  function renderStatus() {
    return `
      <div class="sp-flamegraph-status ${state.error ? 'error' : ''}" role="status">
        <span class="sp-flamegraph-status-mark"></span>
        <span>${escapeHtml(state.status)}</span>
      </div>
    `;
  }

  function renderMetrics(analysis) {
    const analyzerLabel =
      analysis?.analyzer?.engine === 'rust'
        ? 'Perfetto + Rust'
        : analysis?.analyzer?.engine === 'typescript-fallback'
          ? 'Perfetto + TS'
          : analysis?.analyzer?.engine
            ? analysis.analyzer.engine
            : '-';
    return `
      <div class="sp-flamegraph-metrics">
        <div class="sp-flamegraph-metric"><span>采样数</span><strong>${formatNumber(analysis?.filteredSampleCount || 0)}</strong></div>
        <div class="sp-flamegraph-metric"><span>样本表</span><strong>${escapeHtml(analysis?.source?.sampleTable || '-')}</strong></div>
        <div class="sp-flamegraph-metric"><span>数据来源</span><strong>${analyzerLabel}</strong></div>
      </div>
    `;
  }

  function renderPerfettoNotice(analysis) {
    return `
      <div class="sp-flamegraph-card sp-flamegraph-perfetto-notice">
        <h3>数据说明</h3>
        <p>火焰图本体由 Perfetto 渲染，本面板只分析 Perfetto summary tree 里的采样统计，不额外绘制第二张图。</p>
        <div class="sp-flamegraph-facts">
          <span>Summary tree：${escapeHtml(analysis?.source?.sampleTable || '-')}</span>
          <span>分析引擎：${escapeHtml(analysis?.analyzer?.engine || '-')}</span>
          <span>范围：整份 Trace</span>
        </div>
      </div>
    `;
  }

  function renderEmptyGuide(analysis) {
    const sampleTable = analysis?.source?.sampleTable || 'perf_sample / cpu_profile_stack_sample';
    return `
      <section class="sp-flamegraph-empty-state">
        <div class="sp-flamegraph-empty-visual" aria-hidden="true">
          <div class="sp-flamegraph-sample-ghost">
            <span style="--w: 92%"></span>
            <span style="--w: 68%"></span>
            <span style="--w: 78%"></span>
            <span style="--w: 42%"></span>
            <span style="--w: 55%"></span>
          </div>
          <div class="sp-flamegraph-zero-badge">0 samples</div>
        </div>
        <div class="sp-flamegraph-empty-copy">
          <div class="sp-flamegraph-empty-eyebrow">缺少调用栈采样</div>
          <h3>这个 Trace 没有 CPU 调用栈采样，不能分析火焰图数据。</h3>
          <p>你现在看到的 CPU 轨道更像“线程调度时间线”，它能告诉我们线程什么时候在跑；火焰图还需要采样到函数调用栈，才能回答 CPU 时间具体花在了哪些函数上。</p>

          <div class="sp-flamegraph-compare">
            <div>
              <strong>当前 Trace 有什么</strong>
              <span>CPU scheduling / thread state，可以看运行时段和调度关系。</span>
            </div>
            <div>
              <strong>火焰图还需要什么</strong>
              <span>perf_sample 或 cpu_profile_stack_sample 里的调用栈样本。</span>
            </div>
          </div>

          <div class="sp-flamegraph-empty-facts">
            <span>采样数：${formatNumber(analysis?.filteredSampleCount || 0)}</span>
            <span>检测表：${escapeHtml(sampleTable)}</span>
            <span>状态：没有采到调用栈样本</span>
          </div>

          <div class="sp-flamegraph-howto">
            <b>下次录制时打开其中一种：</b>
            <span>CPU profiling</span>
            <span>Callstack sampling</span>
            <span>simpleperf</span>
            <span>native callstacks</span>
          </div>
        </div>
      </section>
    `;
  }

  function renderAiSummary(aiSummary) {
    const text = aiSummary?.summary || '还没有 AI 总结。点击“分析火焰图数据”后，会复用你配置的 AI 模型生成中文解释。';
    const renderedSummary = renderMarkdown(text);
    return `
      <div class="sp-flamegraph-card">
        <h3>AI 总结</h3>
        <div class="sp-flamegraph-ai sp-flamegraph-markdown">${renderedSummary}</div>
      </div>
    `;
  }

  function renderTables(analysis) {
    if (!analysis) {
      return `
        <div class="sp-flamegraph-grid">
          <div class="sp-flamegraph-card"><h3>自占热点函数</h3><div class="sp-flamegraph-empty">暂无数据。</div></div>
          <div class="sp-flamegraph-card"><h3>累计调用链热点</h3><div class="sp-flamegraph-empty">暂无数据。</div></div>
          <div class="sp-flamegraph-card"><h3>最热路径</h3><div class="sp-flamegraph-empty">暂无数据。</div></div>
          <div class="sp-flamegraph-card"><h3>热点归类</h3><div class="sp-flamegraph-empty">暂无数据。</div></div>
        </div>
      `;
    }

    const topSelfFunctions =
      (analysis.topFunctions || [])
        .slice(0, 10)
        .map(
          (item) => `
      <div class="sp-flamegraph-row">
        <span>${escapeHtml(item.name)}<small>${escapeHtml(item.categoryLabel || '未归类')} · ${escapeHtml(item.mappingName || 'unknown')}</small></span>
        <b>${formatPercent(item.selfCount, analysis.filteredSampleCount)}</b>
      </div>
    `
        )
        .join('') || '<div class="sp-flamegraph-empty">暂无自占热点。</div>';

    const topCumulativeFunctions =
      (analysis.topCumulativeFunctions || [])
        .slice(0, 10)
        .map(
          (item) => `
      <div class="sp-flamegraph-row">
        <span>${escapeHtml(item.name)}<small>${escapeHtml(item.categoryLabel || '未归类')} · 自占 ${formatPercent(item.selfCount, analysis.filteredSampleCount)}</small></span>
        <b>${formatPercent(item.sampleCount, analysis.filteredSampleCount)}</b>
      </div>
    `
        )
        .join('') || '<div class="sp-flamegraph-empty">暂无累计热点。</div>';

    const hotPaths =
      (analysis.hotPaths || [])
        .slice(0, 8)
        .map(
          (item, index) => `
      <div class="sp-flamegraph-path">
        <b>#${index + 1} ${formatPercent(item.sampleCount, analysis.filteredSampleCount)} · ${escapeHtml(item.leafCategoryLabel || '未归类')}</b>
        <small>${escapeHtml((item.compressedFrames || item.frames || []).join(' -> '))}</small>
      </div>
    `
        )
        .join('') || '<div class="sp-flamegraph-empty">暂无热点路径。</div>';

    const categoryRows =
      (analysis.categoryBreakdown || [])
        .slice(0, 8)
        .map(
          (item) => `
      <div class="sp-flamegraph-row">
        <span>${escapeHtml(item.label)}<small>自占 ${formatNumber(item.selfCount)} / 累计 ${formatNumber(item.sampleCount)}</small></span>
        <b>${formatPercent(item.selfCount, analysis.filteredSampleCount)}</b>
      </div>
    `
        )
        .join('') || '<div class="sp-flamegraph-empty">暂无归类数据。</div>';

    return `
      <div class="sp-flamegraph-grid">
        <div class="sp-flamegraph-card"><h3>自占热点函数</h3>${topSelfFunctions}</div>
        <div class="sp-flamegraph-card"><h3>累计调用链热点</h3>${topCumulativeFunctions}</div>
        <div class="sp-flamegraph-card"><h3>最热路径</h3>${hotPaths}</div>
        <div class="sp-flamegraph-card"><h3>热点归类</h3>${categoryRows}</div>
      </div>
    `;
  }

  function renderMarkdown(markdown) {
    const lines = String(markdown || '')
      .replace(/\r\n?/g, '\n')
      .split('\n');
    const html = [];
    let paragraph = [];
    let quote = [];
    let list = null;
    let table = null;
    let codeBlock = null;

    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      html.push(`<p>${paragraph.map(renderInlineMarkdown).join('<br>')}</p>`);
      paragraph = [];
    };

    const flushQuote = () => {
      if (quote.length === 0) return;
      html.push(`<blockquote>${quote.map(renderInlineMarkdown).join('<br>')}</blockquote>`);
      quote = [];
    };

    const flushList = () => {
      if (!list) return;
      html.push(`<${list.type}>${list.items.map((item) => `<li>${item}</li>`).join('')}</${list.type}>`);
      list = null;
    };

    const flushTable = () => {
      if (!table || table.rows.length === 0) {
        table = null;
        return;
      }
      const [head, ...body] = table.rows;
      const header = `<thead><tr>${head.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join('')}</tr></thead>`;
      const rows = body
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`)
        .join('');
      html.push(`<div class="sp-flamegraph-table-scroll"><table>${header}<tbody>${rows}</tbody></table></div>`);
      table = null;
    };

    const flushCodeBlock = () => {
      if (!codeBlock) return;
      const language = codeBlock.language ? ` data-language="${escapeHtml(codeBlock.language)}"` : '';
      html.push(`<pre${language}><code>${escapeHtml(codeBlock.lines.join('\n'))}</code></pre>`);
      codeBlock = null;
    };

    const pushListItem = (type, content) => {
      flushParagraph();
      flushQuote();
      flushTable();
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push(renderInlineMarkdown(content));
    };

    for (const line of lines) {
      const trimmed = line.trim();

      const fence = trimmed.match(/^```([A-Za-z0-9_-]+)?\s*$/);
      if (fence) {
        if (codeBlock) {
          flushCodeBlock();
          continue;
        }
        flushParagraph();
        flushQuote();
        flushList();
        flushTable();
        codeBlock = { language: fence[1] || '', lines: [] };
        continue;
      }

      if (codeBlock) {
        codeBlock.lines.push(line);
        continue;
      }

      if (!trimmed) {
        flushParagraph();
        flushQuote();
        flushList();
        flushTable();
        continue;
      }

      const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        flushQuote();
        flushList();
        flushTable();
        const level = Math.min(6, heading[1].length + 3);
        html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
        continue;
      }

      if (/^-{3,}$/.test(trimmed)) {
        flushParagraph();
        flushQuote();
        flushList();
        flushTable();
        html.push('<hr>');
        continue;
      }

      const quoted = trimmed.match(/^>\s?(.*)$/);
      if (quoted) {
        flushParagraph();
        flushList();
        flushTable();
        quote.push(quoted[1]);
        continue;
      }

      if (isMarkdownTableDivider(trimmed)) {
        if (table && table.rows.length === 1) {
          continue;
        }
        flushParagraph();
        flushQuote();
        flushList();
        continue;
      }

      if (isMarkdownTableRow(trimmed)) {
        flushParagraph();
        flushQuote();
        flushList();
        if (!table) table = { rows: [] };
        table.rows.push(splitMarkdownTableRow(trimmed));
        continue;
      }

      const ordered = trimmed.match(/^(\d+)\.\s+(.+)$/);
      if (ordered) {
        pushListItem('ol', ordered[2]);
        continue;
      }

      const unordered = trimmed.match(/^[-*]\s+(.+)$/);
      if (unordered) {
        pushListItem('ul', unordered[1]);
        continue;
      }

      if (list && /^\s+/.test(line) && list.items.length > 0) {
        list.items[list.items.length - 1] += `<br>${renderInlineMarkdown(trimmed)}`;
        continue;
      }

      flushQuote();
      flushList();
      flushTable();
      paragraph.push(trimmed);
    }

    flushCodeBlock();
    flushParagraph();
    flushQuote();
    flushList();
    flushTable();
    return html.join('');
  }

  function renderInlineMarkdown(text) {
    const codeSpans = [];
    const withoutCode = String(text ?? '').replace(/`([^`]+)`/g, (_, code) => {
      const token = `@@SP_CODE_${codeSpans.length}@@`;
      codeSpans.push(`<code>${escapeHtml(code)}</code>`);
      return token;
    });

    let html = escapeHtml(withoutCode)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
        const safeHref = sanitizeMarkdownUrl(href);
        return safeHref ? `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noreferrer">${label}</a>` : label;
      });

    codeSpans.forEach((code, index) => {
      html = html.replaceAll(`@@SP_CODE_${index}@@`, code);
    });
    return html;
  }

  function isMarkdownTableRow(line) {
    return line.includes('|') && /^\|?.+\|.+\|?$/.test(line);
  }

  function isMarkdownTableDivider(line) {
    return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line);
  }

  function splitMarkdownTableRow(line) {
    const trimmed = line.replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split('|').map((cell) => cell.trim());
  }

  function sanitizeMarkdownUrl(value) {
    const url = String(value || '').trim();
    if (/^(https?:|mailto:)/i.test(url)) {
      return url;
    }
    return '';
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('zh-CN').format(value || 0);
  }

  function formatPercent(value, total) {
    if (!total) return '0%';
    return `${Math.round((value * 10000) / total) / 100}%`;
  }

  function shortId(value) {
    const text = String(value || '');
    return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
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

  const observer = new MutationObserver(() => ensurePanel());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensurePanel();
})();
