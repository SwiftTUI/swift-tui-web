import {
  presentSelection,
  selectionFocusElement,
} from "./AccessibilitySelection.ts";
import {
  normalizeLiveRegion,
  normalizePoliteness,
} from "./normalizeWireTokens.ts";
import type {
  WebHostAccessibilityAction,
  WebHostAccessibilityActionResponse,
  WebHostAccessibilityAnnouncement,
  WebHostAccessibilityFocusPresentation,
  WebHostAccessibilityNode,
} from "./WebHostSurfaceTransport.ts";

interface AccessibilityTreeMetrics {
  cellWidth: number;
  cellHeight: number;
}

interface AccessibilityTreePresentationOptions {
  synchronizeFocus?: boolean;
  actionResponse?: WebHostAccessibilityActionResponse;
  focusRequest?: WebHostAccessibilityFocusPresentation;
}

interface RoleMapping {
  role?: string;
  level?: number;
}

export class AccessibilityTreeMounter {
  readonly element: HTMLElement;
  readonly announcerElement: HTMLElement;
  readonly navigationElement: HTMLDetailsElement;
  private readonly categorySelect: HTMLSelectElement;
  private readonly targetSelect: HTMLSelectElement;
  private readonly navigationGo: HTMLButtonElement;
  private navigationGroups = new Map<string, WebHostAccessibilityNode[]>();
  // Also unique when independent bundles each include a copy of the runtime.
  private readonly domIdentity = Array.from(
    crypto.getRandomValues(new Uint32Array(4)),
    (part) => part.toString(16),
  ).join("-");

  private nodesById = new Map<string, HTMLElement>();
  private actionGroupsById = new Map<string, HTMLElement>();
  private previousLabelsById = new Map<string, string>();
  private hasLiveRegionBaseline = false;

  private readingText = new WeakMap<HTMLElement, Text>();
  private modelsById = new Map<string, WebHostAccessibilityNode>();
  private presenting = false;
  private nextRequestID = 0n;
  private acknowledgedRequestID = 0n;
  private pendingValues = new Map<string, bigint>();
  private pendingFocus?: { id: string; requestID: bigint };
  private runtimeFocusedElement?: HTMLElement;
  private appliedAssistiveFocusGeneration = -1n;
  private readonly compositionCommits = new WeakMap<HTMLElement, string>();

  get hasInteractiveControls(): boolean {
    return [...this.modelsById.values()].some((node) => this.isTabStop(node));
  }

  /** Advance synchronously through supported controls, retaining browser exits. */
  advanceFocus(backward: boolean): boolean {
    const controls = [
      ...this.element.querySelectorAll<HTMLElement>("[tabindex='0']"),
    ];
    const current = controls.indexOf(document.activeElement as HTMLElement);
    if (current < 0) return false;
    const next = controls[current + (backward ? -1 : 1)];
    if (!next) return false;
    next.focus();
    return true;
  }

  private isTabStop(node: WebHostAccessibilityNode): boolean {
    return (
      !!this.sendAction &&
      !!node.actionTarget &&
      node.isEnabled !== false &&
      !!node.actions?.includes("focus")
    );
  }

  constructor(
    private readonly sendAction?: (
      target: string,
      request: WebHostAccessibilityAction,
      requestID: string,
    ) => void,
    private readonly openLink?: (url: string) => void,
  ) {
    this.navigationElement = document.createElement("details");
    this.navigationElement.hidden = true;
    this.navigationElement.className = "webhost-scene__content-navigation";
    const summary = document.createElement("summary");
    summary.textContent = "Navigate content";
    const categoryLabel = document.createElement("label");
    categoryLabel.textContent = "Content group ";
    this.categorySelect = document.createElement("select");
    categoryLabel.append(this.categorySelect);
    const targetLabel = document.createElement("label");
    targetLabel.textContent = "Destination ";
    this.targetSelect = document.createElement("select");
    targetLabel.append(this.targetSelect);
    this.navigationGo = document.createElement("button");
    this.navigationGo.type = "button";
    this.navigationGo.textContent = "Go to content";
    this.navigationElement.append(
      summary,
      categoryLabel,
      targetLabel,
      this.navigationGo,
    );
    this.categorySelect.addEventListener("change", () =>
      this.refreshNavigationTargets(),
    );
    this.navigationGo.addEventListener("click", () => {
      const node = this.modelsById.get(this.targetSelect.value);
      const target = node ? this.nodesById.get(node.id) : undefined;
      if (
        !node?.actionTarget ||
        !target ||
        !node.actions?.includes("accessibilityFocus")
      )
        return;
      // Navigation changes semantic review only; the control's ordinary DOM
      // focus listener must not also move the application's keyboard focus.
      this.presenting = true;
      try {
        target.focus();
      } finally {
        this.presenting = false;
      }
      this.sendAction?.(
        node.actionTarget,
        { action: "accessibilityFocus" },
        String(++this.nextRequestID),
      );
    });

    this.element = document.createElement("div");
    this.element.className = "webhost-scene__accessibility-tree";
    // Assistive focus outlines use these elements' real bounds. Hide only
    // their paint, preserving the full scene geometry and semantic hierarchy.
    this.element.style.position = "absolute";
    this.element.style.inset = "0";
    this.element.style.opacity = "0";
    this.element.style.pointerEvents = "none";
    // Native controls opt into pointer input over their placed routes. Keep
    // them above the DOM painter's text/image layers, which otherwise steal
    // assistive activation; the rest of the overlay remains hit-transparent.
    this.element.style.zIndex = "3";

    this.announcerElement = document.createElement("div");
    this.announcerElement.className = "webhost-scene__accessibility-announcer";
    this.announcerElement.setAttribute("aria-atomic", "true");
    this.announcerElement.setAttribute("aria-live", "polite");
    applyScreenReaderOnlyStyle(this.announcerElement);
  }

  present(
    nodes: WebHostAccessibilityNode[],
    metrics: AccessibilityTreeMetrics,
    announcements: WebHostAccessibilityAnnouncement[] = [],
    options: AccessibilityTreePresentationOptions = {},
  ): void {
    this.presenting = true;
    try {
      this.presentFrame(nodes, metrics, announcements, options);
    } finally {
      // A rejected DOM hierarchy or host exception must not suppress every
      // subsequent user action after a valid frame recovers the scene.
      this.presenting = false;
    }
  }

  private presentFrame(
    nodes: WebHostAccessibilityNode[],
    metrics: AccessibilityTreeMetrics,
    announcements: WebHostAccessibilityAnnouncement[],
    options: AccessibilityTreePresentationOptions,
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
        previousModel?.actionTarget === node.actionTarget &&
        previousModel?.selection?.presentation === node.selection?.presentation;
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
        this.actionGroupsById.get(id)?.remove();
        this.actionGroupsById.delete(id);
        if (this.pendingFocus?.id === id) this.pendingFocus = undefined;
      }
    }

    this.nodesById = nextById;
    this.modelsById = modelsById;
    for (const node of visibleNodes) {
      const element = nextById.get(node.id);
      if (element) this.applyRelationships(element, node, nextById);
    }
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
      const group = this.presentCustomActions(node, element);
      if (group && container.children[offset + 1] !== group)
        container.insertBefore(group, container.children[offset + 1] ?? null);
      childOffsets.set(container, offset + (group ? 2 : 1));
    }

    this.refreshNavigation(visibleNodes);
    this.announceLiveRegionChanges(visibleNodes, normalizedAnnouncements);

    const assistiveRequest = options.focusRequest;
    const requestGeneration = assistiveRequest
      ? BigInt(assistiveRequest.generation)
      : undefined;
    const applyAssistiveRequest =
      (options.synchronizeFocus ?? true) &&
      requestGeneration !== undefined &&
      requestGeneration > this.appliedAssistiveFocusGeneration;
    if (applyAssistiveRequest && assistiveRequest) {
      this.appliedAssistiveFocusGeneration = requestGeneration;
      const target = visibleNodes.find(
        (node) => node.actionTarget === assistiveRequest.target,
      );
      if (assistiveRequest.target !== undefined && target) {
        this.nodesById.get(target.id)?.focus({ preventScroll: true });
      } else if (
        assistiveRequest.target === undefined &&
        this.element.contains(document.activeElement)
      ) {
        (document.activeElement as HTMLElement)?.blur();
      }
    }

    const focused = visibleNodes.find((node) => node.isFocused);
    const element = focused ? this.nodesById.get(focused.id) : undefined;
    const pending = this.pendingFocus;
    const focusAcknowledged =
      pending !== undefined && pending.requestID <= this.acknowledgedRequestID;
    // Reconcile a focus response only while the user is still on its target.
    // Moving to a disabled node or outside the scene produces no newer runtime
    // focus request, but must still supersede an in-flight assistive request.
    const synchronize = focusAcknowledged
      ? (this.nodesById.get(pending.id)?.contains(activeBeforePresentation) ??
        false)
      : element !== this.runtimeFocusedElement ||
        element === activeBeforePresentation;
    this.runtimeFocusedElement = element;
    if (focusAcknowledged) {
      this.pendingFocus = undefined;
    }
    if (
      (options.synchronizeFocus ?? true) &&
      !applyAssistiveRequest &&
      synchronize &&
      element &&
      this.pendingFocus === undefined
    ) {
      // An unchanged runtime focus is state, not a new request to take focus.
      // Repaints must let assistive navigation leave editable controls.
      const focusElement = selectionFocusElement(element);
      if (document.activeElement !== focusElement)
        focusElement.focus?.({ preventScroll: true });
    }
  }

  dispose(): void {
    for (const element of this.nodesById.values()) {
      this.clearEditable(element);
    }
    this.nodesById.clear();
    this.actionGroupsById.clear();
    this.modelsById.clear();
    this.previousLabelsById.clear();
    this.pendingValues.clear();
    this.pendingFocus = undefined;
    this.runtimeFocusedElement = undefined;
    this.appliedAssistiveFocusGeneration = -1n;
    this.element.replaceChildren();
    this.announcerElement.replaceChildren();
    this.navigationElement.remove();
  }

  private refreshNavigation(nodes: WebHostAccessibilityNode[]): void {
    this.navigationGroups = new Map();
    for (const node of nodes) {
      if (
        !node.label?.trim() ||
        !node.actionTarget ||
        !node.actions?.includes("accessibilityFocus")
      )
        continue;
      for (const category of node.navigationCategories ?? []) {
        const entries = this.navigationGroups.get(category) ?? [];
        entries.push(node);
        this.navigationGroups.set(category, entries);
      }
    }
    this.navigationElement.hidden = this.navigationGroups.size === 0;
    this.setNavigationOptions(
      this.categorySelect,
      [...this.navigationGroups.keys()].map((name) => [name, name]),
    );
    this.refreshNavigationTargets();
  }

  private refreshNavigationTargets(): void {
    const entries = this.navigationGroups.get(this.categorySelect.value) ?? [];
    this.setNavigationOptions(
      this.targetSelect,
      entries.map((node) => [node.id, node.label ?? ""]),
    );
    this.navigationGo.disabled = entries.length === 0;
  }

  private setNavigationOptions(
    select: HTMLSelectElement,
    entries: [string, string][],
  ): void {
    if (
      select.options.length === entries.length &&
      entries.every(
        ([value, label], index) =>
          select.options[index]?.value === value &&
          select.options[index]?.textContent === label,
      )
    )
      return;
    const selected = select.value;
    select.replaceChildren(
      ...entries.map(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      }),
    );
    if (entries.some(([value]) => value === selected)) select.value = selected;
  }

  private clearEditable(element: HTMLElement): void {
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA")
      (element as HTMLInputElement).value = "";
    this.compositionCommits.delete(element);
  }

  private elementTag(node: WebHostAccessibilityNode): string {
    if (node.role === "link") return "a";
    if (
      node.selection &&
      ["menu", "list"].includes(node.selection.presentation)
    )
      return "select";
    if (!node.actionTarget || !this.sendAction) return "div";
    if (node.role === "stepper" && !node.actions?.includes("setValue"))
      return "div";
    if (node.role === "textEditor") return "textarea";
    if (["textField", "secureField", "slider", "stepper"].includes(node.role))
      return "input";
    return "div";
  }

  private presentCustomActions(
    node: WebHostAccessibilityNode,
    owner: HTMLElement,
  ): HTMLElement | undefined {
    const names =
      node.actionTarget && this.sendAction && node.actions?.includes("custom")
        ? (node.customActions ?? [])
        : [];
    let group = this.actionGroupsById.get(node.id);
    if (!names.length) {
      group?.remove();
      this.actionGroupsById.delete(node.id);
      return undefined;
    }
    if (!group) {
      group = document.createElement("div");
      group.setAttribute("role", "group");
      this.actionGroupsById.set(node.id, group);
      for (const type of ["click", "pointerdown", "pointerup", "pointermove"])
        group.addEventListener(type, (event) => event.stopPropagation());
      group.addEventListener("keydown", (event) => {
        if (event.key !== "Tab" && event.key !== "Escape")
          event.stopPropagation();
      });
    }
    group.setAttribute("aria-label", `${node.label ?? "Control"} actions`);
    group.style.cssText = owner.style.cssText;
    const previous = new Map(
      Array.from(group.children, (child) => [
        child.textContent,
        child as HTMLButtonElement,
      ]),
    );
    for (const [index, name] of names.entries()) {
      let button = previous.get(name);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.textContent = name;
        button.addEventListener("click", () => {
          const current = this.modelsById.get(node.id);
          if (
            this.actionGroupsById.get(node.id) !== group ||
            !current?.actionTarget ||
            current.isEnabled === false ||
            current.properties?.readOnly === true ||
            !current.customActions?.includes(name)
          )
            return;
          this.sendAction?.(
            current.actionTarget,
            { action: "custom", name },
            String(++this.nextRequestID),
          );
        });
      }
      previous.delete(name);
      button.disabled =
        node.isEnabled === false || node.properties?.readOnly === true;
      button.tabIndex = button.disabled ? -1 : 0;
      if (group.children[index] !== button)
        group.insertBefore(button, group.children[index] ?? null);
    }
    for (const button of previous.values()) button.remove();
    return group;
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
      const semanticFocus =
        request.action === "accessibilityFocus" ||
        request.action === "accessibilityBlur";
      if (
        this.presenting ||
        !model?.actionTarget ||
        (model.isEnabled === false && !semanticFocus) ||
        (model.properties?.readOnly === true &&
          request.action !== "focus" &&
          !semanticFocus) ||
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
    element.addEventListener(node.selection ? "focusin" : "focus", () => {
      send({ action: "focus" });
      send({ action: "accessibilityFocus" });
    });
    element.addEventListener(node.selection ? "focusout" : "blur", (event) => {
      if (
        node.selection &&
        element.contains((event as FocusEvent).relatedTarget as Node)
      )
        return;
      send({ action: "accessibilityBlur" });
    });
    if (node.selection) {
      // A native option press must not also enter the surface pointer route,
      // which would steal focus and prevent the input's default activation.
      for (const type of ["pointerdown", "pointerup", "pointermove"])
        element.addEventListener(type, (event) => event.stopPropagation());
      element.addEventListener("change", (event) => {
        event.stopPropagation();
        const input = event.target as HTMLInputElement | HTMLSelectElement;
        const model = current();
        const option = model?.selection?.options.find(
          (option) => option.id === input.value,
        );
        if (
          !option?.isEnabled ||
          (input instanceof HTMLInputElement && !input.checked)
        )
          return;
        send({ action: "setValue", value: { type: "text", value: option.id } });
      });
      // Native selection owns arrows, type-ahead, activation and popup dismissal.
      // Let Tab reach the scene's synchronous traversal without forwarding a
      // second copy of a selection key to Swift.
      element.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") event.stopPropagation();
      });
      element.addEventListener("click", (event) => event.stopPropagation());
      return element;
    }
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      const model = current();
      if (tag === "a") {
        if (
          model?.opensLink &&
          model.isEnabled !== false &&
          model.properties?.readOnly !== true
        ) {
          if (this.openLink && model.value?.type === "text") {
            event.preventDefault();
            this.openLink(model.value.value);
            return;
          }
          if (element.hasAttribute("href")) return;
        }
        event.preventDefault();
      }
      send({ action: "activate" });
    });
    if (tag === "a") {
      for (const type of ["pointerdown", "pointerup", "pointermove"])
        element.addEventListener(type, (event) => event.stopPropagation());
    }
    element.addEventListener("keydown", (event) => {
      const model = current();
      if (!model || event.key === "Tab" || event.key === "Escape") return;
      if (tag === "a" && event.key === "Enter") {
        // Let the native anchor generate one click, without a second key route.
        event.stopPropagation();
        if (!element.hasAttribute("href")) {
          event.preventDefault();
          element.click();
        }
        return;
      }
      // WebKit treats Backspace in a read-only editor as browser navigation.
      // Keep review inside the application while allowing selection/copy keys.
      if (
        model.properties?.readOnly === true &&
        (event.key === "Backspace" || event.key === "Delete")
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
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
    // Native traversal moves focus before the next key arrives. Waiting for a
    // Swift focus frame leaves rapid Tab+edit input aimed at the old control.
    element.tabIndex = this.isTabStop(node) ? 0 : -1;
    if (element.tagName === "A") {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
      const destination =
        node.value?.type === "text" ? node.value.value : undefined;
      setOrRemoveAttribute(
        element,
        "href",
        node.isEnabled !== false ? safeLinkDestination(destination) : undefined,
      );
      element.style.pointerEvents = "auto";
    }

    if (node.isAccessibilityFocused)
      element.dataset.accessibilityFocused = "true";
    else delete element.dataset.accessibilityFocused;
    const properties = node.properties;
    const role = roleMapping(node.role);
    if (properties?.headingLevel !== undefined) {
      role.role = "heading";
      role.level = properties.headingLevel;
    } else if (properties?.textKind !== undefined) {
      role.role =
        properties.textKind === "quotation"
          ? "blockquote"
          : properties.textKind;
    }
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
      role.level !== undefined
        ? String(role.level)
        : properties?.level?.toString(),
    );
    const structuredText = properties?.textKind !== undefined;
    setOrRemoveAttribute(
      element,
      "aria-label",
      structuredText ? undefined : node.label || undefined,
    );
    // Reuse the element across updates without disturbing hierarchy or focus.
    const text = this.readingText.get(element);
    if (structuredText) {
      if (text) text.textContent = node.label ?? "";
      else {
        const content = document.createTextNode(node.label ?? "");
        this.readingText.set(element, content);
        element.prepend(content);
      }
    } else if (text) {
      text.remove();
      this.readingText.delete(element);
    }
    setOrRemoveAttribute(
      element,
      "aria-description",
      [
        !supportsValueText(node.role) && node.role !== "secureField"
          ? properties?.valueDescription
          : undefined,
        properties?.description ?? node.hint,
      ]
        .filter(Boolean)
        .join("; ") || undefined,
    );
    setOrRemoveAttribute(element, "lang", properties?.language);
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
      "aria-pressed",
      node.role === "button" && node.value?.type === "boolean"
        ? String(node.value.value)
        : undefined,
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
      properties?.expanded !== undefined
        ? String(properties.expanded)
        : node.role === "disclosureGroup" && node.value?.type === "boolean"
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
    setOrRemoveAttribute(
      element,
      "aria-selected",
      properties?.selected?.toString(),
    );
    setOrRemoveAttribute(
      element,
      "aria-required",
      properties?.required?.toString(),
    );
    setOrRemoveAttribute(
      element,
      "aria-invalid",
      properties?.invalid?.toString(),
    );
    setOrRemoveAttribute(element, "aria-busy", properties?.busy?.toString());
    setOrRemoveAttribute(
      element,
      "aria-readonly",
      properties?.readOnly?.toString(),
    );
    setOrRemoveAttribute(
      element,
      "aria-valuetext",
      !supportsValueText(node.role) || node.selection
        ? undefined
        : properties?.valueDescription?.toString(),
    );
    setOrRemoveAttribute(
      element,
      "aria-posinset",
      properties?.positionInSet?.toString(),
    );
    setOrRemoveAttribute(
      element,
      "aria-setsize",
      properties?.setSize?.toString(),
    );
    setOrRemoveAttribute(
      element,
      "aria-rowindex",
      properties?.rowIndex?.toString(),
    );
    setOrRemoveAttribute(
      element,
      "aria-colindex",
      properties?.columnIndex?.toString(),
    );
    setOrRemoveAttribute(
      element,
      "aria-rowcount",
      properties?.rowCount?.toString(),
    );
    setOrRemoveAttribute(
      element,
      "aria-colcount",
      properties?.columnCount?.toString(),
    );
    setOrRemoveAttribute(
      element,
      "aria-rowspan",
      properties?.rowSpan?.toString(),
    );
    setOrRemoveAttribute(
      element,
      "aria-colspan",
      properties?.columnSpan?.toString(),
    );
    setOrRemoveAttribute(element, "aria-sort", properties?.sort?.toString());
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
      input.readOnly = properties?.readOnly === true;
      input.required = properties?.required === true;
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

    if (node.selection) {
      const pending = this.pendingValues.get(node.id);
      const synchronizeValue =
        pending === undefined || pending <= this.acknowledgedRequestID;
      if (synchronizeValue) this.pendingValues.delete(node.id);
      presentSelection(
        element,
        node,
        synchronizeValue,
        this.isTabStop(node) && !!node.actions?.includes("setValue"),
      );
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

  private applyRelationships(
    element: HTMLElement,
    node: WebHostAccessibilityNode,
    elements: Map<string, HTMLElement>,
  ): void {
    const properties = node.properties;
    const references = (ids: string[] | undefined): string | undefined => {
      const resolved = [...new Set(ids ?? [])]
        .filter((id) => id !== node.id && elements.has(id))
        .map((id) => elements.get(id)!.id);
      return resolved.length ? resolved.join(" ") : undefined;
    };
    setOrRemoveAttribute(
      element,
      "aria-labelledby",
      references(properties?.labelledBy),
    );
    setOrRemoveAttribute(
      element,
      "aria-describedby",
      references(properties?.describedBy),
    );
    setOrRemoveAttribute(
      element,
      "aria-errormessage",
      references(properties?.errorMessage),
    );
    setOrRemoveAttribute(
      element,
      "aria-controls",
      references(properties?.controls),
    );
    setOrRemoveAttribute(element, "aria-owns", references(properties?.owns));
    setOrRemoveAttribute(
      element,
      "aria-flowto",
      references(properties?.flowTo),
    );
    setOrRemoveAttribute(
      element,
      "aria-activedescendant",
      references(
        properties?.activeDescendant === undefined
          ? undefined
          : [properties.activeDescendant],
      ),
    );
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
    const message = ordered
      .map((entry) => {
        if ("message" in entry) {
          return entry.message;
        }
        return entry.label ?? "";
      })
      .join("\n");
    if (!message.trim()) {
      this.announcerElement.replaceChildren();
      return;
    }
    // A descendant text alternative participates in live-region announcements
    // without adding a second searchable/copyable Text node beside the surface.
    // Replace the child so repeated identical imperative messages remain new
    // additions, while frames with no announcement leave the region untouched.
    const content = document.createElement("span");
    content.setAttribute("role", "img");
    content.setAttribute("aria-label", message);
    this.announcerElement.replaceChildren(content);
  }
}

function supportsValueText(role: string): boolean {
  return ["slider", "stepper", "progressBar", "scrollBar", "meter"].includes(
    role,
  );
}

function safeLinkDestination(
  destination: string | undefined,
): string | undefined {
  if (!destination) return undefined;
  try {
    const url = new URL(destination);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
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
  return Array.from(id, (character) =>
    character.codePointAt(0)!.toString(16),
  ).join("-");
}
