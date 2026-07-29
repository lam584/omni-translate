import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { registerDomHarness } from '../test-utils/component-test-harness';
import ModalDialog from './ModalDialog';

describe('ModalDialog', () => {
  const view = registerDomHarness();

  const pressEscape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

  it('renders backdrop, variant modifier, dialog semantics and children', async () => {
    await view.render(
      <ModalDialog aria-label="Example dialog" className="example-panel" onClose={vi.fn()} variant="provider">
        <p>Body</p>
      </ModalDialog>,
    );

    const backdrop = view.container.querySelector('.modal-backdrop')!;
    expect(backdrop.classList.contains('modal-backdrop--provider')).toBe(true);
    const dialog = view.container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.classList.contains('example-panel')).toBe(true);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Example dialog');
    expect(dialog.textContent).toBe('Body');
  });

  it('omits the variant modifier when no variant is given', async () => {
    await view.render(<ModalDialog onClose={vi.fn()}><p>Body</p></ModalDialog>);
    expect(view.container.querySelector<HTMLElement>('.modal-backdrop')!.className).toBe('modal-backdrop');
  });

  it('closes on backdrop click but not on panel click', async () => {
    const onClose = vi.fn();
    await view.render(<ModalDialog onClose={onClose} variant="glossary"><button type="button">Inner</button></ModalDialog>);

    await act(async () => view.container.querySelector<HTMLElement>('[role="dialog"]')?.click());
    await act(async () => view.container.querySelector<HTMLElement>('button')?.click());
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => view.container.querySelector<HTMLElement>('.modal-backdrop--glossary')?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape by default and closes on Escape only when opted in', async () => {
    const onClose = vi.fn();
    await view.render(<ModalDialog onClose={onClose}><p>Body</p></ModalDialog>);
    await act(async () => { pressEscape(); });
    expect(onClose).not.toHaveBeenCalled();

    await view.render(<ModalDialog closeOnEscape onClose={onClose}><p>Body</p></ModalDialog>);
    await act(async () => { pressEscape(); });
    expect(onClose).toHaveBeenCalledTimes(1);

    await view.render(<ModalDialog onClose={onClose}><p>Body</p></ModalDialog>);
    await act(async () => { pressEscape(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
