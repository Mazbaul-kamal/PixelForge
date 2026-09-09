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
import { createBrushTool } from './tools/brush-tool';
import { fillThroughMasks, patternPaint, solidPaint } from './core/fill-ops';
import { FloodRunner } from './core/flood-runner';
import { cloneGradient, gradientPresets } from './core/gradient';
import type { GradientDefinition } from './core/gradient';
import { builtInPatterns, patternFromSelection } from './core/patterns';
import type { PatternDefinition } from './core/patterns';
import { SelectionMask } from './core/selection';
import { deselect, invertSelection, selectAll, setSelection } from './core/selection-ops';
import { createLassoTool } from './tools/lasso-tool';
import { createBucketTool } from './tools/bucket-tool';
import { createGradientTool } from './tools/gradient-tool';
import { createMagicWandTool } from './tools/magic-wand-tool';
import { createMarqueeTool } from './tools/marquee-tool';
import { createPolygonLassoTool } from './tools/polygon-lasso-tool';
import { createEraserTool } from './tools/eraser-tool';
import { createHandTool } from './tools/hand-tool';
import { createMoveTool } from './tools/move-tool';
import { createZoomTool } from './tools/zoom-tool';
import { ToolManager } from './tools/tool-manager';
import { attachViewportNavigation } from './view/navigation';
import { ViewRenderer } from './view/renderer';
import { SelectionOverlay } from './view/selection-overlay';
import { createAppShell } from './ui/shell';
import { attachFileInput } from './ui/file-drop';
import { FileActions } from './ui/file-actions';
import { buildMenuBar } from './ui/menubar';
import { attachColourShortcuts } from './ui/colour-shortcuts';
import { ColourSwatches } from './ui/colour-swatches';
import { BusyIndicator } from './ui/busy-indicator';
import { openFillDialog } from './ui/dialogs/fill-dialog';
import { openGradientEditor } from './ui/dialogs/gradient-editor';
import { NoticeStack } from './ui/notice';
import { OptionsBar } from './ui/options-bar';
import { ToolRail } from './ui/tool-rail';
import { attachSelectionShortcuts } from './ui/selection-shortcuts';
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

  /** Grow and Similar both rescan the image against the current selection. */
  const rescanSelection = (kind: 'grow' | 'similar'): void => {
    const current = doc.selection;
    if (!current) {
      notices.show('Select something first.', 'Grow and Similar work from an existing selection.');
      return;
    }

    const source = readSourcePixels(true);
    if (!source) return;

    const scan = floodRunner.run({
      kind,
      pixels: source.data,
      width: source.width,
      height: source.height,
      tolerance: 30,
      antiAlias: true,
      seeds: current.data,
    });

    void track(kind === 'grow' ? 'Growing…' : 'Finding similar…', scan).then((data) => {
      setSelection(doc, history, new SelectionMask(doc.width, doc.height, data),
        kind === 'grow' ? 'Grow Selection' : 'Select Similar');
      documentChanged();
    });
  };



  attachFileInput(shell.stage, fileActions);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'F5' && event.shiftKey) {
      event.preventDefault();
      runFillCommand();
      return;
    }
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

  /** Document-sized pixels for the wand and the bucket to match against. */
  const readSourcePixels = (allLayers: boolean): ImageData | null => {
    if (allLayers) {
      compositor.composeIfDirty();
      return compositor.ctx.getImageData(0, 0, doc.width, doc.height);
    }

    const layer = doc.getActiveLayer();
    if (!layer) return null;

    const scratch = document.createElement('canvas');
    scratch.width = doc.width;
    scratch.height = doc.height;
    const scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
    if (!scratchCtx) return null;

    scratchCtx.drawImage(layer.canvas, layer.x, layer.y);
    return scratchCtx.getImageData(0, 0, doc.width, doc.height);
  };
  const toolManager = new ToolManager({
    surface: renderer.canvas,
    doc,
    history,
    viewport,
    colours,
    requestRender: renderer.invalidate,
    invalidateComposite: documentChanged,
    setLiveStroke: (stroke) => {
      compositor.setLiveStroke(stroke);
      renderer.invalidate();
    },
    readSourcePixels: (allLayers) => readSourcePixels(allLayers),
  });

  // Marching ants sit under the active tool's own overlay, and are drawn for
  // every tool rather than only the selection tools.
  const selectionOverlay = new SelectionOverlay(doc, viewport);
  renderer.setOverlayPainter((ctx) => {
    selectionOverlay.draw(ctx);
    toolManager.drawOverlay(ctx);
    // The ants animate, so keep asking for frames while a selection exists.
    if (selectionOverlay.isAnimating) renderer.invalidate();
  });

  toolManager.register(createMoveTool());
  toolManager.register(createMarqueeTool('rectangle'));
  toolManager.register(createMarqueeTool('ellipse'));
  toolManager.register(createLassoTool());
  toolManager.register(createPolygonLassoTool());

  const busy = new BusyIndicator(document.body);
  const floodRunner = new FloodRunner();
  const track = <T,>(label: string, work: Promise<T>): Promise<T> => busy.during(label, work);
  toolManager.register(createMagicWandTool({ runner: floodRunner, track }));

  // Patterns are the built-in tiles plus anything defined from a selection.
  const patterns: PatternDefinition[] = builtInPatterns();
  const listPatterns = (): readonly PatternDefinition[] => patterns;

  toolManager.register(
    createBucketTool({
      runner: floodRunner,
      track,
      patterns: listPatterns,
      onFilled: () => {
        thumbnails.markAllDirty();
        documentChanged();
      },
    }),
  );

  // The gradient in the options bar's preset dropdown, editable in the dialog.
  const presets = gradientPresets();
  let activeGradient: GradientDefinition = cloneGradient(presets[0]!);

  const gradientTool = createGradientTool({
    current: () => activeGradient,
    openEditor: () =>
      openGradientEditor(activeGradient, colours, (next) => {
        activeGradient = next;
      }),
    onFilled: () => {
      thumbnails.markAllDirty();
      documentChanged();
    },
  });
  toolManager.register(gradientTool);

  // Choosing a preset replaces the working gradient.
  toolManager.context.options.subscribe(() => {
    if (toolManager.activeTool?.id !== 'gradient') return;
    const wanted = toolManager.context.options.get<string>('preset');
    if (wanted !== activeGradient.id) {
      const found = presets.find((entry) => entry.id === wanted);
      if (found) activeGradient = cloneGradient(found);
    }
  });

  /** Shift+F5 and Edit > Fill. */
  const runFillCommand = (): void => {
    const layer = doc.getActiveLayer();
    if (!layer) return;

    openFillDialog(
      patterns.map((entry) => ({ id: entry.id, name: entry.name })),
      (request) => {
        const tile =
          request.source === 'pattern'
            ? patterns.find((entry) => entry.id === request.patternId) ?? patterns[0]
            : null;

        const colour =
          request.source === 'background'
            ? colours.background
            : request.source === 'custom'
              ? request.colour
              : colours.foreground;

        const paint = tile ? patternPaint(tile.canvas) : solidPaint(colour);
        fillThroughMasks(
          doc, history, layer, paint, [doc.selection],
          { opacity: request.opacity, blendMode: request.blendMode },
          'Fill',
        );
        thumbnails.markAllDirty();
        documentChanged();
      },
    );
  };

  /** Turns the current selection into a reusable pattern tile. */
  const definePattern = (): void => {
    const selection = doc.selection;
    if (!selection) {
      notices.show('Select an area first.', 'Define Pattern uses the current selection as the tile.');
      return;
    }
    compositor.composeIfDirty();
    const defined = patternFromSelection(doc, selection, compositor.canvas);
    if (!defined) return;

    // One custom pattern at a time, kept under a stable id the option refers to.
    const custom: PatternDefinition = { ...defined, id: 'custom', name: 'From selection' };
    const existing = patterns.findIndex((entry) => entry.id === 'custom');
    if (existing >= 0) patterns[existing] = custom;
    else patterns.push(custom);

    notices.show(`Pattern defined (${custom.canvas.width} × ${custom.canvas.height}).`);
  };
  toolManager.register(createBrushTool());
  toolManager.register(createEraserTool());
  toolManager.register(createHandTool());
  toolManager.register(createZoomTool());
  // Holding Space borrows the Hand tool and springs back on release. Step 15
  // registers Alt for the Eyedropper the same way, once that tool exists.
  toolManager.registerTemporaryOverride('space', 'hand');

  new ToolRail(shell.toolRail, toolManager);
  new OptionsBar(shell.optionsBar, toolManager);
  new ColourSwatches(shell.toolRail, colours);
  attachColourShortcuts(colours);
  attachSelectionShortcuts(doc, history, colours, documentChanged);

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

  buildMenuBar(shell.menuBar, [
    {
      label: 'File',
      items: [
        { label: 'New…', shortcut: 'Ctrl+N', run: () => fileActions.newDocument() },
        { label: 'Open…', shortcut: 'Ctrl+O', run: () => fileActions.chooseFiles() },
        { label: 'Export As…', shortcut: 'Ctrl+Shift+S', run: () => fileActions.exportImage() },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Fill…', shortcut: 'Shift+F5', run: runFillCommand },
        { label: 'Define Pattern', run: definePattern },
      ],
    },
    {
      label: 'Select',
      items: [
        { label: 'All', shortcut: 'Ctrl+A', run: () => { selectAll(doc, history); documentChanged(); } },
        { label: 'Deselect', shortcut: 'Ctrl+D', run: () => { deselect(doc, history); documentChanged(); } },
        { label: 'Inverse', shortcut: 'Ctrl+Shift+I', run: () => { invertSelection(doc, history); documentChanged(); } },
        { label: 'Grow', run: () => rescanSelection('grow') },
        { label: 'Similar', run: () => rescanSelection('similar') },
      ],
    },
  ]);

  renderer.start();
}

boot();
