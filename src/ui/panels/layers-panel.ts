import type { PixelDocument } from '../../core/document';
import type { History, Transaction } from '../../core/history';
import {
  addEmptyLayer,
  deleteLayers,
  duplicateLayers,
  flattenImage,
  mergeDown,
  moveLayersBy,
  renameLayer,
  reorderLayers,
  setLayerLocked,
  setLayerVisibility,
} from '../../core/layer-ops';
import { setClipped, setMaskEnabled, setMaskLinked } from '../../core/mask-ops';
import { selectLayerAlpha } from '../../core/selection-ops';
import { BLEND_MODES } from '../../core/types';
import type { BlendMode, Layer } from '../../core/types';
import { attachDragReorder } from '../drag-reorder';
import { createPanel } from '../panel';
import type { ThumbnailCache } from '../thumbnails';
import { LayerRow } from './layer-row';

function formatBlendMode(mode: BlendMode): string {
  return mode
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function button(label: string, title: string, glyph: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'pf-layer-action';
  element.textContent = glyph;
  element.title = title;
  element.setAttribute('aria-label', label);
  return element;
}

/**
 * The layers panel. Rows are listed top-first, which is the reverse of the
 * document's bottom-first array, so every index crossing that boundary is
 * converted through displayToArrayIndex().
 */
export class LayersPanel {
  readonly root: HTMLElement;

  private readonly doc: PixelDocument;
  private readonly history: History;
  private readonly thumbs: ThumbnailCache;
  private readonly onChanged: () => void;

  private readonly blendSelect: HTMLSelectElement;
  private readonly opacityRange: HTMLInputElement;
  private readonly opacityValue: HTMLElement;
  private readonly list: HTMLElement;
  private readonly indicator: HTMLElement;
  private readonly actions: Record<string, HTMLButtonElement>;

  private readonly rows = new Map<string, LayerRow>();
  private readonly selected = new Set<string>();
  private anchorId: string | null = null;
  /** Whether painting lands on the active layer's pixels or on its mask. */
  private paintTarget: 'layer' | 'mask' = 'layer';
  /** Set while Alt+clicking a mask thumbnail shows it on its own. */
  private maskViewId: string | null = null;
  onMaskViewChanged: ((layerId: string | null) => void) | null = null;
  private renderedOrder = '';
  /** Set by the app: opens the effects editor for a layer. */
  onEditStyles: (id: string) => void = () => {};
  private rowDepths = new Map<string, number>();
  private opacityTx: Transaction | null = null;
  private readonly detachers: Array<() => void> = [];

  constructor(
    doc: PixelDocument,
    history: History,
    thumbs: ThumbnailCache,
    onChanged: () => void,
  ) {
    this.doc = doc;
    this.history = history;
    this.thumbs = thumbs;
    this.onChanged = onChanged;

    const panel = createPanel('Layers', 'layers');
    this.root = panel.root;

    // ---- blend mode and opacity, above the list ----
    const controls = document.createElement('div');
    controls.className = 'pf-layer-controls';

    this.blendSelect = document.createElement('select');
    this.blendSelect.className = 'pf-select';
    this.blendSelect.setAttribute('aria-label', 'Blend mode');
    for (const mode of BLEND_MODES) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = formatBlendMode(mode);
      this.blendSelect.appendChild(option);
    }

    this.opacityRange = document.createElement('input');
    this.opacityRange.type = 'range';
    this.opacityRange.min = '0';
    this.opacityRange.max = '100';
    this.opacityRange.step = '1';
    this.opacityRange.className = 'pf-range';
    this.opacityRange.setAttribute('aria-label', 'Layer opacity');

    this.opacityValue = document.createElement('span');
    this.opacityValue.className = 'pf-field-value';

    const opacityRow = document.createElement('div');
    opacityRow.className = 'pf-field';
    const opacityLabel = document.createElement('span');
    opacityLabel.className = 'pf-field-label';
    opacityLabel.textContent = 'Opacity';
    opacityRow.append(opacityLabel, this.opacityRange, this.opacityValue);

    const blendRow = document.createElement('div');
    blendRow.className = 'pf-field';
    const blendLabel = document.createElement('span');
    blendLabel.className = 'pf-field-label';
    blendLabel.textContent = 'Blend';
    blendRow.append(blendLabel, this.blendSelect);

    controls.append(blendRow, opacityRow);

    // ---- the list ----
    this.list = document.createElement('div');
    this.list.className = 'pf-layer-list';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Layers');
    this.list.setAttribute('aria-multiselectable', 'true');
    this.list.tabIndex = 0;

    this.indicator = document.createElement('div');
    this.indicator.className = 'pf-drop-indicator';
    this.indicator.hidden = true;
    this.list.appendChild(this.indicator);

    // ---- action buttons ----
    const bar = document.createElement('div');
    bar.className = 'pf-layer-actions';
    this.actions = {
      add: button('New layer', 'New layer  (Ctrl+Shift+N)', '+'),
      duplicate: button('Duplicate layer', 'Duplicate layer  (Ctrl+J)', '⧉'),
      up: button('Move layer up', 'Move layer up  (Ctrl+])', '↑'),
      down: button('Move layer down', 'Move layer down  (Ctrl+[)', '↓'),
      merge: button('Merge down', 'Merge down  (Ctrl+E)', '⌄'),
      flatten: button('Flatten image', 'Flatten image  (Ctrl+Shift+E)', '≡'),
      remove: button('Delete layer', 'Delete layer  (Del)', '🗑'),
    };
    bar.append(...Object.values(this.actions));

    panel.body.append(controls, this.list, bar);

    this.wireControls();
    this.wireActions();
    this.wireKeyboard();
    this.wireDragReorder();

    this.detachers.push(history.subscribe(() => this.onHistoryChanged()));
    this.syncSelectionToDocument();
    this.render();
  }

  /** Redraws the list, for changes the panel did not make itself. */
  refresh(): void {
    this.render();
  }

  destroy(): void {
    for (const detach of this.detachers) detach();
    this.root.remove();
  }

  // ---- public actions, also reachable from the keyboard ----

  createLayer(): void {
    const id = addEmptyLayer(this.doc, this.history);
    if (id) this.setSelection([id], id);
  }

  duplicateSelection(): void {
    const copies = duplicateLayers(this.doc, this.history, this.selectionOrActive());
    if (copies.length > 0) this.setSelection(copies, copies[copies.length - 1] ?? null);
  }

  deleteSelection(): void {
    const ids = this.selectionOrActive();
    if (ids.length === 0) return;
    deleteLayers(this.doc, this.history, ids);
    this.syncSelectionToDocument();
    this.render();
  }

  moveSelection(delta: 1 | -1): void {
    moveLayersBy(this.doc, this.history, this.selectionOrActive(), delta);
  }

  mergeActiveDown(): void {
    const active = this.doc.activeLayerId;
    if (active) mergeDown(this.doc, this.history, active);
  }

  flatten(): void {
    flattenImage(this.doc, this.history);
  }

  renameActive(): void {
    const active = this.doc.activeLayerId;
    if (active) this.rows.get(active)?.beginRename();
  }

  /** Walks the active layer through the displayed order. */
  stepActive(delta: 1 | -1): void {
    const display = this.displayLayers();
    if (display.length === 0) return;

    const current = display.findIndex((layer) => layer.id === this.doc.activeLayerId);
    const next = Math.min(Math.max((current < 0 ? 0 : current) + delta, 0), display.length - 1);
    const layer = display[next];
    if (layer) this.setSelection([layer.id], layer.id);
  }

  get listElement(): HTMLElement {
    return this.list;
  }

  /** Read by the tool manager: what painting currently targets. */
  get drawingTarget(): 'layer' | 'mask' {
    const layer = this.doc.getActiveLayer();
    if (!layer || !layer.mask) return 'layer';
    return this.paintTarget;
  }

  setDrawingTarget(target: 'layer' | 'mask'): void {
    this.paintTarget = target;
    this.render();
  }

  // ---- internals ----

  /**
   * The visible rows, top first, walking the group tree. Children of a
   * collapsed group are left out of the list but stay in the document.
   */
  private displayLayers(): Layer[] {
    const rows: Layer[] = [];
    const depths = new Map<string, number>();

    const walk = (parentId: string | undefined, depth: number): void => {
      const siblings = this.doc.layers.filter((l) => (l.parentId ?? undefined) === parentId);
      // Top first, which is the reverse of the document's bottom-first order.
      for (let i = siblings.length - 1; i >= 0; i--) {
        const layer = siblings[i]!;
        rows.push(layer);
        depths.set(layer.id, depth);
        if (layer.type === 'group' && layer.collapsed !== true) walk(layer.id, depth + 1);
      }
    };

    walk(undefined, 0);
    this.rowDepths = depths;
    return rows;
  }

  /**
   * Converts a drop gap (counted top-first among the rows still on screen)
   * into a bottom-first insertion index among the layers that are not moving.
   */
  private displayGapToInsertIndex(gap: number, movingCount: number): number {
    return this.doc.layers.length - movingCount - gap;
  }

  private selectionOrActive(): string[] {
    if (this.selected.size > 0) {
      return this.doc.layers.filter((layer) => this.selected.has(layer.id)).map((l) => l.id);
    }
    return this.doc.activeLayerId ? [this.doc.activeLayerId] : [];
  }

  private setSelection(ids: readonly string[], active: string | null): void {
    this.selected.clear();
    for (const id of ids) this.selected.add(id);
    if (active) this.doc.setActiveLayer(active);
    this.anchorId = active;
    this.render();
  }

  /** Drops ids for layers that no longer exist, e.g. after an undo. */
  private syncSelectionToDocument(): void {
    for (const id of [...this.selected]) {
      if (this.doc.indexOfLayer(id) < 0) this.selected.delete(id);
    }
    if (this.selected.size === 0 && this.doc.activeLayerId) {
      this.selected.add(this.doc.activeLayerId);
    }
  }

  private onHistoryChanged(): void {
    // Undo may have restored different pixels, so every thumbnail is suspect.
    this.thumbs.markAllDirty();
    this.thumbs.prune();
    this.syncSelectionToDocument();
    this.render();
  }

  private wireControls(): void {
    this.blendSelect.addEventListener('change', () => {
      const layer = this.doc.getActiveLayer();
      const mode = this.blendSelect.value as BlendMode;
      if (!layer || layer.blendMode === mode) return;

      this.history.transaction('Blend Mode', () => {
        layer.blendMode = mode;
      });
      this.onChanged();
    });

    this.opacityRange.addEventListener('input', () => {
      const layer = this.doc.getActiveLayer();
      if (!layer) return;

      // One transaction for the whole drag, opened on the first input event.
      this.opacityTx ??= this.history.beginStructural('Layer Opacity');

      const percent = Number(this.opacityRange.value);
      layer.opacity = Math.min(Math.max(percent, 0), 100) / 100;
      this.opacityValue.textContent = `${percent}%`;
      this.thumbs.markDirty(layer.id);
      this.onChanged();
    });

    const endDrag = (): void => {
      if (!this.opacityTx) return;
      const transaction = this.opacityTx;
      this.opacityTx = null;
      transaction.commit();
    };
    this.opacityRange.addEventListener('change', endDrag);
    this.opacityRange.addEventListener('pointerup', endDrag);
    this.opacityRange.addEventListener('blur', endDrag);
  }

  private wireActions(): void {
    this.actions['add']?.addEventListener('click', () => this.createLayer());
    this.actions['duplicate']?.addEventListener('click', () => this.duplicateSelection());
    this.actions['up']?.addEventListener('click', () => this.moveSelection(1));
    this.actions['down']?.addEventListener('click', () => this.moveSelection(-1));
    this.actions['merge']?.addEventListener('click', () => this.mergeActiveDown());
    this.actions['flatten']?.addEventListener('click', () => this.flatten());
    this.actions['remove']?.addEventListener('click', () => this.deleteSelection());
  }

  private wireKeyboard(): void {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!this.list.contains(document.activeElement)) return;
      if (document.activeElement instanceof HTMLInputElement) return;

      switch (event.key) {
        case 'ArrowUp':
          this.stepActive(-1);
          break;
        case 'ArrowDown':
          this.stepActive(1);
          break;
        case 'Delete':
        case 'Backspace':
          this.deleteSelection();
          break;
        case 'F2':
          this.renameActive();
          break;
        default:
          return;
      }
      event.preventDefault();
    };

    this.list.addEventListener('keydown', onKeyDown);
    this.detachers.push(() => this.list.removeEventListener('keydown', onKeyDown));
  }

  private wireDragReorder(): void {
    this.detachers.push(
      attachDragReorder({
        list: this.list,
        indicator: this.indicator,
        rowFromTarget: (target) =>
          target instanceof Element ? target.closest<HTMLElement>('[data-layer-id]') : null,
        isInteractive: (target) =>
          target instanceof Element ? target.closest('button, input, select') !== null : false,
        onDragStart: (rowId) => {
          // Dragging an unselected row drags just that row.
          if (!this.selected.has(rowId)) this.setSelection([rowId], rowId);
          return this.displayLayers()
            .filter((layer) => this.selected.has(layer.id))
            .map((layer) => layer.id);
        },
        onDrop: (ids, gap) => {
          reorderLayers(this.doc, this.history, ids, this.displayGapToInsertIndex(gap, ids.length));
        },
      }),
    );
  }

  private pick(id: string, event: MouseEvent): void {
    const display = this.displayLayers();

    if (event.shiftKey && this.anchorId) {
      const from = display.findIndex((layer) => layer.id === this.anchorId);
      const to = display.findIndex((layer) => layer.id === id);
      if (from >= 0 && to >= 0) {
        const [start, end] = from <= to ? [from, to] : [to, from];
        this.selected.clear();
        for (let i = start; i <= end; i++) this.selected.add(display[i]!.id);
        this.doc.setActiveLayer(id);
        this.render();
        return;
      }
    }

    if (event.altKey) {
      // Alt+click a row clips it to the layer beneath, or releases it.
      const layer = this.doc.getLayer(id);
      if (layer) {
        setClipped(this.doc, this.history, id, layer.clipped !== true);
        this.onChanged();
      }
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      if (this.selected.has(id) && this.selected.size > 1) this.selected.delete(id);
      else this.selected.add(id);
      this.doc.setActiveLayer(id);
      this.anchorId = id;
      this.render();
      return;
    }

    this.setSelection([id], id);
  }

  private render(): void {
    const display = this.displayLayers();
    const order = display.map((layer) => layer.id).join(',');

    if (order !== this.renderedOrder) {
      for (const [id, row] of this.rows) {
        if (this.doc.indexOfLayer(id) < 0) {
          row.root.remove();
          this.rows.delete(id);
        }
      }

      for (const layer of display) {
        if (!this.rows.has(layer.id)) {
          this.rows.set(
            layer.id,
            new LayerRow(layer, this.thumbs, {
              onToggleVisible: (id) => {
                const target = this.doc.getLayer(id);
                if (target) setLayerVisibility(this.doc, this.history, id, !target.visible);
              },
              onToggleLock: (id) => {
                const target = this.doc.getLayer(id);
                if (target) setLayerLocked(this.doc, this.history, id, !target.locked);
              },
              onPick: (id, event) => this.pick(id, event),
              onRename: (id, name) => renameLayer(this.doc, this.history, id, name),
              onEditStyles: (id) => {
                this.pick(id, new MouseEvent('click'));
                this.onEditStyles(id);
              },
              onLoadSelection: (id) => {
                selectLayerAlpha(this.doc, this.history, id);
                this.onChanged();
              },
              onPickSurface: (id, surface) => {
                this.doc.setActiveLayer(id);
                this.paintTarget = surface;
                // Choosing a surface leaves the mask-alone view.
                if (this.maskViewId) {
                  this.maskViewId = null;
                  this.onMaskViewChanged?.(null);
                }
                this.render();
                this.onChanged();
              },
              onMaskModifier: (id, modifier) => {
                const layer = this.doc.getLayer(id);
                if (!layer || !layer.mask) return;

                if (modifier === 'toggle') {
                  setMaskEnabled(this.doc, this.history, id, layer.maskEnabled === false);
                } else {
                  this.maskViewId = this.maskViewId === id ? null : id;
                  this.onMaskViewChanged?.(this.maskViewId);
                }
                this.onChanged();
              },
              onToggleGroup: (id) => {
                const layer = this.doc.getLayer(id);
                if (!layer || layer.type !== 'group') return;
                layer.collapsed = layer.collapsed !== true;
                this.renderedOrder = '';
                this.render();
              },
              onToggleMaskLink: (id) => {
                const layer = this.doc.getLayer(id);
                if (!layer) return;
                setMaskLinked(this.doc, this.history, id, layer.maskLinked === false);
                this.onChanged();
              },
            }),
          );
        }
      }

      // Keep the drop indicator first so it stays positioned against the list.
      this.list.replaceChildren(this.indicator, ...display.map((l) => this.rows.get(l.id)!.root));
      this.renderedOrder = order;
    }

    for (const layer of display) {
      this.rows.get(layer.id)?.update(layer, {
        active: layer.id === this.doc.activeLayerId,
        selected: this.selected.has(layer.id),
        target: this.paintTarget,
        depth: this.rowDepths.get(layer.id) ?? 0,
      });
    }

    this.updateControls();
  }

  private updateControls(): void {
    const layer = this.doc.getActiveLayer();
    const activeIndex = this.doc.activeLayerId
      ? this.doc.indexOfLayer(this.doc.activeLayerId)
      : -1;

    this.blendSelect.disabled = layer === null;
    this.opacityRange.disabled = layer === null;

    if (layer) {
      this.blendSelect.value = layer.blendMode;
      const percent = Math.round(layer.opacity * 100);
      if (!this.opacityTx) this.opacityRange.value = String(percent);
      this.opacityValue.textContent = `${percent}%`;
    } else {
      this.opacityValue.textContent = '—';
    }

    const hasSelection = this.selectionOrActive().length > 0;
    const setEnabled = (key: string, enabled: boolean): void => {
      const target = this.actions[key];
      if (target) target.disabled = !enabled;
    };

    setEnabled('duplicate', hasSelection);
    setEnabled('remove', hasSelection);
    setEnabled('up', hasSelection);
    setEnabled('down', hasSelection);
    setEnabled('merge', activeIndex >= 1);
    setEnabled('flatten', this.doc.layers.length > 1);
  }
}
