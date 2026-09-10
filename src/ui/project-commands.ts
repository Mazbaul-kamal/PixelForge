import { buildRecord } from '../core/autosave';
import type { Autosave } from '../core/autosave';
import type { PixelDocument } from '../core/document';
import type { History } from '../core/history';
import { restoreProject } from '../core/project-format';
import type { StoredDocument } from '../core/project-format';
import {
  formatBytes, ProjectStore, requestPersistentStorage, storageReport,
} from '../core/project-store';
import type { ProjectRecord } from '../core/project-store';
import { readZip, writeZip } from '../core/project-zip';
import type { ZipEntry } from '../core/project-zip';
import { downloadBlob } from '../core/export';
import type { Viewport } from '../core/viewport';
import { openProjectBrowser, openRecoveryPrompt } from './dialogs/project-browser';

/** Warn once the browser's allowance is this full. */
const QUOTA_WARNING = 0.8;

export interface ProjectDeps {
  readonly doc: PixelDocument;
  readonly history: History;
  readonly viewport: Viewport;
  readonly store: ProjectStore;
  readonly composite: () => HTMLCanvasElement;
  readonly onRestored: () => void;
  readonly notify: (title: string, detail?: string) => void;
  readonly warn: (title: string, detail?: string) => void;
  readonly track: <T>(label: string, work: Promise<T>) => Promise<T>;
}

function newProjectId(): string {
  return `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Saving, opening and recovering projects.
 *
 * Every write goes through IndexedDB asynchronously, so painting is never
 * waiting on storage.
 */
export class ProjectCommands {
  private readonly deps: ProjectDeps;
  private currentId: string = newProjectId();
  private autosave: Autosave | null = null;
  private warnedAboutQuota = false;

  constructor(deps: ProjectDeps) {
    this.deps = deps;
    void requestPersistentStorage();
  }

  attachAutosave(autosave: Autosave): void {
    this.autosave = autosave;
  }

  get projectId(): string {
    return this.currentId;
  }

  private buildDeps() {
    return {
      doc: this.deps.doc,
      store: this.deps.store,
      projectId: () => this.currentId,
      viewport: () => ({
        zoom: this.deps.viewport.zoom,
        panX: this.deps.viewport.panX,
        panY: this.deps.viewport.panY,
      }),
      composite: this.deps.composite,
    };
  }

  async save(): Promise<void> {
    const record = await this.deps.track(
      'Saving project…',
      buildRecord(this.buildDeps(), this.currentId),
    );

    await this.deps.store.saveProject(record);
    await this.deps.store.clearRecovery(this.currentId);
    this.autosave?.adopt(record);

    this.deps.notify(`Saved “${record.name}”.`, `${formatBytes(record.bytes)} stored locally.`);
    void this.checkQuota();
  }

  async saveAs(name: string): Promise<void> {
    this.deps.doc.name = name.trim() || 'Untitled';
    this.currentId = newProjectId();
    await this.save();
  }

  async browse(): Promise<void> {
    const [projects, storage] = await Promise.all([
      this.deps.store.listProjects(),
      storageReport(),
    ]);

    openProjectBrowser({
      projects,
      storage,
      onOpen: (id) => void this.open(id),
      onDelete: (id) => {
        void this.deps.store.deleteProject(id);
        this.deps.notify('Project deleted.');
      },
    });
  }

  async open(id: string): Promise<void> {
    const record = await this.deps.track('Opening project…', this.deps.store.loadProject(id));
    if (!record) {
      this.deps.warn('That project could not be found.', 'It may have been deleted.');
      return;
    }
    await this.applyRecord(record);
    this.currentId = id;
  }

  private async applyRecord(record: ProjectRecord): Promise<void> {
    const blobs = new Map(Object.entries(record.blobs));
    const viewport = await restoreProject(this.deps.doc, record.document, blobs);

    this.deps.history.clear(`Open ${record.name}`);
    this.deps.viewport.setContentSize(this.deps.doc.width, this.deps.doc.height);
    this.deps.viewport.zoom = viewport.zoom;
    this.deps.viewport.panTo(viewport.panX, viewport.panY);
    this.deps.onRestored();
  }

  /**
   * On startup, offer any recovery snapshot that is newer than its saved
   * project. Never restores silently: unsaved work being replaced without
   * being asked is worse than losing it.
   */
  async offerRecovery(): Promise<boolean> {
    const recoveries = await this.deps.store.listRecoveries();
    const newest = recoveries[0];
    if (!newest) return false;

    const saved = await this.deps.store.loadProject(newest.id);
    if (saved && saved.updated >= newest.updated) return false;

    return new Promise<boolean>((resolve) => {
      openRecoveryPrompt(newest.name, newest.updated, (restore) => {
        if (!restore) {
          void this.deps.store.clearRecovery(newest.id);
          resolve(false);
          return;
        }
        void (async () => {
          const record = await this.deps.store.loadRecovery(newest.id);
          if (record) {
            await this.applyRecord(record);
            this.currentId = record.id;
            this.deps.notify(`Recovered “${record.name}”.`);
          }
          resolve(true);
        })();
      });
    });
  }

  private async checkQuota(): Promise<void> {
    const report = await storageReport();
    if (!report || report.ratio < QUOTA_WARNING || this.warnedAboutQuota) return;

    this.warnedAboutQuota = true;
    this.deps.warn(
      'Local storage is nearly full.',
      `${formatBytes(report.usage)} of ${formatBytes(report.quota)} is in use. ` +
        'Delete old projects from File then Projects to make room.',
    );
  }

  /** Writes the project as a zip of JSON plus PNG layers. */
  async exportZip(): Promise<void> {
    const record = await this.deps.track(
      'Packing project…',
      buildRecord(this.buildDeps(), this.currentId),
    );

    const encoder = new TextEncoder();
    const entries: ZipEntry[] = [
      { name: 'project.json', data: encoder.encode(JSON.stringify(record.document, null, 2)) },
    ];
    for (const [key, blob] of Object.entries(record.blobs)) {
      entries.push({ name: `layers/${key}`, data: new Uint8Array(await blob.arrayBuffer()) });
    }

    downloadBlob(writeZip(entries), `${record.name || 'Untitled'}.pixelforge.zip`);
    this.deps.notify(`Exported “${record.name}”.`);
  }

  async importZip(file: File): Promise<void> {
    try {
      const entries = await this.deps.track('Reading project…', readZip(file));
      const manifest = entries.get('project.json');
      if (!manifest) {
        this.deps.warn('That zip is not a PixelForge project.', 'It has no project.json inside.');
        return;
      }

      const stored = JSON.parse(new TextDecoder().decode(manifest)) as StoredDocument;
      const blobs = new Map<string, Blob>();
      for (const [name, data] of entries) {
        if (!name.startsWith('layers/')) continue;
        // Copied so the blob owns a plain buffer rather than a view into the zip.
        blobs.set(name.slice('layers/'.length), new Blob([new Uint8Array(data)], { type: 'image/png' }));
      }

      const viewport = await restoreProject(this.deps.doc, stored, blobs);
      this.deps.history.clear(`Open ${stored.name}`);
      this.currentId = newProjectId();
      this.deps.viewport.setContentSize(this.deps.doc.width, this.deps.doc.height);
      this.deps.viewport.zoom = viewport.zoom;
      this.deps.viewport.panTo(viewport.panX, viewport.panY);
      this.deps.onRestored();
      this.deps.notify(`Opened “${stored.name}”.`);
    } catch (error) {
      this.deps.warn(
        'That project could not be read.',
        error instanceof Error ? error.message : 'The file may be damaged.',
      );
    }
  }
}
