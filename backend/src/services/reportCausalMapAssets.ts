// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const REPORT_CAUSAL_MAP_CSS = String.raw`
.mermaid-wrapper {
  margin: 12px 0 22px;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 8px;
}
pre.mermaid {
  background:
    radial-gradient(circle at top right, rgba(96, 165, 250, 0.16), transparent 32%),
    linear-gradient(180deg, #f8fbff 0%, #f3f7fb 100%);
  border: 1px solid #dbe7f3;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 8px 20px rgba(15, 23, 42, 0.06);
  padding: 20px;
  border-radius: 16px;
  text-align: center;
  margin: 0;
  min-width: fit-content;
}
.causal-map {
  --causal-line: #2563eb;
  --causal-line-soft: #bfdbfe;
  background:
    radial-gradient(circle at top right, rgba(37, 99, 235, 0.12), transparent 28%),
    linear-gradient(180deg, #f8fbff 0%, #ffffff 100%);
  border: 1px solid #dbe7f3;
  border-radius: 24px;
  padding: 22px;
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08);
}
.causal-map-hero {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-bottom: 18px;
}
.causal-map-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 999px;
  background: linear-gradient(135deg, #dbeafe 0%, #eef2ff 100%);
  border: 1px solid #bfdbfe;
  color: #1d4ed8;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.02em;
}
.causal-map-badge::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: currentColor;
  box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.14);
}
.causal-map-note {
  font-size: 12px;
  color: #475569;
  line-height: 1.6;
}
.causal-map-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 18px;
  align-items: start;
}
.causal-group {
  position: relative;
  background: rgba(255, 255, 255, 0.94);
  border: 1px solid #dbe3ef;
  border-radius: 18px;
  padding: 18px 16px 16px;
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.06);
  overflow: hidden;
}
.causal-group::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: linear-gradient(180deg, #60a5fa 0%, #a78bfa 100%);
  opacity: 0.7;
}
.causal-group[data-role="impact"] {
  background: linear-gradient(180deg, #eff6ff 0%, #ffffff 100%);
}
.causal-group-header {
  margin-bottom: 14px;
  padding-left: 4px;
}
.causal-group-kicker {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #64748b;
  margin-bottom: 6px;
}
.causal-group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 800;
  color: #0f172a;
}
.causal-group-title::before {
  content: '';
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: #2563eb;
  box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.14);
}
.causal-group-meta {
  margin-top: 6px;
  font-size: 12px;
  color: #64748b;
}
.causal-flow-row {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding-left: 10px;
  margin-bottom: 14px;
}
.causal-flow-row:last-child {
  margin-bottom: 0;
}
.causal-flow-row::before {
  content: '';
  position: absolute;
  left: 17px;
  top: 18px;
  bottom: 18px;
  width: 2px;
  border-radius: 999px;
  background: linear-gradient(180deg, #93c5fd 0%, #c7d2fe 100%);
}
.causal-step {
  position: relative;
  padding-left: 24px;
}
.causal-step::before {
  content: '';
  position: absolute;
  left: 10px;
  top: 18px;
  width: 14px;
  height: 2px;
  background: var(--causal-line-soft);
}
.causal-step::after {
  content: '';
  position: absolute;
  left: 5px;
  top: 13px;
  width: 12px;
  height: 12px;
  border-radius: 999px;
  background: #ffffff;
  border: 3px solid var(--causal-line);
  box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.12);
}
.causal-node {
  width: 100%;
  min-width: 0;
  max-width: none;
  padding: 12px 14px;
  border-radius: 16px;
  background: var(--node-bg, #ffffff);
  border: 1.5px solid var(--node-accent, #cbd5e1);
  box-shadow: 0 10px 22px rgba(15, 23, 42, 0.08);
}
.causal-node-title {
  font-size: 14px;
  font-weight: 800;
  color: var(--node-text, #0f172a);
  line-height: 1.35;
}
.causal-node-meta {
  margin-top: 5px;
  font-size: 12.5px;
  line-height: 1.55;
  color: rgba(15, 23, 42, 0.76);
  white-space: pre-line;
}
.causal-arrow {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 34px;
  padding: 4px 0 6px 24px;
  color: var(--causal-line);
  font-size: 12px;
  font-weight: 700;
}
.causal-arrow-line {
  position: relative;
  width: 2px;
  height: 20px;
  border-radius: 999px;
  background: currentColor;
  margin-left: -13px;
}
.causal-arrow-line::after {
  content: '';
  position: absolute;
  left: -4px;
  bottom: -3px;
  border-top: 7px solid currentColor;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
}
.causal-arrow-label {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid #bfdbfe;
  background: #eff6ff;
  color: #1d4ed8;
  white-space: nowrap;
}
.causal-cross-links {
  margin-top: 18px;
  padding-top: 18px;
  border-top: 1px dashed #cbd5e1;
}
.causal-cross-links-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 14px;
  margin-bottom: 12px;
}
.causal-cross-links-title {
  font-size: 14px;
  font-weight: 800;
  color: #0f172a;
}
.causal-cross-links-note {
  font-size: 12px;
  color: #64748b;
}
.causal-cross-links-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}
.causal-link-row {
  padding: 14px;
  border-radius: 16px;
  border: 1px solid #dbe7f3;
  background: linear-gradient(180deg, #f8fbff 0%, #ffffff 100%);
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.04);
}
.causal-link-path {
  display: flex;
  align-items: center;
  gap: 8px;
}
.causal-chip {
  padding: 7px 10px;
  border-radius: 14px;
  border: 1px solid #cbd5e1;
  background: #ffffff;
  color: #0f172a;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.4;
}
.causal-chip[data-tone="from"] {
  border-color: #bfdbfe;
  background: #eff6ff;
}
.causal-chip[data-tone="to"] {
  border-color: #bbf7d0;
  background: #f0fdf4;
}
.causal-chip[data-tone="label"] {
  border-color: #e9d5ff;
  background: #faf5ff;
  color: #6d28d9;
}
.causal-link-dash {
  position: relative;
  flex: 1;
  min-width: 30px;
  border-top: 2px dashed #64748b;
  height: 0;
}
.causal-link-dash::after {
  content: '';
  position: absolute;
  right: -6px;
  top: -5px;
  border-left: 6px solid #64748b;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
}
.causal-map-source {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px dashed #dbe3ef;
}
.causal-map-source summary {
  cursor: pointer;
  font-size: 12px;
  color: #475569;
  font-weight: 700;
  list-style: none;
}
.causal-map-source summary::-webkit-details-marker {
  display: none;
}
.causal-map-source pre {
  margin-top: 10px;
  padding: 12px;
  border-radius: 12px;
  background: #0f172a;
  color: #e2e8f0;
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.55;
}
pre.mermaid svg {
  display: block;
  height: auto;
  margin: 0 auto;
  overflow: visible;
}
pre.mermaid .label,
pre.mermaid .nodeLabel,
pre.mermaid .edgeLabel,
pre.mermaid .cluster-label {
  color: #0f172a !important;
  font-weight: 600;
}
pre.mermaid .edgeLabel rect,
pre.mermaid .labelBkg {
  fill: rgba(255, 255, 255, 0.96) !important;
  stroke: #cbd5e1 !important;
  stroke-width: 1px !important;
  rx: 999px !important;
  ry: 999px !important;
}
pre.mermaid .edgePath path.path,
pre.mermaid .flowchart-link {
  stroke: #334155 !important;
  stroke-width: 2.8px !important;
  stroke-linecap: round !important;
}
pre.mermaid marker path,
pre.mermaid .marker path,
pre.mermaid .arrowheadPath {
  fill: #334155 !important;
  stroke: #334155 !important;
  stroke-width: 1.6px !important;
}
pre.mermaid .node rect,
pre.mermaid .node circle,
pre.mermaid .node ellipse,
pre.mermaid .node polygon,
pre.mermaid .node path {
  stroke-width: 2px !important;
}
pre.mermaid .cluster rect {
  fill: rgba(226, 232, 240, 0.36) !important;
  stroke: #94a3b8 !important;
  stroke-width: 1.8px !important;
  rx: 14px !important;
  ry: 14px !important;
}
pre.mermaid .cluster-label text,
pre.mermaid .cluster span {
  fill: #1e293b !important;
  color: #1e293b !important;
  font-weight: 700 !important;
}
@media (max-width: 900px) {
  pre.mermaid {
    padding: 16px;
  }
  .causal-map {
    padding: 18px;
  }
  .causal-map-grid {
    grid-template-columns: 1fr;
  }
}
`;

export const REPORT_CAUSAL_MAP_SCRIPT = String.raw`
if (typeof mermaid !== 'undefined') {
  function decodeMermaidSource(text) {
    return String(text || '')
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim();
  }

  function decodeMermaidText(text) {
    return decodeMermaidSource(text)
      .replace(/<br\s*\/?>/gi, '\n')
      .trim();
  }

  function normalizeGroupName(raw) {
    return String(raw || '').replace(/^['"]|['"]$/g, '').trim();
  }

  function getGroupRole(groupName) {
    var label = String(groupName || '').trim();
    if (/影响|impact|结果|outcome|结论|conclusion/i.test(label)) return 'impact';
    if (/输入|source|入口|上游/i.test(label)) return 'source';
    return 'chain';
  }

  function parseNodeRef(raw, currentGroup, nodes, nodeOrder) {
    var ref = String(raw || '').trim();
    if (!ref) return null;
    var match = ref.match(/^([A-Za-z0-9_]+)\s*(?:\[(.*)\]|\((.*)\)|\{(.*)\})?$/);
    if (!match) return null;

    var id = match[1];
    var label = match[2] || match[3] || match[4] || '';
    if (!nodes[id]) {
      nodes[id] = {
        id: id,
        label: '',
        group: '',
        order: nodeOrder.count++,
      };
    }
    if (label && !nodes[id].label) nodes[id].label = decodeMermaidText(label);
    if (currentGroup && label && !nodes[id].group) nodes[id].group = currentGroup;
    if (!nodes[id].label) nodes[id].label = id;
    return id;
  }

  function parseMermaidFlowSource(source) {
    var text = decodeMermaidSource(source);
    if (!text) return null;

    var lines = text.split(/\r?\n/);
    var header = String(lines.shift() || '').trim();
    var headerMatch = header.match(/^(graph|flowchart)\s+([A-Z]{2})/i);
    if (!headerMatch) return null;

    var nodes = {};
    var styles = {};
    var edges = [];
    var groups = [];
    var currentGroup = '';
    var nodeOrder = { count: 0 };
    var edgeOrder = 0;

    lines.forEach(function(rawLine) {
      var line = String(rawLine || '').trim();
      if (!line) return;

      if (/^subgraph\s+/i.test(line)) {
        currentGroup = normalizeGroupName(line.replace(/^subgraph\s+/i, ''));
        if (currentGroup && groups.indexOf(currentGroup) === -1) groups.push(currentGroup);
        return;
      }

      if (/^end$/i.test(line)) {
        currentGroup = '';
        return;
      }

      if (/^style\s+/i.test(line)) {
        var styleMatch = line.match(/^style\s+([A-Za-z0-9_]+)\s+(.+)$/i);
        if (!styleMatch) return;

        var styleId = styleMatch[1];
        styles[styleId] = styles[styleId] || {};
        styleMatch[2].split(',').forEach(function(part) {
          var kv = part.split(':');
          if (kv.length < 2) return;
          styles[styleId][kv[0].trim()] = kv.slice(1).join(':').trim();
        });
        return;
      }

      var edgeMatch = line.match(/^(.*?)\s+(-\.->|-->|==>)\s*(?:\|([^|]+)\|)?\s*(.*?)$/);
      if (edgeMatch) {
        var fromId = parseNodeRef(edgeMatch[1], currentGroup, nodes, nodeOrder);
        var toId = parseNodeRef(edgeMatch[4], currentGroup, nodes, nodeOrder);
        if (!fromId || !toId) return;

        edges.push({
          id: 'edge_' + edgeOrder++,
          from: fromId,
          to: toId,
          label: decodeMermaidText(edgeMatch[3] || ''),
          dashed: edgeMatch[2].indexOf('.-.') !== -1,
          group: currentGroup || '',
        });
        return;
      }

      parseNodeRef(line, currentGroup, nodes, nodeOrder);
    });

    var nodeList = Object.keys(nodes).map(function(key) { return nodes[key]; });
    if (nodeList.length < 2 || edges.length === 0) return null;

    nodeList.forEach(function(node) {
      if (!node.group) node.group = '其他节点';
      if (groups.indexOf(node.group) === -1) groups.push(node.group);
    });

    return {
      direction: headerMatch[2].toUpperCase(),
      groups: groups,
      nodes: nodes,
      edges: edges,
      styles: styles,
    };
  }

  function hexToRgba(hex, alpha) {
    var value = String(hex || '').trim();
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) return '';
    if (value.length === 4) {
      value = '#' + value.charAt(1) + value.charAt(1) + value.charAt(2) + value.charAt(2) + value.charAt(3) + value.charAt(3);
    }
    var r = parseInt(value.slice(1, 3), 16);
    var g = parseInt(value.slice(3, 5), 16);
    var b = parseInt(value.slice(5, 7), 16);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }

  function buildNodeVisual(node, styles) {
    var style = styles[node.id] || {};
    var accent = style.fill || '#cbd5e1';
    return {
      accent: accent,
      background: hexToRgba(accent, 0.14) || '#ffffff',
      textColor: style.color || '#0f172a',
    };
  }

  function buildGroupSequences(groupName, diagram) {
    var nodes = diagram.nodes;
    var groupNodes = Object.keys(nodes)
      .map(function(id) { return nodes[id]; })
      .filter(function(node) { return node.group === groupName; })
      .sort(function(a, b) { return a.order - b.order; });

    var solidEdges = diagram.edges.filter(function(edge) {
      return !edge.dashed
        && nodes[edge.from]
        && nodes[edge.to]
        && nodes[edge.from].group === groupName
        && nodes[edge.to].group === groupName;
    });

    var outgoing = {};
    var indegree = {};
    groupNodes.forEach(function(node) {
      outgoing[node.id] = [];
      indegree[node.id] = 0;
    });

    solidEdges.forEach(function(edge) {
      outgoing[edge.from].push(edge);
      indegree[edge.to] += 1;
    });

    Object.keys(outgoing).forEach(function(id) {
      outgoing[id].sort(function(a, b) {
        return diagram.nodes[a.to].order - diagram.nodes[b.to].order;
      });
    });

    var sequences = [];
    var visitedNodes = {};
    var visitedEdges = {};
    var starts = groupNodes.filter(function(node) {
      return outgoing[node.id].length > 0 && indegree[node.id] === 0;
    });
    if (starts.length === 0 && solidEdges.length > 0) {
      starts = [diagram.nodes[solidEdges[0].from]];
    }

    starts.forEach(function(startNode) {
      if (!startNode || visitedNodes[startNode.id]) return;
      var sequence = [{ type: 'node', nodeId: startNode.id }];
      visitedNodes[startNode.id] = true;
      var currentId = startNode.id;
      while (outgoing[currentId] && outgoing[currentId].length > 0) {
        var nextEdge = outgoing[currentId].find(function(edge) {
          return !visitedEdges[edge.id] && !visitedNodes[edge.to];
        });
        if (!nextEdge) break;

        visitedEdges[nextEdge.id] = true;
        sequence.push({ type: 'edge', edge: nextEdge });
        sequence.push({ type: 'node', nodeId: nextEdge.to });
        visitedNodes[nextEdge.to] = true;
        currentId = nextEdge.to;
      }
      sequences.push(sequence);
    });

    groupNodes.forEach(function(node) {
      if (!visitedNodes[node.id]) {
        sequences.push([{ type: 'node', nodeId: node.id }]);
        visitedNodes[node.id] = true;
      }
    });

    return sequences;
  }

  function buildNodeCard(node, styles) {
    var visual = buildNodeVisual(node, styles);
    var card = document.createElement('div');
    card.className = 'causal-node';
    card.style.setProperty('--node-accent', visual.accent);
    card.style.setProperty('--node-bg', visual.background);
    card.style.setProperty('--node-text', visual.textColor);

    var lines = String(node.label || node.id).split(/\n+/).filter(Boolean);
    var title = document.createElement('div');
    title.className = 'causal-node-title';
    title.textContent = lines[0] || node.id;
    card.appendChild(title);

    if (lines.length > 1) {
      var meta = document.createElement('div');
      meta.className = 'causal-node-meta';
      meta.textContent = lines.slice(1).join('\n');
      card.appendChild(meta);
    }

    return card;
  }

  function buildArrow(edge) {
    var arrow = document.createElement('div');
    arrow.className = 'causal-arrow';

    var line = document.createElement('span');
    line.className = 'causal-arrow-line';
    arrow.appendChild(line);

    if (edge && edge.label) {
      var label = document.createElement('span');
      label.className = 'causal-arrow-label';
      label.textContent = edge.label;
      arrow.appendChild(label);
    }

    return arrow;
  }

  function buildSequence(sequence, diagram) {
    var row = document.createElement('div');
    row.className = 'causal-flow-row';
    sequence.forEach(function(item) {
      if (item.type === 'node') {
        var step = document.createElement('div');
        step.className = 'causal-step';
        step.appendChild(buildNodeCard(diagram.nodes[item.nodeId], diagram.styles));
        row.appendChild(step);
      } else if (item.type === 'edge') {
        row.appendChild(buildArrow(item.edge));
      }
    });
    return row;
  }

  function getCrossSectionTitle(crossEdges) {
    var titles = [];
    crossEdges.forEach(function(edge) {
      if (edge.group && titles.indexOf(edge.group) === -1) titles.push(edge.group);
    });
    return titles[0] || '跨链路影响关系';
  }

  function buildCausalMap(diagram, originalSource) {
    var root = document.createElement('div');
    root.className = 'causal-map';

    var hero = document.createElement('div');
    hero.className = 'causal-map-hero';
    var badge = document.createElement('div');
    badge.className = 'causal-map-badge';
    badge.textContent = '因果链流程图';
    hero.appendChild(badge);
    var note = document.createElement('div');
    note.className = 'causal-map-note';
    note.textContent = '实线表示主链路推进，虚线关系会单独列出，便于看清跨模块影响。';
    hero.appendChild(note);
    root.appendChild(hero);

    var grid = document.createElement('div');
    grid.className = 'causal-map-grid';
    root.appendChild(grid);

    diagram.groups.forEach(function(groupName) {
      var groupNodes = Object.keys(diagram.nodes).filter(function(id) {
        return diagram.nodes[id].group === groupName;
      });
      if (groupNodes.length === 0) return;

      var groupEl = document.createElement('section');
      groupEl.className = 'causal-group';
      groupEl.setAttribute('data-role', getGroupRole(groupName));

      var header = document.createElement('div');
      header.className = 'causal-group-header';

      var kicker = document.createElement('div');
      kicker.className = 'causal-group-kicker';
      kicker.textContent = getGroupRole(groupName) === 'impact' ? 'Impact Lane' : 'Flow Lane';
      header.appendChild(kicker);

      var title = document.createElement('div');
      title.className = 'causal-group-title';
      title.textContent = groupName;
      header.appendChild(title);

      var sequences = buildGroupSequences(groupName, diagram);
      var meta = document.createElement('div');
      meta.className = 'causal-group-meta';
      meta.textContent = groupNodes.length + ' 个节点 · ' + sequences.length + ' 条链路';
      header.appendChild(meta);
      groupEl.appendChild(header);

      sequences.forEach(function(sequence) {
        groupEl.appendChild(buildSequence(sequence, diagram));
      });

      grid.appendChild(groupEl);
    });

    var crossEdges = diagram.edges.filter(function(edge) {
      var fromNode = diagram.nodes[edge.from];
      var toNode = diagram.nodes[edge.to];
      if (!fromNode || !toNode) return false;
      return edge.dashed || fromNode.group !== toNode.group;
    });

    if (crossEdges.length > 0) {
      var crossSection = document.createElement('section');
      crossSection.className = 'causal-cross-links';

      var crossHead = document.createElement('div');
      crossHead.className = 'causal-cross-links-head';
      var crossTitle = document.createElement('div');
      crossTitle.className = 'causal-cross-links-title';
      crossTitle.textContent = getCrossSectionTitle(crossEdges);
      crossHead.appendChild(crossTitle);
      var crossNote = document.createElement('div');
      crossNote.className = 'causal-cross-links-note';
      crossNote.textContent = '这里专门展示资源竞争、旁路阻塞、跨链路影响。';
      crossHead.appendChild(crossNote);
      crossSection.appendChild(crossHead);

      var crossGrid = document.createElement('div');
      crossGrid.className = 'causal-cross-links-grid';

      crossEdges.forEach(function(edge) {
        var row = document.createElement('div');
        row.className = 'causal-link-row';

        var path = document.createElement('div');
        path.className = 'causal-link-path';

        var fromChip = document.createElement('span');
        fromChip.className = 'causal-chip';
        fromChip.setAttribute('data-tone', 'from');
        fromChip.textContent = diagram.nodes[edge.from].label.split(/\n+/)[0];
        path.appendChild(fromChip);

        var dash = document.createElement('span');
        dash.className = 'causal-link-dash';
        path.appendChild(dash);

        if (edge.label) {
          var edgeChip = document.createElement('span');
          edgeChip.className = 'causal-chip';
          edgeChip.setAttribute('data-tone', 'label');
          edgeChip.textContent = edge.label;
          path.appendChild(edgeChip);

          var dash2 = document.createElement('span');
          dash2.className = 'causal-link-dash';
          path.appendChild(dash2);
        }

        var toChip = document.createElement('span');
        toChip.className = 'causal-chip';
        toChip.setAttribute('data-tone', 'to');
        toChip.textContent = diagram.nodes[edge.to].label.split(/\n+/)[0];
        path.appendChild(toChip);

        row.appendChild(path);
        crossGrid.appendChild(row);
      });

      crossSection.appendChild(crossGrid);
      root.appendChild(crossSection);
    }

    var sourceDetails = document.createElement('details');
    sourceDetails.className = 'causal-map-source';
    var summary = document.createElement('summary');
    summary.textContent = '查看原始 Mermaid 图';
    sourceDetails.appendChild(summary);
    var sourcePre = document.createElement('pre');
    sourcePre.textContent = String(originalSource || '').trim();
    sourceDetails.appendChild(sourcePre);
    root.appendChild(sourceDetails);

    return root;
  }

  var mermaidTargets = [];
  document.querySelectorAll('pre.mermaid').forEach(function(el) {
    var originalSource = decodeMermaidSource(el.textContent || '');
    var parsed = parseMermaidFlowSource(originalSource);
    if (parsed) {
      var wrapper = el.closest('.mermaid-wrapper') || el.parentElement;
      if (wrapper) {
        wrapper.innerHTML = '';
        wrapper.appendChild(buildCausalMap(parsed, originalSource));
        return;
      }
    }

    el.textContent = originalSource;
    el.setAttribute('data-render-mode', 'mermaid');
    mermaidTargets.push(el);
  });

  if (mermaidTargets.length > 0) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'neutral',
      securityLevel: 'strict',
      flowchart: {
        useMaxWidth: true,
        htmlLabels: false,
        nodeSpacing: 48,
        rankSpacing: 64,
        padding: 18,
        curve: 'linear'
      },
      themeVariables: {
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
        fontSize: '15px',
        lineColor: '#334155',
        primaryColor: '#ffffff',
        primaryTextColor: '#0f172a',
        primaryBorderColor: '#94a3b8',
        secondaryColor: '#f8fafc',
        tertiaryColor: '#eff6ff',
        clusterBkg: '#f8fafc',
        clusterBorder: '#cbd5e1'
      }
    });

    mermaid.run({ querySelector: 'pre.mermaid[data-render-mode="mermaid"]' }).then(function() {
      document.querySelectorAll('pre.mermaid svg').forEach(function(svg) {
        svg.style.width = '100%';
        svg.style.maxWidth = '100%';
        svg.style.height = 'auto';
        svg.style.display = 'block';
        svg.style.margin = '0 auto';
      });
    }).catch(function(err) {
      console.error('[SmartPerfetto] Mermaid 渲染失败:', err);
    });
  }
}
`;
