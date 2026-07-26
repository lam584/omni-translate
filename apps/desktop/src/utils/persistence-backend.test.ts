import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalStorageBackend } from './persistence-backend';

describe('persistence backends', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips values through local storage and tolerates invalid json', async () => {
    const storage = new LocalStorageBackend();

    expect(await storage.load('missing')).toBeNull();
    expect(await storage.exists('draft')).toBe(false);
    await storage.save('draft', { value: 1 });
    expect(await storage.load('draft')).toEqual({ value: 1 });
    expect(await storage.exists('draft')).toBe(true);

    window.localStorage.setItem('draft', '{broken-json');
    expect(await storage.load('draft')).toBeNull();
    await storage.delete('draft');
    expect(await storage.exists('draft')).toBe(false);
  });

  it('tolerates unavailable and throwing local storage implementations', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { value: undefined, configurable: true });
    const storage = new LocalStorageBackend();
    await expect(storage.save('draft', {})).resolves.toBeUndefined();
    expect(await storage.load('draft')).toBeNull();
    await expect(storage.delete('draft')).resolves.toBeUndefined();
    expect(await storage.exists('draft')).toBe(false);

    Object.defineProperty(window, 'localStorage', descriptor!);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    await expect(storage.save('draft', {})).resolves.toBeUndefined();
    setItem.mockRestore();
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    expect(await storage.exists('draft')).toBe(false);
    getItem.mockRestore();
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    await expect(storage.delete('draft')).resolves.toBeUndefined();
    removeItem.mockRestore();
  });
});
