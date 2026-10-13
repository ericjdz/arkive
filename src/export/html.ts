import { whyDoesThisExist } from "../io/decisions.js";
import type {
  GraphDecision,
  GraphEdge,
  GraphNode,
} from "../schema/graph.js";

/**
 * Single-file, build-free viewer artifact (ADR-0004, option b).
 *
 * Pure generator: graph in, one self-contained HTML string out. Layout is
 * computed HERE, not in the browser — a deterministic layered placement
 * (depth by dependency distance, node-id order for stability) emitted as
 * absolute coordinates plus inline SVG edge paths. The browser only pans,
 * zooms, filters, and selects.
 *
 * Targets: 0 runtime dependencies, no build step, ≤150 KB uncompressed for
 * a fixture-scale graph, 0 external requests (no src/href to anything but
 * a fragment, no fetch, no link, no script src).
 *
 * Scope: topology render + node selection panel (kind, inbound/outbound
 * edges grouped by kind, data shapes, decided_by decisions with provenance
 * gate/evidence/caveats per the frozen walkthrough contract) + text filter
 * over names + deep links by node id (?node=<id>). NOT in scope: prompt
 * queue, learning, editing, decision authoring.
 */

/** Minimal graph shape the generator reads. `ArchitectureDocument` satisfies it. */
export interface HtmlExportGraph {
  project: { name: string; description: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
  decisions: GraphDecision[];
}

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  depth: number;
}

export const LAYOUT = {
  nodeWidth: 200,
  nodeHeight: 64,
  gapX: 120,
  gapY: 48,
  pad: 40,
} as const;

const STORABLE_KINDS: ReadonlySet<string> = new Set([
  "imports",
  "calls",
  "reads",
  "writes",
  "derives_from",
]);

const SHAPE_KINDS: ReadonlySet<string> = new Set(["reads", "writes", "derives_from"]);

const KIND_ORDER = ["imports", "calls", "reads", "writes", "derives_from"] as const;

/**
 * Deterministic layered layout.
 *
 * Depth is the longest directed path distance over storable edges, found by
 * repeated relaxation (bounded by node count, so cycles terminate with a
 * stable answer rather than looping). Ties — initial order, layer order,
 * edge order — all break by node/edge id, so two runs over an unchanged
 * document produce byte-identical coordinates.
 */
export function computeLayeredLayout(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Map<string, PlacedNode> {
  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const live = new Set(sorted.map((node) => node.id));
  const depth = new Map<string, number>(sorted.map((node) => [node.id, 0]));
  const directed = edges
    .filter(
      (edge) =>
        STORABLE_KINDS.has(edge.kind) && live.has(edge.from) && live.has(edge.to)
    )
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (let pass = 0; pass < sorted.length; pass++) {
    let changed = false;
    for (const edge of directed) {
      const candidate = (depth.get(edge.from) ?? 0) + 1;
      if (candidate > (depth.get(edge.to) ?? 0)) {
        depth.set(edge.to, candidate);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Longest-path distances are unbounded when the graph has a dependency
  // cycle, so clamp to (nodes - 1): every layer below that is reachable
  // without revisiting a node, and coordinates stay finite either way.
  for (const [id, d] of depth) {
    if (d > sorted.length - 1) depth.set(id, sorted.length - 1);
  }
  const layers = new Map<number, GraphNode[]>();
  for (const node of sorted) {
    const d = depth.get(node.id) ?? 0;
    layers.set(d, [...(layers.get(d) ?? []), node]);
  }

  const placed = new Map<string, PlacedNode>();
  for (const [d, members] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    members.forEach((node, index) => {
      placed.set(node.id, {
        id: node.id,
        x: LAYOUT.pad + d * (LAYOUT.nodeWidth + LAYOUT.gapX),
        y: LAYOUT.pad + index * (LAYOUT.nodeHeight + LAYOUT.gapY),
        depth: d,
      });
    });
  }
  return placed;
}

/** Straight cubic from the source box's right edge to the target's left edge. */
export function edgePath(
  from: PlacedNode,
  to: PlacedNode
): string {
  const x1 = from.x + LAYOUT.nodeWidth;
  const y1 = from.y + LAYOUT.nodeHeight / 2;
  const x2 = to.x;
  const y2 = to.y + LAYOUT.nodeHeight / 2;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

interface EdgeRef {
  id: string;
  other: string;
  otherName: string;
  label?: string;
}

interface DecisionView {
  id: string;
  topic: string;
  decision: string;
  rationale: string;
  alternatives: Array<{ name: string; whyNot: string }>;
  observation: boolean;
  via: string;
  gate: string;
  evidence: string[];
  caveats: string[];
  recordedBy: string | null;
}

interface NodeView {
  id: string;
  kind: string;
  name: string;
  summary: string;
  path: string | null;
  live: boolean;
  gate: string;
  evidence: string[];
  x: number;
  y: number;
  depth: number;
  inbound: Record<string, EdgeRef[]>;
  outbound: Record<string, EdgeRef[]>;
  shapes: Array<{ id: string; name: string }>;
  decisions: DecisionView[];
}

function emptyGroups(): Record<string, EdgeRef[]> {
  return { imports: [], calls: [], reads: [], writes: [], derives_from: [] };
}

function buildNodeViews(graph: HtmlExportGraph): NodeView[] {
  const placed = computeLayeredLayout(graph.nodes, graph.edges);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const sortedNodes = [...graph.nodes].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );

  return sortedNodes.map((node) => {
    const at = placed.get(node.id) ?? { x: LAYOUT.pad, y: LAYOUT.pad, depth: 0 };
    const inbound = emptyGroups();
    const outbound = emptyGroups();
    const shapeIds = new Set<string>();

    const stored = graph.edges
      .filter((edge) => STORABLE_KINDS.has(edge.kind))
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const edge of stored) {
      if (edge.to === node.id && byId.has(edge.from)) {
        const other = byId.get(edge.from)!;
        inbound[edge.kind]?.push({
          id: edge.id,
          other: other.id,
          otherName: other.name,
          ...(edge.label === undefined ? {} : { label: edge.label }),
        });
      }
      if (edge.from === node.id && byId.has(edge.to)) {
        const other = byId.get(edge.to)!;
        outbound[edge.kind]?.push({
          id: edge.id,
          other: other.id,
          otherName: other.name,
          ...(edge.label === undefined ? {} : { label: edge.label }),
        });
      }
      if (
        SHAPE_KINDS.has(edge.kind) &&
        (edge.from === node.id || edge.to === node.id)
      ) {
        const otherId = edge.from === node.id ? edge.to : edge.from;
        const other = byId.get(otherId);
        if (other !== undefined && other.kind === "datastructure" && other.id !== node.id) {
          shapeIds.add(other.id);
        }
      }
    }

    const shapes = [...shapeIds]
      .sort()
      .map((id) => ({ id, name: byId.get(id)?.name ?? id }));

    // Decisions via the decided_by projection (computed, never stored):
    // direct, inherited, and incident claims, each carrying the provenance
    // gate, evidence, and caveats the frozen contract requires.
    const why = whyDoesThisExist(graph, node.id);
    const decisions: DecisionView[] = why.claims.map((claim) => ({
      id: claim.decision.id,
      topic: claim.decision.topic,
      decision: claim.decision.decision,
      rationale: claim.decision.rationale,
      alternatives: claim.decision.alternatives.map((alternative) => ({
        name: alternative.name,
        whyNot: alternative.whyNot,
      })),
      observation: claim.observation,
      via: claim.claim.via,
      gate: claim.claim.gate,
      evidence: [...claim.claim.provenance.evidence],
      caveats: [...claim.claim.caveats],
      recordedBy: claim.claim.provenance.recorded?.authoredBy ?? null,
    }));

    return {
      id: node.id,
      kind: node.kind,
      name: node.name,
      summary: node.summary,
      path: node.path ?? null,
      live: node.deletedAt === undefined,
      gate: node.provenance.derived === true ? "derived" : "authored",
      evidence:
        node.provenance.derived === true ? [...node.provenance.evidence] : [],
      x: at.x,
      y: at.y,
      depth: at.depth,
      inbound,
      outbound,
      shapes,
      decisions,
    };
  });
}

function renderSvg(nodes: NodeView[], graph: HtmlExportGraph): { body: string; width: number; height: number } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const maxX = nodes.reduce((m, n) => Math.max(m, n.x), 0);
  const maxY = nodes.reduce((m, n) => Math.max(m, n.y), 0);
  const width = maxX + LAYOUT.nodeWidth + LAYOUT.pad;
  const height = Math.max(maxY + LAYOUT.nodeHeight + LAYOUT.pad, 200);

  const edgeEls: string[] = [];
  const drawn = graph.edges
    .filter((edge) => STORABLE_KINDS.has(edge.kind))
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const edge of drawn) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const d = edgePath(from, to);
    edgeEls.push(
      `<path class="edge edge-${escapeHtml(edge.kind)}" data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}" d="${d}"><title>${escapeHtml(edge.from)} --${edge.kind}--&gt; ${escapeHtml(edge.to)}</title></path>`
    );
  }

  const nodeEls: string[] = [];
  for (const node of nodes) {
    const label = truncate(node.name, 24);
    nodeEls.push(
      `<g class="node kind-${escapeHtml(node.kind)}${node.live ? "" : " tombstoned"}" data-id="${escapeHtml(node.id)}" data-name="${escapeHtml(node.name.toLowerCase())} ${escapeHtml(node.id.toLowerCase())}" tabindex="0" role="button" transform="translate(${node.x} ${node.y})">` +
        `<title>${escapeHtml(node.name)} (${escapeHtml(node.kind)})</title>` +
        `<rect width="${LAYOUT.nodeWidth}" height="${LAYOUT.nodeHeight}" rx="8"></rect>` +
        `<text class="node-name" x="12" y="26">${escapeHtml(label)}</text>` +
        `<text class="node-kind" x="12" y="46">${escapeHtml(node.kind)}${node.live ? "" : " · removed"}</text>` +
        `</g>`
    );
  }

  return {
    body:
      `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z"></path></marker></defs>` +
      `<g id="world"><g id="edges">${edgeEls.join("")}</g><g id="nodes">${nodeEls.join("")}</g></g>`,
    width,
    height,
  };
}

const CSS = [
  ":root{color-scheme:light dark}",
  "body{font-family:system-ui,-apple-system,sans-serif;margin:0;display:flex;flex-direction:column;height:100vh}",
  "header{padding:12px 16px;border-bottom:1px solid #ccc;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}",
  "header h1{font-size:18px;margin:0}",
  "header p{margin:0;color:#666;font-size:13px}",
  "#filter{margin-left:auto;padding:6px 10px;font-size:14px;min-width:220px}",
  "#count{font-size:13px;color:#666}",
  "main{flex:1;display:flex;min-height:0}",
  "#viewport{flex:1;overflow:hidden;background:#fafafa;cursor:grab}",
  "#viewport:active{cursor:grabbing}",
  "svg#graph{width:100%;height:100%}",
  ".edge{fill:none;stroke:#999;stroke-width:1.5;marker-end:url(#arrow)}",
  ".edge-calls{stroke:#2563eb}.edge-reads{stroke:#16a34a}.edge-writes{stroke:#dc2626}",
  ".edge-imports{stroke:#999}.edge-derives_from{stroke:#9333ea;stroke-dasharray:5 4}",
  "#arrow path{fill:#999}",
  ".node{cursor:pointer;outline:none}",
  ".node rect{fill:#fff;stroke:#333;stroke-width:1.5}",
  ".node text{fill:#111;font-size:13px;pointer-events:none}",
  ".node .node-kind{font-size:11px;fill:#666}",
  ".node.kind-service rect{stroke:#2563eb}.node.kind-datastore rect{stroke:#16a34a}",
  ".node.kind-external rect{stroke:#dc2626}.node.kind-datastructure rect{stroke:#9333ea}",
  ".node.kind-endpoint rect{stroke:#ea580c}",
  ".node.tombstoned{opacity:.45}.node.tombstoned rect{stroke-dasharray:5 4}",
  ".node.selected rect{stroke-width:3;stroke:#000}",
  ".node.hidden,.edge.hidden{display:none}",
  "aside#panel{width:360px;max-width:40vw;overflow-y:auto;border-left:1px solid #ccc;padding:16px;font-size:14px}",
  "aside#panel h2{font-size:16px;margin:0 0 4px}",
  "aside#panel .meta{color:#666;font-size:12px;margin-bottom:8px}",
  "aside#panel h3{font-size:13px;margin:16px 0 6px;text-transform:uppercase;letter-spacing:.04em;color:#444}",
  "aside#panel ul{margin:4px 0;padding-left:20px}",
  "aside#panel .gate{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;border:1px solid #666}",
  "aside#panel .gate-authored{background:#e8f5e9}aside#panel .gate-derived{background:#fff8e1}aside#panel .gate-unresolved{background:#ffebee}",
  "aside#panel .caveat{font-size:12px;color:#555;font-style:italic}",
  "aside#panel .decision{border:1px solid #ddd;border-radius:8px;padding:8px 10px;margin:8px 0}",
  "aside#panel table{border-collapse:collapse;font-size:12px;width:100%}",
  "aside#panel th,aside#panel td{border:1px solid #ddd;padding:3px 6px;text-align:left}",
  "aside#panel button.linklike{background:none;border:none;padding:0;color:#2563eb;cursor:pointer;font-size:inherit;text-align:left}",
].join("\n");

const BROWSER_JS = [
  "(function(){",
  "'use strict';",
  "var payload=JSON.parse(document.getElementById('arkive-data').textContent);",
  "var byId={};payload.nodes.forEach(function(n){byId[n.id]=n;});",
  "var svg=document.getElementById('graph'),world=document.getElementById('world'),",
  "panel=document.getElementById('panel'),filter=document.getElementById('filter'),",
  "count=document.getElementById('count');",
  "var nodeEls={},edgeEls=[];",
  "Array.prototype.forEach.call(svg.querySelectorAll('.node'),function(g){nodeEls[g.getAttribute('data-id')]=g;});",
  "Array.prototype.forEach.call(svg.querySelectorAll('.edge'),function(p){edgeEls.push(p);});",
  "function el(tag,text,cls){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}",
  "var scale=1,tx=0,ty=0;",
  "function apply(){world.setAttribute('transform','translate('+tx+' '+ty+') scale('+scale+')');}",
  "var drag=null;",
  "svg.addEventListener('pointerdown',function(e){drag={x:e.clientX,y:e.clientY,tx:tx,ty:ty};svg.setPointerCapture(e.pointerId);});",
  "svg.addEventListener('pointermove',function(e){if(!drag)return;tx=drag.tx+(e.clientX-drag.x);ty=drag.ty+(e.clientY-drag.y);apply();});",
  "svg.addEventListener('pointerup',function(){drag=null;});",
  "svg.addEventListener('wheel',function(e){e.preventDefault();var f=e.deltaY<0?1.15:1/1.15;scale=Math.min(4,Math.max(0.2,scale*f));apply();},{passive:false});",
  "function groupList(title,groups,dir){",
  "var wrap=el('div');wrap.appendChild(el('h3',title));",
  "var kinds=['imports','calls','reads','writes','derives_from'];var any=false;",
  "kinds.forEach(function(k){var items=groups[k]||[];if(!items.length)return;any=true;",
  "wrap.appendChild(el('h3',k+' ('+items.length+')'));",
  "var ul=el('ul');",
  "items.forEach(function(it){var li=el('li');var b=el('button',it.otherName+'  ('+it.other+')','linklike');",
  "b.addEventListener('click',function(){select(it.other,true);});li.appendChild(b);",
  "if(it.label)li.appendChild(document.createTextNode(' — '+it.label));",
  "ul.appendChild(li);});wrap.appendChild(ul);});",
  "if(!any)wrap.appendChild(el('p','None.'));return wrap;}",
  "function renderPanel(n){",
  "panel.textContent='';",
  "panel.appendChild(el('h2',n.name));",
  "var meta=el('div',n.kind+' · '+n.id,'meta');panel.appendChild(meta);",
  "var gate=el('span','provenance: '+n.gate,'gate gate-'+n.gate);panel.appendChild(gate);",
  "if(!n.live)panel.appendChild(el('p','Removed (tombstoned). Its rationale survives by design.'));",
  "if(n.summary)panel.appendChild(el('p',n.summary));",
  "if(n.path)panel.appendChild(el('p','Path: '+n.path));",
  "if(n.evidence.length){panel.appendChild(el('h3','Evidence'));var eu=el('ul');",
  "n.evidence.forEach(function(s){eu.appendChild(el('li',s));});panel.appendChild(eu);}",
  "panel.appendChild(groupList('Inbound edges',n.inbound));",
  "panel.appendChild(groupList('Outbound edges',n.outbound));",
  "var sh=el('div');sh.appendChild(el('h3','Data shapes')); ",
  "if(!n.shapes.length)sh.appendChild(el('p','None.'));",
  "else{var su=el('ul');n.shapes.forEach(function(s){var li=el('li');var b=el('button',s.name+'  ('+s.id+')','linklike');",
  "b.addEventListener('click',function(){select(s.id,true);});li.appendChild(b);su.appendChild(li);});sh.appendChild(su);}",
  "panel.appendChild(sh);",
  "var dw=el('div');dw.appendChild(el('h3','Decisions ('+n.decisions.length+')'));",
  "if(!n.decisions.length)dw.appendChild(el('p','No decision is recorded against this node. Absence of a recorded reason is not evidence that there was none.'));",
  "n.decisions.forEach(function(d){var box=el('div',null,'decision');",
  "box.appendChild(el('h3',d.topic+' ('+d.via+', '+d.gate+')'));",
  "box.appendChild(el('p',d.decision));",
  "box.appendChild(el('p','Rationale: '+d.rationale));",
  "if(d.alternatives.length){var t=el('table');var hr=t.insertRow();hr.appendChild(el('th','Rejected'));hr.appendChild(el('th','Why not'));",
  "d.alternatives.forEach(function(a){var r=t.insertRow();r.insertCell().textContent=a.name;r.insertCell().textContent=a.whyNot;});box.appendChild(t);}",
  "if(d.observation)box.appendChild(el('p','Observation, not a decision: it names no rejected alternative with a reason.','caveat'));",
  "if(d.evidence.length)box.appendChild(el('p','Evidence: '+d.evidence.join(', '),'caveat'));",
  "d.caveats.forEach(function(c){box.appendChild(el('p',c,'caveat'));});",
  "if(d.recordedBy)box.appendChild(el('p','Recorded by '+d.recordedBy+'.','caveat'));",
  "dw.appendChild(box);});",
  "panel.appendChild(dw);}",
  "function select(id,push){var n=byId[id];if(!n)return;",
  "var prev=svg.querySelector('.node.selected');if(prev)prev.classList.remove('selected');",
  "var g=nodeEls[id];if(g){g.classList.add('selected');",
  "try{var r=g.getBoundingClientRect(),v=svg.getBoundingClientRect();",
  "tx+=v.left+v.width/2-(r.left+r.width/2);ty+=v.top+v.height/3-(r.top+r.height/2);apply();}catch(_){}}",
  "renderPanel(n);",
  "try{if(push!==false)history.replaceState(null,'','?node='+encodeURIComponent(id));}catch(_){}}",
  "svg.addEventListener('click',function(e){var g=e.target.closest?e.target.closest('.node'):null;",
  "if(g&&g.getAttribute('data-id'))select(g.getAttribute('data-id'));});",
  "svg.addEventListener('keydown',function(e){var g=e.target.closest?e.target.closest('.node'):null;",
  "if(g&&(e.key==='Enter'||e.key===' ')){e.preventDefault();select(g.getAttribute('data-id'));}});",
  "document.addEventListener('keydown',function(e){if(e.key==='Escape'){",
  "var prev=svg.querySelector('.node.selected');if(prev)prev.classList.remove('selected');",
  "panel.textContent='Select a node to see its details.';",
  "try{history.replaceState(null,'',location.pathname);}catch(_){}}});",
  "filter.addEventListener('input',function(){var q=filter.value.toLowerCase();var shown=0;",
  "payload.nodes.forEach(function(n){var hit=!q||n.name.toLowerCase().indexOf(q)!==-1||n.id.toLowerCase().indexOf(q)!==-1;",
  "var g=nodeEls[n.id];if(g){if(hit)g.classList.remove('hidden');else g.classList.add('hidden');}",
  "if(hit)shown++;});",
  "edgeEls.forEach(function(p){var a=p.getAttribute('data-from'),b=p.getAttribute('data-to');",
  "var ga=nodeEls[a],gb=nodeEls[b];",
  "var hide=(ga&&ga.classList.contains('hidden'))||(gb&&gb.classList.contains('hidden'));",
  "if(hide)p.classList.add('hidden');else p.classList.remove('hidden');});",
  "count.textContent=shown+' / '+payload.nodes.length+' nodes';});",
  "count.textContent=payload.nodes.length+' nodes';",
  "try{var initial=new URLSearchParams(location.search).get('node');",
  "if(initial&&byId[initial])select(initial,false);}catch(_){}",
  "apply();",
  "})();",
].join("\n");

/**
 * Render the whole artifact. Deterministic: same graph in, same bytes out
 * (nodes/edges sorted by id; JSON keys in insertion order of sorted builds).
 */
export function generateHtmlGraph(graph: HtmlExportGraph): string {
  const nodes = buildNodeViews(graph);
  const { body, width, height } = renderSvg(nodes, graph);

  // `<` is escaped so a `</script>` inside a summary or rationale cannot
  // break out of the data block. The file stays parseable HTML with the
  // node count assertable by a reader that never executes JS.
  const dataJson = JSON.stringify({
    project: graph.project.name,
    counts: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      decisions: graph.decisions.length,
    },
    nodes,
  }).replace(/</g, "\\u003c");

  const title = `arkive — ${graph.project.name}`;
  const countsLine = `${graph.nodes.length} nodes · ${graph.edges.length} edges · ${graph.decisions.length} decisions`;

  return (
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escapeHtml(title)}</title>\n<style>\n${CSS}\n</style>\n</head>\n<body>\n` +
    `<header><h1>${escapeHtml(title)}</h1><p>${escapeHtml(countsLine)} · generated by arkive export html</p>` +
    `<input id="filter" type="search" placeholder="Filter nodes by name or id" autocomplete="off">` +
    `<span id="count"></span></header>\n` +
    `<main><div id="viewport"><svg id="graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Architecture graph">${body}</svg></div>` +
    `<aside id="panel"><p>Select a node to see its details.</p></aside></main>\n` +
    `<!-- nodes:${graph.nodes.length} edges:${graph.edges.length} decisions:${graph.decisions.length} -->\n` +
    `<script type="application/json" id="arkive-data">${dataJson}</script>\n` +
    `<script>\n${BROWSER_JS}\n</script>\n</body>\n</html>\n`
  );
}
