import type { PixelDocument } from '../core/document';
import { placeImages, resetDocument } from '../core/document-io';
import type { NewDocumentOptions } from '../core/document-io';
import { downloadBlob, exportFilename, renderExport } from '../core/export';
import type { ExportOptions } from '../core/export';
import type { History } from '../core/history';
import {
  decodeImage,
  exceedsLimit,
  fileBaseName,
  ImageImportError,
  MAX_IMAGE_DIMENSION,
  prepareImage,
  releaseSource,
} from '../core/image-import';
import type { PreparedImage } from '../core/image-import';
import { confirmDialog } from './dialog';
import { openExportDialog } from './dialogs/export-dialog';
import { openNewDocumentDialog } from './dialogs/new-document-dialog';
import type { NoticeStack } from './notice';

export interface FileActionDeps {
  doc: PixelDocument;
  history: History;
  notices: NoticeStack;
  /** Re-sync the composite and repaint. */
  onDocumentChanged: () => void;
  /** Called when the canvas size changed, so the view can refit. */
  onDocumentResized: () => void;
  /** Called after a successful export, to clear the unsaved marker. */
  onSaved: () => void;
}

/**
 * The one place the import and export flows live, so the menu, the drop target
 * and the clipboard all behave identically.
 */
export class FileActions {
  private readonly deps: FileActionDeps;
  private readonly picker: HTMLInputElement;

  constructor(deps: FileActionDeps) {
    this.deps = deps;

    this.picker = document.createElement('input');
    this.picker.type = 'file';
    this.picker.accept = 'image/*';
    this.picker.multiple = true;
    this.picker.hidden = true;
    this.picker.addEventListener('change', () => {
      const files = this.picker.files;
      if (files && files.length > 0) void this.openFiles([...files]);
      this.picker.value = '';
    });
    document.body.appendChild(this.picker);
  }

  destroy(): void {
    this.picker.remove();
  }

  chooseFiles(): void {
    this.picker.click();
  }

  newDocument(): void {
    const { doc, history } = this.deps;
    openNewDocumentDialog({ width: doc.width, height: doc.height }, (options: NewDocumentOptions) => {
      resetDocument(doc, history, options);
      this.deps.onDocumentResized();
      this.deps.onDocumentChanged();
      this.deps.onSaved();
      this.deps.notices.show(`New ${options.width} × ${options.height} document.`);
    });
  }

  exportImage(): void {
    const { doc, notices } = this.deps;
    openExportDialog({ width: doc.width, height: doc.height }, async (options: ExportOptions) => {
      try {
        const blob = await renderExport(doc, options);
        const filename = exportFilename(doc.name, options.format);
        downloadBlob(blob, filename);
        this.deps.onSaved();
        notices.show(`Exported ${filename}`, `${formatBytes(blob.size)} written.`);
      } catch (error) {
        notices.error(
          'Export failed.',
          error instanceof Error ? error.message : 'The browser could not encode the image.',
        );
      }
    });
  }

  /** Opens files as layers, reporting each failure without stopping the batch. */
  async openFiles(files: readonly File[]): Promise<void> {
    const prepared: PreparedImage[] = [];

    for (const file of files) {
      const image = await this.prepareOne(file, fileBaseName(file.name));
      if (image) prepared.push(image);
    }

    this.place(prepared);
  }

  /** Handles a paste, which carries blobs with no filename. */
  async pasteImages(items: readonly DataTransferItem[]): Promise<boolean> {
    const blobs = items
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (blobs.length === 0) return false;

    const prepared: PreparedImage[] = [];
    for (const blob of blobs) {
      const name = blob.name ? fileBaseName(blob.name) : 'Pasted Image';
      const image = await this.prepareOne(blob, name);
      if (image) prepared.push(image);
    }

    this.place(prepared);
    return true;
  }

  private async prepareOne(blob: Blob, name: string): Promise<PreparedImage | null> {
    const { notices } = this.deps;

    try {
      const decoded = await decodeImage(blob, name);

      if (exceedsLimit(decoded)) {
        const accepted = await confirmDialog(
          'This image is very large',
          `“${name}” is ${decoded.width} × ${decoded.height} px. Anything over ${MAX_IMAGE_DIMENSION} px ` +
            'per side makes editing slow and can exhaust memory. Scale it down to fit?',
          'Scale it down',
          'Skip this file',
        );
        if (!accepted) {
          releaseSource(decoded.source);
          return null;
        }
        return prepareImage(decoded, true);
      }

      return prepareImage(decoded, false);
    } catch (error) {
      if (error instanceof ImageImportError) notices.error(error.message, error.detail);
      else {
        notices.error(
          `“${name}” could not be opened.`,
          error instanceof Error ? error.message : 'The file could not be read.',
        );
      }
      return null;
    }
  }

  private place(prepared: readonly PreparedImage[]): void {
    if (prepared.length === 0) return;

    const result = placeImages(this.deps.doc, this.deps.history, prepared);
    if (result.replacedDocument) this.deps.onDocumentResized();
    this.deps.onDocumentChanged();

    const count = result.layerIds.length;
    this.deps.notices.show(
      count === 1 ? `Opened ${prepared[0]?.name}.` : `Opened ${count} images as ${count} layers.`,
    );
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
