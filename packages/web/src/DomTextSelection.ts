/** Accessible host chrome for selecting the committed viewport without app input. */
export class DomTextSelection {
  readonly element = document.createElement("div");
  private readonly toggle = document.createElement("button");
  private readonly all = document.createElement("button");
  private readonly status = document.createElement("span");
  private enabled = false;

  get active(): boolean {
    return this.enabled;
  }

  constructor(
    private readonly terminal: HTMLElement,
    private readonly textRoot: () => HTMLElement | undefined,
    private readonly changed: () => void,
  ) {
    this.element.className = "webhost-scene__selection-controls";
    this.element.setAttribute("role", "group");
    this.element.setAttribute("aria-label", "Text selection");
    Object.assign(this.element.style, {
      gridRow: "2",
      gridColumn: "1",
      justifySelf: "end",
      display: "flex",
      alignItems: "center",
      flexWrap: "wrap",
      gap: "6px",
      maxWidth: "100%",
      font: "12px/1.4 system-ui, sans-serif",
    });
    for (const button of [this.toggle, this.all]) {
      button.type = "button";
      Object.assign(button.style, {
        font: "inherit",
        color: "ButtonText",
        background: "ButtonFace",
        border: "1px solid ButtonBorder",
        borderRadius: "4px",
        padding: "3px 8px",
      });
    }
    this.toggle.textContent = "Select text";
    this.toggle.setAttribute("aria-pressed", "false");
    this.toggle.onclick = () => this.setActive(!this.enabled);
    this.all.textContent = "Select all text";
    this.all.hidden = true;
    this.all.onclick = () => {
      this.selectAll();
      this.terminal.focus({ preventScroll: true });
    };
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.element.append(this.status, this.toggle, this.all);
    terminal.addEventListener("keydown", this.keyDown, true);
    terminal.addEventListener("click", this.suppressActivation, true);
    terminal.addEventListener("auxclick", this.suppressActivation, true);
    terminal.addEventListener("paste", this.suppressActivation, true);
    terminal.addEventListener("beforeinput", this.suppressActivation, true);
  }

  private boundaries(): { first: Text; last: Text } | undefined {
    const root = this.textRoot();
    if (!root) return undefined;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let first: Text | undefined, last: Text | undefined;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.length) continue;
      first ??= node as Text;
      last = node as Text;
    }
    return first && last ? { first, last } : undefined;
  }

  setActive(active: boolean): void {
    if (active === this.enabled) return;
    this.enabled = active;
    this.toggle.setAttribute("aria-pressed", String(active));
    this.all.hidden = !active;
    this.status.textContent = active
      ? "Drag or use Shift+Arrow keys. Escape returns to the app."
      : "Text selection off.";
    this.terminal.setAttribute("data-text-selection", String(active));
    this.terminal.style.cursor = active ? "text" : "";
    this.changed();
    if (active) {
      this.terminal.focus({ preventScroll: true });
      const selection = document.getSelection();
      if (!this.textRoot()?.contains(selection?.anchorNode ?? null)) {
        const bounds = this.boundaries();
        if (bounds)
          selection?.setBaseAndExtent(bounds.first, 0, bounds.first, 0);
      }
    } else this.toggle.focus({ preventScroll: true });
  }

  private selectAll(): void {
    const bounds = this.boundaries();
    if (bounds)
      document
        .getSelection()
        ?.setBaseAndExtent(bounds.first, 0, bounds.last, bounds.last.length);
  }

  private readonly suppressActivation = (event: Event) => {
    if (!this.enabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly keyDown = (event: KeyboardEvent) => {
    if (!this.enabled) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.setActive(false);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.selectAll();
      return;
    }
    // Tab and browser shortcuts retain their defaults. The runtime also yields
    // while this mode is active, so no bubbling key can activate the app.
    if (event.key === "Tab" || event.metaKey || event.ctrlKey) return;
    const direction = ["ArrowLeft", "ArrowUp", "Home"].includes(event.key)
      ? "backward"
      : "forward";
    const granularity =
      event.key === "Home" || event.key === "End"
        ? "lineboundary"
        : event.key === "ArrowUp" || event.key === "ArrowDown"
          ? "line"
          : event.altKey
            ? "word"
            : "character";
    if (
      [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(event.key)
    ) {
      const selection = document.getSelection();
      const bounds = this.boundaries();
      if (selection && bounds) {
        if (!this.textRoot()?.contains(selection.anchorNode))
          selection.setBaseAndExtent(bounds.first, 0, bounds.first, 0);
        selection.modify(
          event.shiftKey ? "extend" : "move",
          direction,
          granularity,
        );
        if (!this.textRoot()?.contains(selection.focusNode)) {
          const end = direction === "backward" ? bounds.first : bounds.last;
          const offset = direction === "backward" ? 0 : end.length;
          if (event.shiftKey) selection.extend(end, offset);
          else selection.setBaseAndExtent(end, offset, end, offset);
        }
      }
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  dispose(): void {
    this.enabled = false;
    this.toggle.onclick = null;
    this.all.onclick = null;
    this.terminal.removeEventListener("keydown", this.keyDown, true);
    this.terminal.removeEventListener("click", this.suppressActivation, true);
    this.terminal.removeEventListener(
      "auxclick",
      this.suppressActivation,
      true,
    );
    this.terminal.removeEventListener("paste", this.suppressActivation, true);
    this.terminal.removeEventListener(
      "beforeinput",
      this.suppressActivation,
      true,
    );
    this.element.remove();
  }
}
