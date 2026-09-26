import {
  normalizeLiveRegion,
  normalizePoliteness,
} from "./normalizeWireTokens.ts";
import type {
  WebHostAccessibilityAction,
  WebHostAccessibilityActionResponse,
  WebHostAccessibilityAnnouncement,
  WebHostAccessibilityNode,
} from "./WebHostSurfaceTransport.ts";

interface AccessibilityTreeMetrics {
  cellWidth: number;
  cellHeight: number;
}

interface AccessibilityTreePresentationOptions {
  synchronizeFocus?: boolean;
  actionResponse?: WebHostAccessibilityActionResponse;
}

interface RoleMapping {
  role?: string;
  level?: number;
}

export class AccessibilityTreeMounter {
  readonly element: HTMLElement;
  readonly announcerElement: HTMLElement;
  // Also unique when independent bundles each include a copy of the runtime.
  private readonly domIdentity = Array.from(
    crypto.getRandomValues(new Uint32Array(4)),
    (part) => part.toString(16),
  ).join("-");

  private nodesById = new Map<string, HTMLElement>();
  private previousLabelsById = new Map<string, string>();
  private hasLiveRegionBaseline = false;

  private modelsById = new Map<string, WebHostAccessibilityNode>();
  private presenting = false;
  private nextRequestID = 0n;
  private acknowledgedRequestID = 0n;
  private pendingValues = new Map<string, bigint>();
  private pendingFocus?: { id: string; requestID: bigint };
  private runtimeFocusedElement?: HTMLElement;
  private readonly compositionCommits = new WeakMap<HTMLElement, string>();

  constructor(
    private readonly sendAction?: (
      target: string,
      request: WebHostAccessibilityAction,
      requestID: string,
    ) => void,
  ) {
    this.element = document.createElement("div");
    this.element.className = "webhost-scene__accessibility-tree";
    // Assistive focus outlines use these elements' real bounds. Hide only
    // their paint, preserving the full scene geometry and semantic hierarchy.
    this.element.style.position = "absolute";
    this.element.style.inset = "0";
    this.element.style.opacity = "0";
    this.element.style.pointerEvents = "none";

    this.announcerElement = document.createElement("div");
    this.announcerElement.className = "webhost-scene__accessibility-announcer";
    this.announcerElement.setAttribute("aria-atomic", "true");
    applyScreenReaderOnlyStyle(this.announcerElement);
  }

  present(
    nodes: WebHostAccessibilityNode[],
    metrics: AccessibilityTreeMetrics,
    announcements: WebHostAccessibilityAnnouncement[] = [],
    options: AccessibilityTreePresentationOptions = {},
  ): void {
    const activeBeforePresentation = document.activeElement;
    // Nodes the app marked hidden stay out of the assistive-technology tree,
    // mirroring the Android host's overlay filter. Hidden is per-node on the
    // wire, so children of a hidden node re-parent to the mount root.
    const visibleNodes = nodes
      .filter((node) => !node.hidden)
      .map((node) => ({
        ...node,
        liveRegion: normalizeLiveRegion(node.liveRegion),
      }));
    const normalizedAnnouncements = announcements.map((announcement) => ({
      ...announcement,
      politeness: normalizePoliteness(announcement.politeness),
    }));
    this.presenting = true;
    if (options.actionResponse) {
      const acknowledged = BigInt(options.actionResponse.requestID);
      if (acknowledged > this.acknowledgedRequestID)
        this.acknowledgedRequestID = acknowledged;
    }
    const previousById = this.nodesById;
    const nextById = new Map<string, HTMLElement>();
    const modelsById = new Map(visibleNodes.map((node) => [node.id, node]));

    for (const node of visibleNodes) {
      const existing = previousById.get(node.id);
      const tag = this.elementTag(node);
      const previousModel = this.modelsById.get(node.id);
      const reusable =
        existing?.tagName.toLowerCase() === tag &&
        previousModel?.actionTarget === node.actionTarget;
      const element = reusable ? existing : this.createElement(node, tag);
      if (!reusable) {
        if (existing) this.clearEditable(existing);
        existing?.remove();
        this.pendingValues.delete(node.id);
        if (this.pendingFocus?.id === node.id) this.pendingFocus = undefined;
      }
      this.applyNodeAttributes(
        element,
        node,
        metrics,
        node.parentId ? modelsById.get(node.parentId) : undefined,
      );
      nextById.set(node.id, element);
    }

    for (const id of previousById.keys()) {
      if (!nextById.has(id)) {
        const removed = previousById.get(id);
        if (removed) {
          this.clearEditable(removed);
          removed.remove();
        }
        this.pendingValues.delete(id);
        if (this.pendingFocus?.id === id) this.pendingFocus = undefined;
      }
    }

    this.nodesById = nextById;
    this.modelsById = modelsById;
    const childOffsets = new Map<HTMLElement, number>();

    for (const node of visibleNodes) {
      const element = nextById.get(node.id);
      if (!element) {
        continue;
      }

      const parent = node.parentId ? nextById.get(node.parentId) : undefined;
      // Preserve DOM focus/selection when the same nodes remain in order.
      const container = parent ?? this.element;
      const offset = childOffsets.get(container) ?? 0;
      if (container.children[offset] !== element) {
        container.insertBefore(element, container.children[offset] ?? null);
      }
      childOffsets.set(container, offset + 1);
    }

    this.announceLiveRegionChanges(visibleNodes, normalizedAnnouncements);

    const focused = visibleNodes.find((node) => node.isFocused);
    const element = focused ? this.nodesById.get(focused.id) : undefined;
    const pending = this.pendingFocus;
    const focusAcknowledged =
      pending !== undefined && pending.requestID <= this.acknowledgedRequestID;
    // Reconcile a focus response only while the user is still on its target.
    // Moving to a disabled node or outside the scene produces no newer runtime
    // focus request, but must still supersede an in-flight assistive request.
    const synchronize = focusAcknowledged
      ? activeBeforePresentation === this.nodesById.get(pending.id)
      : element !== this.runtimeFocusedElement ||
        element === activeBeforePresentation;
    this.runtimeFocusedElement = element;
    if (focusAcknowledged) {
      this.pendingFocus = undefined;
    }
    if (
      (options.synchronizeFocus ?? true) &&
      synchronize &&
      element &&
      this.pendingFocus === undefined
    ) {
      // An unchanged runtime focus is state, not a new request to take focus.
      // Repaints must let assistive navigation leave editable controls.
      if (document.activeElement !== element)
        element.focus?.({ preventScroll: true });
    }
    this.presenting = false;
  }

  dispose(): void {
    for (const element of this.nodesById.values()) {
      this.clearEditable(element);
    }
    this.nodesById.clear();
    this.modelsById.clear();
    this.previousLabelsById.clear();
    this.pendingValues.clear();
    this.pendingFocus = undefined;
    this.runtimeFocusedElement = undefined;
    this.element.replaceChildren();
    this.announcerElement.textContent = "";
  }

  private clearEditable(element: HTMLElement): void {
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA")
      (element as HTMLInputElement).value = "";
    this.compositionCommits.delete(element);
  }

  private elementTag(node: WebHostAccessibilityNode): string {
    if (!node.actionTarget || !this.sendAction) return "div";
    if (node.role === "textEditor") return "textarea";
    if (["textField", "secureField", "slider", "stepper"].includes(node.role))
      return "input";
    return "div";
  }

  private createElement(
    node: WebHostAccessibilityNode,
    tag: string,
  ): HTMLElement {
    const element = document.createElement(tag);
    if (!node.actionTarget || !this.sendAction) return element;
    const current = () =>
      this.nodesById.get(node.id) === element
        ? this.modelsById.get(node.id)
        : undefined;
    const send = (request: WebHostAccessibilityAction) => {
      const model = current();
      if (
        this.presenting ||
        !model?.actionTarget ||
        model.isEnabled === false ||
        !model.actions?.includes(request.action)
      )
        return;
      const requestID = ++this.nextRequestID;
      if (request.action === "setValue")
        this.pendingValues.set(node.id, requestID);
      if (request.action === "focus")
        this.pendingFocus = { id: node.id, requestID };
      this.sendAction?.(model.actionTarget, request, String(requestID));
    };
    element.addEventListener("focus", () => send({ action: "focus" }));
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      send({ action: "activate" });
    });
    element.addEventListener("keydown", (event) => {
      const model = current();
      if (!model || event.key === "Tab" || event.key === "Escape") return;
      // Native editing owns text and clipboard keys. Submit still follows the
      // existing focused runtime keyboard path for single-line fields.
      if (tag !== "div" && event.key === "Enter" && model.role !== "textEditor")
        return;
      event.stopPropagation();
      let request: WebHostAccessibilityAction | undefined;
      if (
        model.actions?.includes("increment") &&
        ["ArrowRight", "ArrowUp"].includes(event.key)
      ) {
        request = { action: "increment" };
      } else if (
        model.actions?.includes("decrement") &&
        ["ArrowLeft", "ArrowDown"].includes(event.key)
      ) {
        request = { action: "decrement" };
      } else if (
        (model.role === "slider" || model.role === "stepper") &&
        (event.key === "Home" || event.key === "End")
      ) {
        const value = event.key === "Home" ? model.valueMin : model.valueMax;
        if (value !== undefined)
          request = { action: "setValue", value: { type: "number", value } };
      } else if (
        tag === "div" &&
        (event.key === "Enter" || event.key === " ")
      ) {
        request = { action: "activate" };
      }
      if (request) {
        event.preventDefault();
        send(request);
      }
    });
    if (tag !== "div") {
      let composing = false;
      element.addEventListener("blur", () => {
        composing = false;
        this.compositionCommits.delete(element);
        if (current()?.role === "secureField")
          (element as HTMLInputElement).value = "";
      });
      element.addEventListener("paste", (event) => event.stopPropagation());
      const commit = () => {
        const model = current();
        if (!model) return;
        const value = (element as HTMLInputElement).value;
        if (model.role === "slider" || model.role === "stepper") {
          const number = Number(value);
          if (value !== "" && Number.isFinite(number))
            send({
              action: "setValue",
              value: { type: "number", value: number },
            });
        } else {
          send({ action: "setValue", value: { type: "text", value } });
        }
      };
      element.addEventListener("compositionstart", () => {
        composing = true;
        this.compositionCommits.delete(element);
      });
      element.addEventListener("compositionend", () => {
        composing = false;
        if (!current()) return;
        commit();
        this.compositionCommits.set(
          element,
          (element as HTMLInputElement).value,
        );
      });
      element.addEventListener("input", (event) => {
        if (composing || (event as InputEvent).isComposing) return;
        const previous = this.compositionCommits.get(element);
        this.compositionCommits.delete(element);
        if (
          previous !== undefined &&
          previous === (element as HTMLInputElement).value
        )
          return;
        commit();
      });
    }
    return element;
  }

  private applyNodeAttributes(
    element: HTMLElement,
    node: WebHostAccessibilityNode,
    metrics: AccessibilityTreeMetrics,
    parent?: WebHostAccessibilityNode,
  ): void {
    element.id = `swifttui-a11y-${this.domIdentity}-${stableDOMId(node.id)}`;
    element.dataset.accessibilityId = node.id;
    element.tabIndex = node.isFocused ? 0 : -1;

    const role = roleMapping(node.role);
    // A password input must retain its native secure-field semantics.
    setOrRemoveAttribute(
      element,
      "role",
      node.role === "secureField" && element.tagName === "INPUT"
        ? undefined
        : role.role,
    );
    setOrRemoveAttribute(
      element,
      "aria-level",
      role.level !== undefined ? String(role.level) : undefined,
    );
    setOrRemoveAttribute(element, "aria-label", node.label || undefined);
    setOrRemoveAttribute(element, "aria-description", node.hint || undefined);
    setOrRemoveAttribute(element, "aria-live", node.liveRegion || undefined);
    if (node.isFocused) {
      element.dataset.focused = "true";
    } else {
      delete element.dataset.focused;
    }

    setOrRemoveAttribute(
      element,
      "aria-disabled",
      node.isEnabled === false ? "true" : undefined,
    );
    setOrRemoveAttribute(
      element,
      "aria-checked",
      node.role === "toggle" && node.value?.type === "boolean"
        ? String(node.value.value)
        : undefined,
    );
    setOrRemoveAttribute(
      element,
      "aria-expanded",
      node.role === "disclosureGroup" && node.value?.type === "boolean"
        ? String(node.value.value)
        : undefined,
    );
    setOrRemoveAttribute(
      element,
      "aria-valuenow",
      node.value?.type === "number" ? String(node.value.value) : undefined,
    );
    setOrRemoveAttribute(
      element,
      "aria-valuemin",
      node.valueMin === undefined ? undefined : String(node.valueMin),
    );
    setOrRemoveAttribute(
      element,
      "aria-valuemax",
      node.valueMax === undefined ? undefined : String(node.valueMax),
    );
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      const input = element as HTMLInputElement | HTMLTextAreaElement;
      if (element.tagName === "INPUT") {
        (input as HTMLInputElement).type =
          node.role === "secureField"
            ? "password"
            : node.role === "slider"
              ? "range"
              : node.role === "stepper"
                ? "number"
                : "text";
      }
      input.disabled = node.isEnabled === false;
      setOrRemoveAttribute(
        element,
        "min",
        node.valueMin === undefined ? undefined : String(node.valueMin),
      );
      setOrRemoveAttribute(
        element,
        "max",
        node.valueMax === undefined ? undefined : String(node.valueMax),
      );
      setOrRemoveAttribute(
        element,
        "step",
        node.valueStep === undefined ? undefined : String(node.valueStep),
      );
      const value = node.value ? String(node.value.value) : "";
      const pending = this.pendingValues.get(node.id);
      if (pending === undefined || pending <= this.acknowledgedRequestID) {
        this.pendingValues.delete(node.id);
        if (node.role !== "secureField" && input.value !== value) {
          this.compositionCommits.delete(element);
          input.value = value;
        }
      }
    }

    const [x, y, width, height] = node.rect;
    const [parentX, parentY] = parent?.rect ?? [0, 0];
    // Wire rectangles are scene-relative; positioned DOM children are
    // parent-relative. Hidden/missing parents reparent to the scene root.
    element.style.position = "absolute";
    element.style.left = `${(x - parentX) * metrics.cellWidth}px`;
    element.style.top = `${(y - parentY) * metrics.cellHeight}px`;
    element.style.width = `${Math.max(1, width) * metrics.cellWidth}px`;
    element.style.height = `${Math.max(1, height) * metrics.cellHeight}px`;
    // Native input defaults otherwise enlarge or offset the advertised box.
    element.style.boxSizing = "border-box";
    element.style.margin = "0";
    element.style.padding = "0";
    element.style.border = "0";
    element.style.minWidth = "0";
    element.style.minHeight = "0";
  }

  private announceLiveRegionChanges(
    nodes: WebHostAccessibilityNode[],
    announcements: WebHostAccessibilityAnnouncement[],
  ): void {
    const candidates = nodes.filter(
      (node) => node.liveRegion && node.liveRegion !== "off" && node.label,
    );
    const currentLabelsById = new Map(
      candidates.map((node) => [node.id, node.label ?? ""]),
    );
    const imperativeAssertive = announcements.filter(
      (announcement) => announcement.politeness === "assertive",
    );
    const imperativePolite = announcements.filter(
      (announcement) => announcement.politeness === "polite",
    );

    if (!this.hasLiveRegionBaseline) {
      this.previousLabelsById = currentLabelsById;
      this.hasLiveRegionBaseline = true;
      this.publishAnnouncements([], imperativeAssertive, [], imperativePolite);
      return;
    }

    const changed = candidates.filter((node) => {
      const previous = this.previousLabelsById.get(node.id);
      return previous !== undefined && previous !== node.label;
    });
    this.previousLabelsById = currentLabelsById;

    const assertive = changed.filter((node) => node.liveRegion === "assertive");
    const polite = changed.filter((node) => node.liveRegion === "polite");
    this.publishAnnouncements(
      assertive,
      imperativeAssertive,
      polite,
      imperativePolite,
    );
  }

  private publishAnnouncements(
    assertive: WebHostAccessibilityNode[],
    imperativeAssertive: WebHostAccessibilityAnnouncement[],
    polite: WebHostAccessibilityNode[],
    imperativePolite: WebHostAccessibilityAnnouncement[],
  ): void {
    const ordered = [
      ...assertive,
      ...imperativeAssertive,
      ...polite,
      ...imperativePolite,
    ];
    if (ordered.length === 0) {
      return;
    }

    const politeness =
      assertive.length > 0 || imperativeAssertive.length > 0
        ? "assertive"
        : "polite";
    this.announcerElement.setAttribute("aria-live", politeness);
    this.announcerElement.textContent = ordered
      .map((entry) => {
        if ("message" in entry) {
          return entry.message;
        }
        return entry.label ?? "";
      })
      .join("\n");
  }
}

function setOrRemoveAttribute(
  element: HTMLElement,
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    element.removeAttribute(name);
    return;
  }
  element.setAttribute(name, value);
}

function applyScreenReaderOnlyStyle(element: HTMLElement): void {
  element.style.position = "absolute";
  element.style.left = "0";
  element.style.top = "0";
  element.style.width = "1px";
  element.style.height = "1px";
  element.style.overflow = "hidden";
  element.style.clipPath = "inset(50%)";
  element.style.whiteSpace = "nowrap";
}

function roleMapping(role: string): RoleMapping {
  const heading = /^heading\(level: ([0-9]+)\)$/.exec(role);
  if (heading) {
    return {
      role: "heading",
      level: Math.max(1, Math.min(6, Number(heading[1]))),
    };
  }

  const custom = /^custom\((.+)\)$/.exec(role);
  if (custom) {
    return { role: custom[1] };
  }

  switch (role) {
    case "alert":
    case "button":
    case "cell":
    case "checkbox":
    case "grid":
    case "group":
    case "link":
    case "list":
    case "menu":
    case "region":
    case "separator":
    case "slider":
    case "status":
    case "tab":
    case "table":
    case "timer":
      return { role };
    case "columnHeader":
      return { role: "columnheader" };
    case "confirmationDialog":
    case "sheet":
      return { role: "dialog" };
    case "disclosureGroup":
    case "scrollView":
    case "scrollViewWithIndicators":
    case "section":
      return { role: "region" };
    case "image":
      return { role: "img" };
    case "menuItem":
      return { role: "menuitem" };
    case "picker":
      return { role: "combobox" };
    case "progressBar":
      return { role: "progressbar" };
    case "rowHeader":
      return { role: "rowheader" };
    case "secureField":
    case "textEditor":
    case "textField":
      return { role: "textbox" };
    case "stepper":
      return { role: "spinbutton" };
    case "tabPanel":
      return { role: "tabpanel" };
    case "tableRow":
      return { role: "row" };
    case "tabView":
      return { role: "tablist" };
    case "toggle":
      return { role: "checkbox" };
    default:
      return { role: "group" };
  }
}

function stableDOMId(id: string): string {
  return Array.from(id)
    .map((character) => {
      if (/^[a-zA-Z0-9_-]$/.test(character)) {
        return character;
      }
      return `-${character.codePointAt(0)?.toString(16) ?? "0"}-`;
    })
    .join("");
}
