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
