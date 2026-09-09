import './styles/tokens.css';
import './styles/shell.css';
import './styles/panels.css';
import './styles/layers.css';
import './styles/chrome.css';
import './styles/dialog.css';
import './styles/tools.css';

import { ColourState } from './core/colour-state';
import { Compositor } from './core/compositor';
import { PixelDocument } from './core/document';
import { History } from './core/history';
import { createLayer } from './core/layer';
import { Viewport } from './core/viewport';
import { createHandTool } from './tools/hand-tool';
import { createMoveTool } from './tools/move-tool';
import { createZoomTool } from './tools/zoom-tool';
import { ToolManager } from './tools/tool-manager';
import { attachViewportNavigation } from './view/navigation';
import { ViewRenderer } from './view/renderer';
import { createAppShell } from './ui/shell';
import { attachFileInput } from './ui/file-drop';
import { FileActions } from './ui/file-actions';
import { buildMenuBar } from './ui/menubar';
import { attachColourShortcuts } from './ui/colour-shortcuts';
import { ColourSwatches } from './ui/colour-swatches';
import { NoticeStack } from './ui/notice';
import { OptionsBar } from './ui/options-bar';
import { ToolRail } from './ui/tool-rail';
import { attachViewShortcuts } from './ui/view-shortcuts';
import { UnsavedGuard } from './ui/unsaved-guard';
import { attachLayerShortcuts } from './ui/layer-shortcuts';
import { HistoryPanel } from './ui/panels/history-panel';
import { LayersPanel } from './ui/panels/layers-panel';
import { attachHistoryShortcuts } from './ui/shortcuts';
import { StatusBar } from './ui/statusbar';
import { ThumbnailCache } from './ui/thumbnails';

const BOOT_WIDTH = 1200;
const BOOT_HEIGHT = 800;

function boot(): void {
  const mount = document.querySelector<HTMLElement>('#app');
  if (!mount) throw new Error('Missing #app mount point.');

  const shell = createAppShell(mount);

  const doc = new PixelDocument(BOOT_WIDTH, BOOT_HEIGHT);
  doc.addLayer(
    createLayer({
      name: 'Background',
      width: BOOT_WIDTH,
      height: BOOT_HEIGHT,
      fill: '#ffffff',
    }),
  );

  const compositor = new Compositor(doc);
  const viewport = new Viewport();
  viewport.setContentSize(doc.width, doc.height);

  const statusBar = new StatusBar(shell.statusBar, {
    onZoomEntered: (zoom) => viewport.setZoom(zoom),
  });
  const renderer = new ViewRenderer(shell.stage, doc, compositor, viewport);

  viewport.onChange = () => {
    renderer.invalidate();
    statusBar.setZoom(viewport.zoom);
  };

  const history = new History(doc, 'New Document');

  // Anything that changes the document re-syncs the composite (which also
  // picks up a document resize) and asks the view for a fresh frame.
  const documentChanged = (): void => {
    compositor.syncSize();
    viewport.setContentSize(doc.width, doc.height);
    statusBar.setDocumentSize(doc.width, doc.height);
    renderer.invalidate();
  };
  history.subscribe(documentChanged);
  // Any recorded change means this is no longer an untouched boot document.
  history.subscribe(() => {
    if (history.canUndo) doc.pristine = false;
  });

  const thumbnails = new ThumbnailCache(() => doc.layers);
  const layersPanel = new LayersPanel(doc, history, thumbnails, documentChanged);
  const historyPanel = new HistoryPanel(history);
  shell.panels.append(layersPanel.root, historyPanel.root);

  attachHistoryShortcuts(history);
  attachLayerShortcuts(layersPanel);

  // ---- files in and out ----
  const notices = new NoticeStack(document.body);
  const unsavedGuard = new UnsavedGuard(history);

  const fileActions = new FileActions({
    doc,
    history,
    notices,
    onDocumentChanged: documentChanged,
    onDocumentResized: () => {
      thumbnails.markAllDirty();
      viewport.fitToScreen(doc.width, doc.height);
    },
    onSaved: () => unsavedGuard.markSaved(),
  });

  buildMenuBar(shell.menuBar, [
    {
      label: 'File',
      items: [
        { label: 'New…', shortcut: 'Ctrl+N', run: () => fileActions.newDocument() },
        { label: 'Open…', shortcut: 'Ctrl+O', run: () => fileActions.chooseFiles() },
        { label: 'Export As…', shortcut: 'Ctrl+Shift+S', run: () => fileActions.exportImage() },
      ],
    },
  ]);

  attachFileInput(shell.stage, fileActions);

  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();

    if (key === 'n' && !event.shiftKey) fileActions.newDocument();
    else if (key === 'o') fileActions.chooseFiles();
    else if (key === 's' && event.shiftKey) fileActions.exportImage();
    else return;

    event.preventDefault();
  });

  attachViewportNavigation(renderer.canvas, viewport, {
    onPointerPosition: (point) => statusBar.setPointer(point),
  });
  attachViewShortcuts(viewport, doc);

  // ---- tools ----
  const colours = new ColourState();
  const toolManager = new ToolManager({
    surface: renderer.canvas,
    doc,
    history,
    viewport,
    colours,
    requestRender: renderer.invalidate,
    invalidateComposite: documentChanged,
  });

  renderer.setOverlayPainter((ctx) => toolManager.drawOverlay(ctx));

  toolManager.register(createMoveTool());
  toolManager.register(createHandTool());
  toolManager.register(createZoomTool());
  // Holding Space borrows the Hand tool and springs back on release. Step 15
  // registers Alt for the Eyedropper the same way, once that tool exists.
  toolManager.registerTemporaryOverride('space', 'hand');

  new ToolRail(shell.toolRail, toolManager);
  new OptionsBar(shell.optionsBar, toolManager);
  new ColourSwatches(shell.toolRail, colours);
  attachColourShortcuts(colours);

  statusBar.setDocumentSize(doc.width, doc.height);
  statusBar.setZoom(viewport.zoom);

  // The stage normally has its size on the first layout pass; if it does not
  // yet, fit as soon as it gets one so the document is never left uncentred.
  const fitBootDocument = (): boolean => {
    if (viewport.viewWidth <= 0 || viewport.viewHeight <= 0) return false;
    viewport.fitToScreen(doc.width, doc.height);
    return true;
  };

  if (!fitBootDocument()) {
    const waitForSize = new ResizeObserver(() => {
      if (fitBootDocument()) waitForSize.disconnect();
    });
    waitForSize.observe(shell.stage);
  }

  renderer.start();
}

boot();
