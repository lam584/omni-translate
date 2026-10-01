/**
 * Determines whether a contextmenu event should be allowed to display
 * the browser / system native context menu (e.g. for editable input controls).
 */
export function isEditableElement(element: EventTarget | null): boolean {
  if (!element || !(element instanceof Element)) {
    return false;
  }

  // Check if inside input or textarea
  const textControl = element.closest("input, textarea");
  if (textControl instanceof HTMLInputElement) {
    // Non-text input types like button, checkbox, radio, file etc. do not need native context menu
    const nonTextTypes = new Set([
      "button",
      "checkbox",
      "color",
      "file",
      "hidden",
      "image",
      "radio",
      "range",
      "reset",
      "submit",
    ]);
    if (nonTextTypes.has(textControl.type)) {
      return false;
    }
    return !textControl.disabled && !textControl.readOnly;
  }
  if (textControl instanceof HTMLTextAreaElement) {
    return !textControl.disabled && !textControl.readOnly;
  }

  // Check contenteditable
  const editableElement = element.closest("[contenteditable]");
  if (editableElement instanceof HTMLElement) {
    const isContentEditable = editableElement.isContentEditable;
    const attr = editableElement.getAttribute("contenteditable");
    if (isContentEditable || (attr !== null && attr !== "false")) {
      return true;
    }
  }

  return false;
}

/**
 * Installs a global contextmenu listener that disables the default WebView
 * right-click menu (Back / Forward / Reload / Save As / Print / Inspect)
 * across the app, while allowing native context menus on editable input fields
 * and textareas, and preserving custom in-app context menus.
 */
export function installContextMenuGuard(target: EventTarget = window): () => void {
  const handleContextMenu = (event: Event) => {
    // If an editable control was right-clicked, preserve native behavior for copy/cut/paste
    if (isEditableElement(event.target)) {
      return;
    }

    // Otherwise prevent the default browser/WebView context menu
    event.preventDefault();
  };

  target.addEventListener("contextmenu", handleContextMenu);
  return () => {
    target.removeEventListener("contextmenu", handleContextMenu);
  };
}
