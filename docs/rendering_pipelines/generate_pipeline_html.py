import os
import glob
import re
import json
import random

SOURCE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SOURCE_DIR, "html")

# Professional Perfetto-like Color Palette (Muted/Dark)
# Using colors that work well with #0f1115 background
COMPONENT_PALETTE = {
    "SF": "#e57373",        # SurfaceFlinger (System Red)
    "HWC": "#7986cb",       # HWC (Indigo)
    "App": "#81c784",       # App UI (Green)
    "RT": "#4db6ac",        # RenderThread (Teal)
    "BBQ": "#ffb74d",       # BLAST (Orange)
    "Binder": "#ba68c8",    # Binder (Purple)
    "HW": "#90a4ae",        # Hardware (Grey/Blue)
    "WP": "#4fc3f7",        # WebView (Cyan)
    "Flutter": "#4db6ac",
    "Display": "#90a4ae"
}

def get_pro_color(name_id):
    for key, color in COMPONENT_PALETTE.items():
        if key.lower() in name_id.lower():
            return color
    # Deterministic fallback
    palette = ["#81c784", "#64b5f6", "#ffb74d", "#ba68c8", "#ef5350", "#4db6ac"]
    random.seed(name_id)
    return random.choice(palette)

TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>__TITLE__</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-main: #0f1115;
            --bg-sidebar: #1a1d23;
            --border-color: #2e323a;
            --text-main: #e8eaed;
            --text-muted: #9aa0a6;
            --accent: #8ab4f8;
            --row-h: 28px;
            --sb-w: 160px;
        }

        body {
            font-family: 'Inter', sans-serif;
            background-color: var(--bg-main);
            color: var(--text-main);
            margin: 0;
            padding: 0;
            line-height: 1.5;
            -webkit-font-smoothing: antialiased;
        }

        .header {
            padding: 12px 24px;
            background: var(--bg-sidebar);
            border-bottom: 2px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .header h1 { font-size: 16px; margin: 0; font-weight: 500; }
        .legend { display: flex; gap: 16px; font-size: 11px; color: var(--text-muted); }
        .legend-item { display: flex; align-items: center; gap: 4px; }
        .color-dot { width: 8px; height: 8px; border-radius: 50%; }

        .main-ui {
            display: flex;
            position: relative;
            max-height: 500px; /* Limit height for many tracks */
            overflow: hidden;
            border-bottom: 1px solid var(--border-color);
        }

        /* Sidebar: Sticky Names */
        .sidebar {
            width: var(--sb-w);
            background: var(--bg-sidebar);
            border-right: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            padding-top: 30px; /* Ruler height */
            z-index: 100;
            overflow-y: hidden; /* Sync with viewport */
        }
        .track-name {
            height: var(--row-h);
            display: flex;
            align-items: center;
            padding: 0 12px;
            font-size: 11px;
            color: var(--text-muted);
            border-bottom: 1px solid rgba(255,255,255,0.02);
            font-weight: 400;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* Viewport: Scrollable Timeline */
        .viewport {
            flex-grow: 1;
            overflow: auto;
            position: relative;
        }

        .timeline-ruler {
            height: 30px;
            background: var(--bg-sidebar);
            border-bottom: 1px solid var(--border-color);
            position: sticky;
            top: 0;
            z-index: 90;
            display: flex;
            pointer-events: none;
        }
        .ruler-tick {
            position: absolute;
            bottom: 0;
            border-left: 1px solid #3c4043;
            height: 8px;
            font-size: 9px;
            color: #5f6368;
            padding-left: 4px;
            line-height: 1;
        }

        .chart-canvas {
            position: relative;
            background-image: linear-gradient(to bottom, transparent var(--row-h), rgba(255,255,255,0.02) var(--row-h));
            background-size: 100% calc(var(--row-h) + 1px);
        }

        /* Slices: Thin and clean */
        .slice {
            position: absolute;
            height: 18px;
            border-radius: 2px;
            font-size: 10px;
            color: rgba(255,255,255,0.9);
            padding: 0 6px;
            line-height: 18px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            box-sizing: border-box;
            border: 1px solid rgba(0,0,0,0.1);
            transition: filter 0.2s, transform 0.1s;
            cursor: default;
        }
        .slice:hover {
            filter: brightness(1.3);
            transform: scaleY(1.1);
            z-index: 200;
            box-shadow: 0 0 10px rgba(0,0,0,0.5);
        }

        /* Flows: 1px professional lines */
        .flow-layer {
            position: absolute;
            top: 0; left: 0;
            width: 100%; height: 100%;
            pointer-events: none;
            z-index: 10;
        }
        path.flow-line {
            fill: none;
            stroke-width: 1px;
            opacity: 0.3;
            transition: opacity 0.2s, stroke-width 0.2s;
        }
        path.flow-line.active {
            opacity: 0.9 !important;
            stroke-width: 2px;
        }

        /* Guides */
        .vsync-guide {
            position: absolute;
            top: 0; bottom: 0;
            width: 1px;
            border-left: 1px dashed rgba(138, 180, 248, 0.4);
            pointer-events: none;
            z-index: 5;
        }

        .tooltip {
            position: fixed;
            background: #1e1e1e;
            border: 1px solid var(--border-color);
            padding: 8px 12px;
            font-size: 11px;
            pointer-events: none;
            display: none;
            z-index: 1000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            border-radius: 4px;
        }
        
        /* Markdown Content Section */
        .doc-section {
            padding: 40px;
            background: #15181e;
            border-top: 1px solid var(--border-color);
            margin-top: 20px;
        }
        .doc-content { max-width: 1000px; margin: 0 auto; line-height: 1.7; }
        .doc-content h2 { color: var(--accent); margin-top: 2.5rem; }
        .doc-content pre { padding: 1.5rem; background: #0b0d11; border-radius: 8px; }
        
        .mermaid { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
    </style>
</head>
<body>

<div class="header">
    <h1>__TITLE__ - Android Rendering Pipeline</h1>
    <div class="legend" id="legend"></div>
</div>

<div class="main-ui">
    <div class="sidebar" id="sidebar"></div>
    <div class="viewport" id="viewport">
        <div class="timeline-ruler" id="ruler"></div>
        <div class="chart-canvas" id="canvas">
            <svg class="flow-layer" id="flow-svg"></svg>
        </div>
    </div>
</div>

<div class="doc-section">
    <div class="doc-content">
        __CONTENT_HTML__
    </div>
</div>

<div id="tooltip" class="tooltip"></div>

<script>
    mermaid.initialize({ startOnLoad: true });

    const timelineData = __TIMELINE_JSON__;
    const PX_PER_MS = 2.0; 
    const ROW_H = 28;
    const SLICE_H = 18;
    const RULER_H = 30;

    function initUI() {
        if (!timelineData || !timelineData.events) return;
        
        const sidebar = document.getElementById('sidebar');
        const canvas = document.getElementById('canvas');
        const ruler = document.getElementById('ruler');
        const svg = document.getElementById('flow-svg');
        const legend = document.getElementById('legend');

        // 1. Establish participants and tracks
        const trackY = {};
        const participants = timelineData.participants;
        participants.forEach((p, i) => {
            const y = i * ROW_H;
            trackY[p.id] = y;

            const nameDiv = document.createElement('div');
            nameDiv.className = 'track-name';
            nameDiv.textContent = p.name || p.id;
            sidebar.appendChild(nameDiv);
        });

        // Sync Sidebar vertical scroll with Viewport
        viewport.onscroll = () => {
            sidebar.scrollTop = viewport.scrollTop;
            ruler.style.left = -viewport.scrollLeft + 'px';
        };

        // 2. Scale canvas
        let maxT = 0;
        timelineData.events.forEach(e => {
            const t = e.end || e.time || 0;
            if (t > maxT) maxT = t;
        });
        maxT += 100;
        const totalW = maxT * PX_PER_MS;
        const totalH = participants.length * ROW_H;

        canvas.style.width = totalW + 'px';
        canvas.style.height = totalH + 'px';
        ruler.style.width = totalW + 'px';
        svg.setAttribute('viewBox', `0 0 ${totalW} ${totalH}`);

        // 3. Ruler Ticks
        for (let t = 0; t <= maxT; t += 50) {
            const tick = document.createElement('div');
            tick.className = 'ruler-tick';
            tick.style.left = (t * PX_PER_MS) + 'px';
            tick.textContent = t + 'ms';
            ruler.appendChild(tick);
        }

        // 4. Arrow Marker for SVG
        svg.innerHTML = `
            <defs>
                <marker id="arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(255,255,255,0.4)" />
                </marker>
            </defs>
        `;

        // 5. Render Events
        timelineData.events.forEach((ev, idx) => {
            const x = (ev.start || ev.time) * PX_PER_MS;
            
            if (ev.type === 'slice') {
                const w = Math.max((ev.end - ev.start) * PX_PER_MS, 4);
                const s = document.createElement('div');
                s.className = 'slice';
                s.style.left = x + 'px';
                s.style.width = w + 'px';
                s.style.top = (trackY[ev.track] + (ROW_H-SLICE_H)/2) + 'px';
                s.style.backgroundColor = ev.color;
                s.textContent = ev.label;
                s.id = 'slice-' + idx;

                s.onmouseenter = () => highlightFlows(idx, true, ev);
                s.onmouseleave = () => highlightFlows(idx, false);
                canvas.appendChild(s);
            }
            else if (ev.type === 'flow') {
                // DON'T draw flow if src == dst (Self call)
                if (ev.src === ev.dst) return;

                const y1 = trackY[ev.src] + ROW_H/2;
                const x1 = x;
                const y2 = trackY[ev.dst] + ROW_H/2;
                const x2 = ev.endTime * PX_PER_MS;

                const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                path.setAttribute("d", `M ${x1} ${y1} C ${x1 + 30} ${y1}, ${x2 - 30} ${y2}, ${x2} ${y2}`);
                path.setAttribute("class", "flow-line");
                path.setAttribute("stroke", ev.color || "#8ab4f8");
                path.setAttribute("fill", "none"); // CRITICAL FIX
                path.setAttribute("marker-end", "url(#arrowhead)");
                path.id = 'flow-' + idx;
                svg.appendChild(path);
            }
            else if (ev.type === 'vsync') {
                const g = document.createElement('div');
                g.className = 'vsync-guide';
                g.style.left = x + 'px';
                canvas.appendChild(g);
            }
        });
    }

    const tooltip = document.getElementById('tooltip');
    function highlightFlows(idx, active, data) {
        if (active) {
            tooltip.style.display = 'block';
            tooltip.innerHTML = `<strong>${data.label}</strong><br>Dur: ${(data.end-data.start).toFixed(1)}ms`;
        } else {
            tooltip.style.display = 'none';
        }

        // Logic to highlight connected flows? 
        // For now just show duration
    }

    document.addEventListener('mousemove', e => {
        if (tooltip.style.display === 'block') {
            tooltip.style.left = (e.clientX + 15) + 'px';
            tooltip.style.top = (e.clientY + 15) + 'px';
        }
    });

    initUI();
</script>
</body>
</html>
"""

def parse_markdown_to_html(md_content, filename):
    # Standard splitting of blocks
    lines = md_content.split('\n')
    html_out = []
    
    in_code = False
    in_mermaid = False
    in_seq = False
    mermaid_buf = []
    perfetto_json = None
    
    for line in lines:
        s = line.strip()
        if s.startswith('```'):
            if in_code:
                if in_mermaid:
                    src = "\n".join(mermaid_buf)
                    if in_seq:
                        perfetto_json = parse_sequence(src)
                        # We don't inject UI here anymore, we do it at the top __TIMELINE__ placeholder
                    else:
                        html_out.append(f'<div class="mermaid">{src}</div>')
                else:
                    html_out.append('</code></pre>')
                in_code = False; in_mermaid = False; in_seq = False
            else:
                in_code = True
                if 'mermaid' in line:
                    in_mermaid = True; mermaid_buf = []
                else:
                    html_out.append('<pre><code>')
            continue
            
        if in_code:
            if in_mermaid:
                mermaid_buf.append(line)
                if s.startswith('sequenceDiagram'): in_seq = True
            else:
                html_out.append(line.replace('<','&lt;').replace('>','&gt;'))
            continue
            
        # Very simple MD to HTML for the content section
        if s.startswith('# '): html_out.append(f'<h1>{s[2:]}</h1>')
        elif s.startswith('## '): html_out.append(f'<h2>{s[3:]}</h2>')
        elif s.startswith('### '): html_out.append(f'<h3>{s[4:]}</h3>')
        elif s == '---': html_out.append('<hr>')
        elif s.startswith('* '): html_out.append(f'<li>{s[2:]}</li>')
        elif s == '': html_out.append('<br>')
        else:
            line = re.sub(r'\*\*(.*?)\*\*', r'<b>\1</b>', line)
            line = re.sub(r'`(.*?)`', r'<code>\1</code>', line)
            html_out.append(f'<p>{line}</p>')
            
    return "\n".join(html_out), perfetto_json

def parse_sequence(src):
    lines = src.split('\n')
    participants = []
    events = []
    
    time = 20
    stacks = {} # track -> {start, label}
    
    # Pre-parse participants for proper order and names
    for line in lines:
        line = line.strip()
        m = re.match(r'participant\s+(\w+)(?:\s+as\s+(.*))?', line)
        if m:
            alias, name = m.groups()
            participants.append({"id": alias, "name": name or alias})
            
    # Main loop
    for line in lines:
        line = line.strip()
        if not line or line.startswith('%%') or line.startswith('sequenceDiagram') or line.startswith('participant'):
            continue
            
        # 1. Activation
        m_act = re.match(r'activate\s+(\w+)', line)
        if m_act:
            t = m_act.group(1)
            # Fetch name from last flow to B
            label = "Active"
            for e in reversed(events):
                if e['type'] == 'flow' and e['dst'] == t:
                    label = e['label']; break
            stacks[t] = {"start": time, "label": label}
            continue
            
        # 2. Deactivation
        m_deact = re.match(r'deactivate\s+(\w+)', line)
        if m_deact:
            t = m_deact.group(1)
            if t in stacks:
                d = stacks[t]
                end = time + 20
                events.append({
                    "type": "slice", "track": t, 
                    "start": d['start'], "end": end, 
                    "label": d['label'], "color": get_pro_color(t)
                })
                time = end + 10
                del stacks[t]
            continue
            
        # 3. Message
        m_msg = re.match(r'(\w+)(?:->|->>|-->>|-->)(\w+)\s*:\s*(.*)', line)
        if m_msg:
            src, dst, msg = m_msg.groups()
            
            if "vsync" in msg.lower():
                time = (int(time/300)+1)*300
                events.append({"type": "vsync", "time": time})
            
            events.append({
                "type": "flow", "src": src, "dst": dst,
                "time": time, "endTime": time + 30, "label": msg,
                "color": "rgba(255,255,255,0.2)"
            })
            time += 35
            
            # Simple self-call slice
            if src == dst:
                events.append({
                    "type": "slice", "track": src,
                    "start": time - 35, "end": time - 5,
                    "label": msg, "color": get_pro_color(src)
                })
            continue

    return {"participants": participants, "events": events}

def main():
    if not os.path.exists(OUTPUT_DIR): os.makedirs(OUTPUT_DIR)
    
    for md in glob.glob(os.path.join(SOURCE_DIR, "*.md")):
        name = os.path.basename(md)
        if name == "index.md": continue
        
        print(f"Baking V4 Professional: {name}")
        with open(md, 'r') as f: content = f.read()
        
        html, json_data = parse_markdown_to_html(content, name)
        
        title = name
        m = re.search(r'# (.*)', content)
        if m: title = m.group(1)
        
        # Inject
        final = TEMPLATE.replace('__TITLE__', title)\
                        .replace('__CONTENT_HTML__', html)\
                        .replace('__TIMELINE_JSON__', json.dumps(json_data) if json_data else "{}")
                        
        with open(os.path.join(OUTPUT_DIR, name.replace(".md", ".html")), 'w') as f:
            f.write(final)

if __name__ == "__main__": main()
