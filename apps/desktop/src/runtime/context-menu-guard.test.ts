import { describe, expect, it } from "vitest";
import { installContextMenuGuard, isEditableElement } from "./context-menu-guard";

describe("context-menu-guard", () => {
  describe("isEditableElement", () => {
    it("returns false for non-elements or null", () => {
      expect(isEditableElement(null)).toBe(false);
      expect(isEditableElement(undefined as unknown as EventTarget)).toBe(false);
      expect(isEditableElement(document.createTextNode("text"))).toBe(false);
    });

    it("returns true for standard editable text inputs", () => {
      const input = document.createElement("input");
      input.type = "text";
      document.body.appendChild(input);
      expect(isEditableElement(input)).toBe(true);
      input.remove();

      const password = document.createElement("input");
      password.type = "password";
      document.body.appendChild(password);
      expect(isEditableElement(password)).toBe(true);
      password.remove();

      const urlInput = document.createElement("input");
      urlInput.type = "url";
      document.body.appendChild(urlInput);
      expect(isEditableElement(urlInput)).toBe(true);
      urlInput.remove();
    });

    it("returns false for non-text or disabled / readonly inputs", () => {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      document.body.appendChild(checkbox);
      expect(isEditableElement(checkbox)).toBe(false);
      checkbox.remove();

      const button = document.createElement("input");
      button.type = "button";
      document.body.appendChild(button);
      expect(isEditableElement(button)).toBe(false);
      button.remove();

      const disabledInput = document.createElement("input");
      disabledInput.type = "text";
      disabledInput.disabled = true;
      document.body.appendChild(disabledInput);
      expect(isEditableElement(disabledInput)).toBe(false);
      disabledInput.remove();

      const readonlyInput = document.createElement("input");
      readonlyInput.type = "text";
      readonlyInput.readOnly = true;
      document.body.appendChild(readonlyInput);
      expect(isEditableElement(readonlyInput)).toBe(false);
      readonlyInput.remove();
    });

    it("returns true for textareas unless disabled / readonly", () => {
      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);
      expect(isEditableElement(textarea)).toBe(true);

      textarea.disabled = true;
      expect(isEditableElement(textarea)).toBe(false);

      textarea.disabled = false;
      textarea.readOnly = true;
      expect(isEditableElement(textarea)).toBe(false);
      textarea.remove();
    });

    it("returns true for contenteditable elements and their descendants", () => {
      const editableDiv = document.createElement("div");
      editableDiv.setAttribute("contenteditable", "true");
      const span = document.createElement("span");
      editableDiv.appendChild(span);
      document.body.appendChild(editableDiv);

      expect(isEditableElement(editableDiv)).toBe(true);
      expect(isEditableElement(span)).toBe(true);

      editableDiv.setAttribute("contenteditable", "false");
      expect(isEditableElement(editableDiv)).toBe(false);
      expect(isEditableElement(span)).toBe(false);

      editableDiv.remove();
    });

    it("returns false for ordinary elements like button, div, span", () => {
      const div = document.createElement("div");
      const button = document.createElement("button");
      document.body.appendChild(div);
      document.body.appendChild(button);

      expect(isEditableElement(div)).toBe(false);
      expect(isEditableElement(button)).toBe(false);

      div.remove();
      button.remove();
    });
  });

  describe("installContextMenuGuard", () => {
    it("prevents default context menu on non-editable elements", () => {
      const target = document.createElement("div");
      document.body.appendChild(target);

      const cleanup = installContextMenuGuard(target);

      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);

      cleanup();
      target.remove();
    });

    it("allows default context menu on editable text input", () => {
      const container = document.createElement("div");
      const input = document.createElement("input");
      input.type = "text";
      container.appendChild(input);
      document.body.appendChild(container);

      const cleanup = installContextMenuGuard(container);

      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);

      cleanup();
      container.remove();
    });

    it("allows default context menu on textarea", () => {
      const container = document.createElement("div");
      const textarea = document.createElement("textarea");
      container.appendChild(textarea);
      document.body.appendChild(container);

      const cleanup = installContextMenuGuard(container);

      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      textarea.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);

      cleanup();
      container.remove();
    });

    it("cleans up listener on uninstall", () => {
      const target = document.createElement("div");
      document.body.appendChild(target);

      const cleanup = installContextMenuGuard(target);
      cleanup();

      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);

      target.remove();
    });
  });
});
