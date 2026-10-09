import cytoscape from "cytoscape";
import type { Core, NodeSingular, StylesheetJson } from "cytoscape";
import type { FamilyGraph } from "../../../shared/familyContracts.js";

import type { LexicalGraph } from "../../../shared/lexicalContracts.js";
type CanvasGraph = FamilyGraph | LexicalGraph;
const nodeId = (n: CanvasGraph["nodes"][number]) => "node_id" in n ? n.node_id : n.lexeme_id;

export interface FamilyEngine {
  update(graph: CanvasGraph): void; destroy(): void; fit(): void;
}
export type FamilyEngineFactory = (container: HTMLElement, graph: CanvasGraph, callbacks: {
  select(id: string): void; recenter(id: string): void; candidate(id: string): void;
}) => FamilyEngine;
declare global { interface Window { WordLoopFamilyEngine?: FamilyEngineFactory } }

function familyStyle(container: HTMLElement): StylesheetJson {
  const theme = getComputedStyle(container);
  const color = (name: string) => theme.getPropertyValue(name).trim();
  return [
    // A typographic index, not a cloud of circles. Shape still exposes a generous tap area.
    { selector: "node", style: { label: "data(label)", width: "data(size)", height: 42,
      shape: "rectangle", "font-family": "Georgia, serif", "font-size": 14,
      color: color("--text"), "background-color": color("--control"), "border-width": 1,
      "border-color": color("--separator-strong"), "text-valign": "center", "text-halign": "center",
      "text-wrap": "ellipsis", "text-max-width": "100px" } },
    { selector: "node.unlearned", style: { "background-color": color("--material-raised"), "border-style": "dashed" } },
    { selector: "node.center", style: { "background-color": color("--accent"), color: color("--accent-text"),
      "border-width": 2, "border-color": color("--accent"), "font-weight": "bold", "font-size": 17 } },
    { selector: "node.selected", style: { "border-color": color("--accent"), "border-width": 3 } },
    { selector: "edge", style: { width: 1.2, "line-color": color("--separator-strong"), "curve-style": "bezier", "target-arrow-shape": "none" } },
    { selector: "node.etymon", style: { "font-size": 11, "text-wrap": "wrap", "text-max-width": "106px",
      shape: "rectangle", "border-style": "double", width: 120, height: 52 } },
    { selector: "node.pattern", style: { shape: "rectangle", width: 120, height: 42,
      "text-wrap": "wrap", "text-max-width": "106px" } },
    { selector: "node.morpheme", style: { shape: "rectangle" } },
    { selector: "edge.forward", style: { "target-arrow-shape": "triangle", "arrow-scale": .7, "target-arrow-color": color("--separator-strong") } },
    { selector: "edge.shared, edge.synonym", style: { "line-style": "dotted" } },
    { selector: "edge.contrast, edge.confusable, edge.antonym", style: { "line-style": "dashed", "line-color": color("--accent") } },
    { selector: "edge.collocation", style: { "line-style": "dashed" } },
    { selector: ".low-label", style: { label: "" } },
    { selector: "edge.low-confidence", style: { display: "none" } },
  ];
}

const createEngine: FamilyEngineFactory = (container, initial, callbacks) => {
  let graph = initial;
  const saved = new Map<string, { x: number; y: number }>();
  try { for (const [id, point] of Object.entries(JSON.parse(localStorage.getItem("wordloop_family_positions_v1") ?? "{}"))) {
    const p = point as { x?: number; y?: number };
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) saved.set(id, p as { x: number; y: number });
  } } catch { /* Storage is optional. */ }
  const cy: Core = cytoscape({ container, elements: [], layout: { name: "preset" }, minZoom: .3, maxZoom: 2.5,
    boxSelectionEnabled: false, autounselectify: true,
    style: familyStyle(container),
  });
  const positionKey = (id: string) => `${"view" in graph ? graph.view : "family"}|${nodeId(graph.center)}|${id}`;
  const update = (next: CanvasGraph) => {
    const recentered = nodeId(graph.center) !== nodeId(next.center);
    graph = next;
    cy.batch(() => {
      cy.elements().remove();
      const others = graph.nodes.filter((n) => nodeId(n) !== nodeId(graph.center));
      graph.nodes.forEach((n) => {
        const index = others.findIndex((o) => nodeId(o) === nodeId(n)), center = index < 0;
        const kind = "node_type" in n ? n.node_type : "lexeme", priority = "priority" in n ? n.priority : .65;
        // Stable, bounded concentric indexes: up to eight editorial word labels per ring.
        // No physics layout, extra graph traversal or new persistence.
        const ring = Math.floor(Math.max(0, index) / 8);
        const slot = Math.max(0, index) % 8;
        const ringCount = Math.min(8, Math.max(1, others.length - ring * 8));
        const theta = (slot / ringCount) * Math.PI * 2 - Math.PI / 2 + ring * 0.12;
        const radius = Math.max(158, Math.min(202, container.clientWidth * .39)) + ring * 112;
        const point = center ? { x: 0, y: 0 } : { x: radius * Math.cos(theta), y: radius * Math.sin(theta) };
        cy.add({ group: "nodes", data: { id: nodeId(n), label: kind === "etymon" ? `${n.lemma} · ${"language" in n ? n.language : ""}` : n.lemma, size: center ? 130 : 116, priority }, position: center ? point : saved.get(positionKey(nodeId(n))) ?? point, classes: `${center ? "center" : ""} ${kind} ${"user_state" in n && !n.user_state && !center ? "unlearned" : ""}` });
      });
      graph.edges.forEach((e) => cy.add({ group: "edges", data: { id: e.relation_id, source: e.source_id, target: e.target_id, confidence: e.confidence }, classes: `${e.direction === "forward" ? "forward" : ""} ${e.relation_type === "SHARED_ETYMON" ? "shared" : e.relation_type.toLowerCase()}` }));
    });
    // Bounded, O(n) radial positions: no iterative layout or main-thread physics.
    cy.stop();
    if (recentered && !matchMedia("(prefers-reduced-motion: reduce)").matches) cy.animate({ fit: { eles: cy.elements(), padding: 28 } }, { duration: 180 });
    else cy.fit(undefined, 28);
  };
  let lastTap = { id: "", at: 0 };
  cy.on("tap", "node", (event) => {
    const id = event.target.id(), now = Date.now();
    cy.nodes().removeClass("selected"); event.target.addClass("selected");
    if (lastTap.id === id && now - lastTap.at < 320) { callbacks.recenter(id); lastTap = { id: "", at: 0 }; }
    else { callbacks.select(id); lastTap = { id, at: now }; }
  });
  cy.on("taphold cxttap", "node", (event) => { if (graph.nodes.some(n => nodeId(n) === event.target.id() && (!("node_type" in n) || n.node_type === "lexeme"))) callbacks.candidate(event.target.id()); });
  cy.on("dragfree", "node", (event) => {
    const node = event.target as NodeSingular;
    if (node.id() === nodeId(graph.center)) { node.position({ x: 0, y: 0 }); return; }
    saved.set(positionKey(node.id()), node.position());
    try { localStorage.setItem("wordloop_family_positions_v1", JSON.stringify(Object.fromEntries([...saved].slice(-160)))); } catch { /* optional */ }
  });
  cy.on("zoom", () => {
    cy.nodes().forEach((node) => { node.toggleClass("low-label", cy.zoom() < .55 && node.data("priority") < .65 && node.id() !== nodeId(graph.center)); });
    cy.edges().forEach((edge) => { edge.toggleClass("low-confidence", cy.zoom() < .55 && edge.data("confidence") < .9); });
  });
  const resize = new ResizeObserver(() => { cy.resize(); cy.fit(undefined, 28); });
  const refreshTheme = () => { cy.style(familyStyle(container)); };
  const appearance = new MutationObserver(refreshTheme);
  appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const scheme = matchMedia("(prefers-color-scheme: dark)"); scheme.addEventListener("change", refreshTheme);
  resize.observe(container); update(initial);
  return { update, fit: () => cy.fit(undefined, 28), destroy: () => { resize.disconnect(); appearance.disconnect(); scheme.removeEventListener("change", refreshTheme); cy.destroy(); } };
};
window.WordLoopFamilyEngine = createEngine;
