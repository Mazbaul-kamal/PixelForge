import type { StoredDocument } from './project-format';

const DATABASE = 'pixelforge';
const VERSION = 1;
const PROJECTS = 'projects';
const RECOVERY = 'recovery';

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly updated: number;
  readonly bytes: number;
  readonly thumbnail: Blob | null;
  readonly document: StoredDocument;
  /** PNG blobs keyed by the names the document refers to. */
  readonly blobs: Record<string, Blob>;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly updated: number;
  readonly bytes: number;
  readonly thumbnail: Blob | null;
}

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error('The database request failed.'));
  });
}

/**
 * Projects live in IndexedDB, not localStorage: layer bitmaps run to megabytes
 * and localStorage holds a few megabytes of strings at most. Everything here
 * is asynchronous, so a save never blocks the render loop.
 */
export class ProjectStore {
  private database: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;

    this.database = new Promise((resolve, reject) => {
      const opening = indexedDB.open(DATABASE, VERSION);
      opening.onupgradeneeded = () => {
        const db = opening.result;
        if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(RECOVERY)) db.createObjectStore(RECOVERY, { keyPath: 'id' });
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error('Could not open local storage.'));
    });
    return this.database;
  }

  private async put(store: string, record: ProjectRecord): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(store, 'readwrite');
      transaction.objectStore(store).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('The save failed.'));
    });
  }

  saveProject(record: ProjectRecord): Promise<void> {
    return this.put(PROJECTS, record);
  }

  /** The recovery slot is per project, so autosaves never clobber a save. */
  saveRecovery(record: ProjectRecord): Promise<void> {
    return this.put(RECOVERY, record);
  }

  async loadProject(id: string): Promise<ProjectRecord | null> {
    const db = await this.open();
    const store = db.transaction(PROJECTS, 'readonly').objectStore(PROJECTS);
    return (await request(store.get(id))) ?? null;
  }

  async loadRecovery(id: string): Promise<ProjectRecord | null> {
    const db = await this.open();
    const store = db.transaction(RECOVERY, 'readonly').objectStore(RECOVERY);
    return (await request(store.get(id))) ?? null;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const db = await this.open();
    const store = db.transaction(PROJECTS, 'readonly').objectStore(PROJECTS);
    const records = (await request(store.getAll())) as ProjectRecord[];
    return records
      .map(({ id, name, updated, bytes, thumbnail }) => ({ id, name, updated, bytes, thumbnail }))
      .sort((a, b) => b.updated - a.updated);
  }

  async listRecoveries(): Promise<ProjectSummary[]> {
    const db = await this.open();
    const store = db.transaction(RECOVERY, 'readonly').objectStore(RECOVERY);
    const records = (await request(store.getAll())) as ProjectRecord[];
    return records
      .map(({ id, name, updated, bytes, thumbnail }) => ({ id, name, updated, bytes, thumbnail }))
      .sort((a, b) => b.updated - a.updated);
  }

  async deleteProject(id: string): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([PROJECTS, RECOVERY], 'readwrite');
      transaction.objectStore(PROJECTS).delete(id);
      transaction.objectStore(RECOVERY).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('The delete failed.'));
    });
  }

  async clearRecovery(id: string): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve) => {
      const transaction = db.transaction(RECOVERY, 'readwrite');
      transaction.objectStore(RECOVERY).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
    });
  }
}

export interface StorageReport {
  readonly usage: number;
  readonly quota: number;
  readonly ratio: number;
  readonly persisted: boolean;
}

/** Usage against quota, for the readout and the near-full warning. */
export async function storageReport(): Promise<StorageReport | null> {
  if (!navigator.storage?.estimate) return null;

  const estimate = await navigator.storage.estimate();
  const usage = estimate.usage ?? 0;
  const quota = estimate.quota ?? 0;
  const persisted = (await navigator.storage.persisted?.()) ?? false;

  return { usage, quota, ratio: quota > 0 ? usage / quota : 0, persisted };
}

/**
 * Asks the browser not to evict this origin's data. Without it a project can
 * be thrown away when the device is short of space.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted?.()) return true;
  return navigator.storage.persist();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
