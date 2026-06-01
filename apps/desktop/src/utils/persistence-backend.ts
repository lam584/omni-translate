import { invoke } from '@tauri-apps/api/core';

export interface PersistenceBackend {
  save<T>(key: string, value: T): Promise<void>;
  load<T>(key: string): Promise<T | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

function canUseLocalStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export class LocalStorageBackend implements PersistenceBackend {
  async save<T>(key: string, value: T): Promise<void> {
    if (!canUseLocalStorage()) {
      return;
    }

    try {
      const serialized = JSON.stringify(value);
      window.localStorage.setItem(key, serialized);
    } catch {
      // Silently fail if storage is full or unavailable
    }
  }

  async load<T>(key: string): Promise<T | null> {
    if (!canUseLocalStorage()) {
      return null;
    }

    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) {
        return null;
      }

      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    if (!canUseLocalStorage()) {
      return;
    }

    try {
      window.localStorage.removeItem(key);
    } catch {
      // Silently fail
    }
  }

  async exists(key: string): Promise<boolean> {
    if (!canUseLocalStorage()) {
      return false;
    }

    try {
      return window.localStorage.getItem(key) !== null;
    } catch {
      return false;
    }
  }
}

const SQLITE_DELETE_COMMAND = 'delete_config_draft';

export class SqliteBackend implements PersistenceBackend {
  async save<T>(key: string, value: T): Promise<void> {
    try {
      await invoke('save_config_draft', { config: value });
    } catch {
      throw new Error(`SqliteBackend: 保存键 "${key}" 失败`);
    }
  }

  async load<T>(key: string): Promise<T | null> {
    if (key.length === 0) {
      return null;
    }

    try {
      const result = await invoke<T>('load_config_draft');
      return result ?? null;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    if (key.length === 0) {
      return;
    }

    try {
      const commands = await invoke<string[]>('list_commands');
      if (commands.includes(SQLITE_DELETE_COMMAND)) {
        await invoke(SQLITE_DELETE_COMMAND);
      }
    } catch {
      // Silently fail if delete command is unavailable
    }
  }

  async exists(key: string): Promise<boolean> {
    if (key.length === 0) {
      return false;
    }

    try {
      const result = await invoke<unknown>('load_config_draft');
      return result !== null && result !== undefined;
    } catch {
      return false;
    }
  }
}

export class CompositeBackend implements PersistenceBackend {
  private primary: PersistenceBackend;
  private fallback: PersistenceBackend;

  constructor(primary: PersistenceBackend, fallback: PersistenceBackend) {
    this.primary = primary;
    this.fallback = fallback;
  }

  setFallback(fallback: PersistenceBackend): void {
    this.fallback = fallback;
  }

  async save<T>(key: string, value: T): Promise<void> {
    try {
      await this.primary.save(key, value);
    } catch {
      try {
        await this.fallback.save(key, value);
      } catch {
        throw new Error(`CompositeBackend: 保存键 "${key}" 失败（主后端和后备后端均失败）`);
      }
    }
  }

  async load<T>(key: string): Promise<T | null> {
    try {
      const result = await this.primary.load<T>(key);
      if (result !== null) {
        return result;
      }
    } catch {
      // Fall through to fallback
    }

    try {
      return await this.fallback.load<T>(key);
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.primary.delete(key);
    } catch {
      try {
        await this.fallback.delete(key);
      } catch {
        // Both failed, nothing more we can do
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      if (await this.primary.exists(key)) {
        return true;
      }
    } catch {
      // Fall through to fallback
    }

    try {
      return await this.fallback.exists(key);
    } catch {
      return false;
    }
  }
}
