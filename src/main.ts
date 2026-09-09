import './styles/tokens.css';
import './styles/shell.css';
import './styles/panels.css';

import { Compositor } from './core/compositor';
import { PixelDocument } from './core/document';
import { History } from './core/history';
import { createLayer } from './core/layer';
import { Viewport } from './core/viewport';
import { attachViewportNavigation } from './view/navigation';
import { ViewRenderer } from './view/renderer';
import { createAppShell } from './ui/shell';
import { HistoryPanel } from './ui/panels/history-panel';
import { LayerProperties } from './ui/panels/layer-properties';
import { attachHistoryShortcuts } from './ui/shortcuts';
import { StatusBar } from './ui/statusbar';

const BOOT_WIDTH = 1200;
const BOOT_HEIGHT = 800;

function boot(): void {
  const mount = document.querySelector<HTMLElement>('#app');
  if (!mount) throw new Error('Missing #app mount point.');

  const shell = createAppShell(mount);
  const statusBar = new StatusBar(shell.statusBar);

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
    statusBar.setDocumentSize(doc.width, doc.height);
    renderer.invalidate();
  };
  history.subscribe(documentChanged);

  const layerProperties = new LayerProperties(doc, history, documentChanged);
  const historyPanel = new HistoryPanel(history);
  shell.panels.append(layerProperties.root, historyPanel.root);

  attachHistoryShortcuts(history);

  attachViewportNavigation(renderer.canvas, viewport, doc, {
    onPointerPosition: (point) => statusBar.setPointer(point),
  });

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
