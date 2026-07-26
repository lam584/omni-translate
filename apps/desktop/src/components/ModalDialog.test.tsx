import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModalDialog from './ModalDialog';

describe('ModalDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const pressEscape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

  it('renders backdrop, variant modifier, dialog semantics and children', async () => {
    await act(async () => root.render(
      <ModalDialog aria-label="Example dialog" className="example-panel" onClose={vi.fn()} variant="provider">
        <p>Body</p>
      </ModalDialog>,
    ));

    const backdrop = container.querySelector('.modal-backdrop')!;
    expect(backdrop.classList.contains('modal-backdrop--provider')).toBe(true);
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.classList.contains('example-panel')).toBe(true);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Example dialog');
    expect(dialog.textContent).toBe('Body');
  });

  it('omits the variant modifier when no variant is given', async () => {
    await act(async () => root.render(<ModalDialog onClose={vi.fn()}><p>Body</p></ModalDialog>));
    expect(container.querySelector<HTMLElement>('.modal-backdrop')!.className).toBe('modal-backdrop');
  });

  it('closes on backdrop click but not on panel click', async () => {
    const onClose = vi.fn();
    await act(async () => root.render(<ModalDialog onClose={onClose} variant="glossary"><button type="button">Inner</button></ModalDialog>));

    await act(async () => container.querySelector<HTMLElement>('[role="dialog"]')?.click());
    await act(async () => container.querySelector<HTMLElement>('button')?.click());
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => container.querySelector<HTMLElement>('.modal-backdrop--glossary')?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape by default and closes on Escape only when opted in', async () => {
    const onClose = vi.fn();
    await act(async () => root.render(<ModalDialog onClose={onClose}><p>Body</p></ModalDialog>));
    await act(async () => { pressEscape(); });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => root.render(<ModalDialog closeOnEscape onClose={onClose}><p>Body</p></ModalDialog>));
    await act(async () => { pressEscape(); });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<ModalDialog onClose={onClose}><p>Body</p></ModalDialog>));
    await act(async () => { pressEscape(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
