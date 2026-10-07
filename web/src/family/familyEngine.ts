import cytoscape from "cytoscape";
import type { Core, NodeSingular, StylesheetJson } from "cytoscape";
import type { FamilyGraph } from "../../../shared/familyContracts.js";

export interface FamilyEngine {
  update(graph: FamilyGraph): void; destroy(): void; fit(): void;
}
export type FamilyEngineFactory = (container: HTMLElement, graph: FamilyGraph, callbacks: {
  select(id: string): void; recenter(id: string): void; candidate(id: string): void;
}) => FamilyEngine;
declare global { interface Window { WordLoopFamilyEngine?: FamilyEngineFactory } }

function familyStyle(container: HTMLElement): StylesheetJson {
  const theme = getComputedStyle(container);
  const color = (name: string) => theme.getPropertyValue(name).trim();
  return [
    { selector: "node", style: { label: "data(label)", width: "data(size)", height: "data(size)", "font-family": theme.fontFamily, "font-size": 14,
      color: color("--text"), "background-color": color("--control-hover"), "border-width": 1.5, "border-color": color("--muted"),
      "text-valign": "bottom", "text-margin-y": 8, "text-background-color": color("--material-solid"), "text-background-opacity": .95, "text-background-padding": "3px" } },
    { selector: "node.unlearned", style: { "background-color": color("--material-raised"), "border-style": "dashed" } },
    { selector: "node.center", style: { "background-color": color("--accent"), "border-width": 4, "border-color": color("--control-hover"), "font-weight": "bold", "font-size": 16 } },
    { selector: "node.selected", style: { "border-color": color("--accent"), "border-width": 3 } },
    { selector: "edge", style: { width: 1.5, "line-color": color("--separator-strong"), "curve-style": "bezier", "target-arrow-shape": "none" } },
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
  const positionKey = (id: string) => `${graph.center.lexeme_id}|${id}`;
  const update = (next: FamilyGraph) => {
    const recentered = graph.center.lexeme_id !== next.center.lexeme_id;
    graph = next;
    cy.batch(() => {
      cy.elements().remove();
      const others = graph.nodes.filter((n) => n.lexeme_id !== graph.center.lexeme_id);
      graph.nodes.forEach((n) => {
        const index = others.findIndex((o) => o.lexeme_id === n.lexeme_id), center = index < 0;
        const radius = Math.min(others.length > 8 ? 180 : 135, Math.max(65, container.clientWidth / 2 - 65));
        const point = center ? { x: 0, y: 0 } : { x: radius * Math.cos(index / Math.max(1, others.length) * Math.PI * 2), y: radius * Math.sin(index / Math.max(1, others.length) * Math.PI * 2) };
        cy.add({ group: "nodes", data: { id: n.lexeme_id, label: n.lemma, size: center ? 52 : 24 + n.priority * 14, priority: n.priority }, position: center ? point : saved.get(positionKey(n.lexeme_id)) ?? point, classes: `${center ? "center" : ""} ${!n.user_state && !center ? "unlearned" : ""}` });
      });
      graph.edges.forEach((e) => cy.add({ group: "edges", data: { id: e.relation_id, source: e.source_id, target: e.target_id, confidence: e.confidence } }));
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
  cy.on("taphold cxttap", "node", (event) => callbacks.candidate(event.target.id()));
  cy.on("dragfree", "node", (event) => {
    const node = event.target as NodeSingular;
    if (node.id() === graph.center.lexeme_id) { node.position({ x: 0, y: 0 }); return; }
    saved.set(positionKey(node.id()), node.position());
    try { localStorage.setItem("wordloop_family_positions_v1", JSON.stringify(Object.fromEntries([...saved].slice(-160)))); } catch { /* optional */ }
  });
  cy.on("zoom", () => {
    cy.nodes().forEach((node) => { node.toggleClass("low-label", cy.zoom() < .55 && node.data("priority") < .65 && node.id() !== graph.center.lexeme_id); });
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
