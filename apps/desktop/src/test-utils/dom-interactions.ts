import { act } from 'react';
import { expect } from 'vitest';

/** Dispatches a bubbling click inside act(), asserting the target exists. */
export async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeInstanceOf(HTMLElement);
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Finds a button whose text content contains `text`. */
export function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.includes(text),
  );
}

/**
 * Writes into a controlled input/textarea through the native value setter so
 * React's onChange sees the update, then dispatches input + change.
 */
export async function inputText(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Selects an option through the native value setter and dispatches change. */
export async function selectValue(element: HTMLSelectElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  await act(async () => {
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
