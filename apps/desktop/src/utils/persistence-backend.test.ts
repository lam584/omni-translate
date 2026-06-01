import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { CompositeBackend, LocalStorageBackend, SqliteBackend, type PersistenceBackend } from './persistence-backend';

function backend(overrides: Partial<PersistenceBackend> = {}): PersistenceBackend {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe('persistence backends', () => {
  beforeEach(() => {
    invokeMock.mockReset();
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

  it('maps sqlite invoke results and failures to stable backend behavior', async () => {
    const storage = new SqliteBackend();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'load_config_draft') {
        return { saved: true };
      }
      if (command === 'list_commands') {
        return ['delete_config_draft'];
      }
      return undefined;
    });

    await storage.save('draft', { saved: true });
    expect(await storage.load('draft')).toEqual({ saved: true });
    expect(await storage.exists('draft')).toBe(true);
    await storage.delete('draft');
    expect(invokeMock).toHaveBeenCalledWith('delete_config_draft');

    expect(await storage.load('')).toBeNull();
    expect(await storage.exists('')).toBe(false);
    await expect(storage.delete('')).resolves.toBeUndefined();

    invokeMock.mockRejectedValue(new Error('offline'));
    await expect(storage.save('draft', {})).rejects.toThrow('SqliteBackend');
    expect(await storage.load('draft')).toBeNull();
    expect(await storage.exists('draft')).toBe(false);
    await expect(storage.delete('draft')).resolves.toBeUndefined();
  });

  it('uses the fallback backend when the primary backend is unavailable', async () => {
    const primary = backend({
      save: vi.fn().mockRejectedValue(new Error('offline')),
      load: vi.fn().mockRejectedValue(new Error('offline')),
      delete: vi.fn().mockRejectedValue(new Error('offline')),
      exists: vi.fn().mockRejectedValue(new Error('offline')),
    });
    const fallback = backend({
      load: vi.fn().mockResolvedValue({ fallback: true }),
      exists: vi.fn().mockResolvedValue(true),
    });
    const storage = new CompositeBackend(primary, fallback);

    await storage.save('draft', { value: 1 });
    expect(await storage.load('draft')).toEqual({ fallback: true });
    await storage.delete('draft');
    expect(await storage.exists('draft')).toBe(true);

    const replacement = backend({ load: vi.fn().mockResolvedValue({ replacement: true }) });
    storage.setFallback(replacement);
    expect(await storage.load('draft')).toEqual({ replacement: true });
  });

  it('returns safe defaults when both composite backends fail', async () => {
    const failed = () =>
      backend({
        save: vi.fn().mockRejectedValue(new Error('offline')),
        load: vi.fn().mockRejectedValue(new Error('offline')),
        delete: vi.fn().mockRejectedValue(new Error('offline')),
        exists: vi.fn().mockRejectedValue(new Error('offline')),
      });
    const storage = new CompositeBackend(failed(), failed());

    await expect(storage.save('draft', {})).rejects.toThrow('CompositeBackend');
    await expect(storage.delete('draft')).resolves.toBeUndefined();
    expect(await storage.load('draft')).toBeNull();
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

  it('uses sqlite null defaults, skips unsupported deletes and keeps composite primary results', async () => {
    const sqlite = new SqliteBackend();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'list_commands') {
        return [];
      }
      return undefined;
    });
    expect(await sqlite.load('draft')).toBeNull();
    await sqlite.delete('draft');
    expect(invokeMock).not.toHaveBeenCalledWith('delete_config_draft');

    const primary = backend({
      load: vi.fn().mockResolvedValue({ primary: true }),
      exists: vi.fn().mockResolvedValue(true),
    });
    const fallback = backend();
    const composite = new CompositeBackend(primary, fallback);
    await composite.save('draft', { value: 1 });
    expect(await composite.load('draft')).toEqual({ primary: true });
    await composite.delete('draft');
    expect(await composite.exists('draft')).toBe(true);
    expect(fallback.save).not.toHaveBeenCalled();
    expect(fallback.load).not.toHaveBeenCalled();
    expect(fallback.delete).not.toHaveBeenCalled();
    expect(fallback.exists).not.toHaveBeenCalled();
  });
});
