import type { WebHostAccessibilityNode } from "./WebHostSurfaceTransport.ts";

/** Native choices retain their identity independently from labels and positions. */
export function presentSelection(
  element: HTMLElement,
  node: WebHostAccessibilityNode,
  synchronizeValue: boolean,
  interactive: boolean,
): void {
  const selection = node.selection!;
  const selected = node.value?.type === "text" ? node.value.value : "";
  const enabled =
    interactive &&
    node.isEnabled !== false &&
    node.properties?.readOnly !== true;
  const active = document.activeElement;
  const ownedFocus =
    active instanceof HTMLElement &&
    active !== element &&
    element.contains(active);
  const previous = new Map(
    Array.from(element.children, (child) => [
      (child as HTMLElement).dataset.optionId,
      child as HTMLElement,
    ]),
  );
  const nativeSelect = element instanceof HTMLSelectElement;
  if (nativeSelect) {
    element.size =
      selection.presentation === "menu"
        ? 1
        : Math.max(2, Math.min(8, selection.options.length));
    element.disabled = !enabled;
    element.tabIndex = enabled ? 0 : -1;
    element.required = node.properties?.required === true;
    // Native select supplies its own combobox/listbox and popup semantics.
    element.removeAttribute("role");
  } else {
    element.setAttribute("role", "radiogroup");
    element.setAttribute(
      "aria-orientation",
      selection.presentation === "segmented" ? "horizontal" : "vertical",
    );
    element.tabIndex = -1;
  }
  selection.options.forEach((option, index) => {
    const child =
      previous.get(option.id) ??
      document.createElement(nativeSelect ? "option" : "input");
    previous.delete(option.id);
    child.dataset.optionId = option.id;
    if (nativeSelect) {
      const nativeOption = child as HTMLOptionElement;
      nativeOption.value = option.id;
      nativeOption.textContent = option.label;
      nativeOption.disabled = !enabled || !option.isEnabled;
    } else {
      const radio = child as HTMLInputElement;
      radio.type = "radio";
      radio.name = element.id;
      radio.value = option.id;
      radio.id = `${element.id}-option-${Array.from(option.id, (c) => c.codePointAt(0)!.toString(16)).join("-")}`;
      radio.setAttribute("aria-label", option.label);
      radio.setAttribute("aria-posinset", String(index + 1));
      radio.setAttribute("aria-setsize", String(selection.options.length));
      radio.disabled = !enabled || !option.isEnabled;
      if (synchronizeValue) radio.checked = selected === option.id;
      radio.style.position = "absolute";
      const horizontal = selection.presentation === "segmented";
      radio.style.left = horizontal
        ? `${(index * 100) / selection.options.length}%`
        : "0";
      radio.style.top = horizontal
        ? "0"
        : `${(index * 100) / selection.options.length}%`;
      radio.style.width = horizontal
        ? `${100 / selection.options.length}%`
        : "100%";
      radio.style.height = horizontal
        ? "100%"
        : `${100 / selection.options.length}%`;
      radio.style.margin = "0";
    }
    if (element.children[index] !== child)
      element.insertBefore(child, element.children[index] ?? null);
  });
  for (const child of previous.values()) child.remove();
  if (nativeSelect) {
    if (synchronizeValue) element.value = selected;
  } else {
    const radios = Array.from(
      element.querySelectorAll<HTMLInputElement>("input"),
    );
    const tabStop =
      radios.find((radio) => radio.checked && !radio.disabled) ??
      radios.find((radio) => !radio.disabled);
    for (const radio of radios) radio.tabIndex = radio === tabStop ? 0 : -1;
    // Removing the reviewed choice must leave focus in the same live picker.
    if (ownedFocus) {
      const target =
        active instanceof HTMLInputElement &&
        element.contains(active) &&
        !active.disabled
          ? active
          : tabStop;
      target?.focus({ preventScroll: true });
    }
  }
}

export function selectionFocusElement(element: HTMLElement): HTMLElement {
  if (element.getAttribute("role") !== "radiogroup") return element;
  const active = document.activeElement;
  if (active instanceof HTMLElement && element.contains(active)) return active;
  return element.querySelector<HTMLElement>("input[tabindex='0']") ?? element;
}
