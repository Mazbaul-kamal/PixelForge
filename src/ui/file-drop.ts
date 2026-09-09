import type { FileActions } from './file-actions';

/**
 * Drag-and-drop onto the canvas stage, plus clipboard paste.
 *
 * Drag counting matters: dragenter and dragleave fire for every child element
 * the pointer crosses, so a naive show/hide flickers.
 */
export function attachFileInput(stage: HTMLElement, actions: FileActions): () => void {
  const overlay = document.createElement('div');
  overlay.className = 'pf-drop-overlay';
  overlay.hidden = true;

  const message = document.createElement('div');
  message.className = 'pf-drop-message';
  message.textContent = 'Drop images to add them as layers';
  overlay.appendChild(message);
  stage.appendChild(overlay);

  let depth = 0;
  const setVisible = (visible: boolean): void => {
    overlay.hidden = !visible;
  };

  const hasFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files');

  const onDragEnter = (event: DragEvent): void => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    setVisible(true);
  };

  const onDragOver = (event: DragEvent): void => {
    if (!hasFiles(event)) return;
    // Without this the browser navigates to the dropped file instead.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (event: DragEvent): void => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) setVisible(false);
  };

  const onDrop = (event: DragEvent): void => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    setVisible(false);

    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length > 0) void actions.openFiles(files);
  };

  const onPaste = (event: ClipboardEvent): void => {
    const items = [...(event.clipboardData?.items ?? [])];
    if (items.length === 0) return;

    void actions.pasteImages(items).then((handled) => {
      if (handled) event.preventDefault();
    });
  };

  stage.addEventListener('dragenter', onDragEnter);
  stage.addEventListener('dragover', onDragOver);
  stage.addEventListener('dragleave', onDragLeave);
  stage.addEventListener('drop', onDrop);
  window.addEventListener('paste', onPaste);

  return () => {
    stage.removeEventListener('dragenter', onDragEnter);
    stage.removeEventListener('dragover', onDragOver);
    stage.removeEventListener('dragleave', onDragLeave);
    stage.removeEventListener('drop', onDrop);
    window.removeEventListener('paste', onPaste);
    overlay.remove();
  };
}
