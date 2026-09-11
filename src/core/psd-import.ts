import type { PixelDocument } from './document';
import type { History } from './history';
import { createLayer } from './layer';
import { blendModeFromPsd } from './psd-blend-modes';
import type { PsdLayerData, PsdParseResult } from './psd-worker';
import { DEFAULT_TEXT_STYLE } from './text-layer';
import type { Layer } from './types';
import { psdEffectsToStyles } from './psd-effects';
import type { PsdEffects } from './psd-effects';
import { decodeSidecar } from './psd-metadata';

/** Colour modes ag-psd reports, by their PSD numbers. */
const COLOUR_MODE_NAMES: Record<number, string> = {
  0: 'Bitmap', 1: 'Greyscale', 2: 'Indexed', 3: 'RGB',
  4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab',
};

export interface ImportReport {
  readonly warnings: string[];
  readonly layerCount: number;
}

function toCanvas(image: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')?.putImageData(image, 0, 0);
  return canvas;
}

/** A mask arrives as greyscale coverage; ours is a greyscale bitmap. */
function maskCanvas(layer: PsdLayerData, target: Layer): HTMLCanvasElement | null {
  if (!layer.maskData) return null;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, target.canvas.width);
  canvas.height = Math.max(1, target.canvas.height);

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Outside the stored mask rectangle a PSD mask reveals.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(toCanvas(layer.maskData), layer.maskLeft - target.x, layer.maskTop - target.y);
  return canvas;
}

/**
 * Turns a parsed PSD into layers.
 *
 * The PSD tree is flattened into our list with parentId links, bottom first,
 * which is the order both formats composite in.
 */
export function importPsd(
  doc: PixelDocument,
  history: History,
  parsed: PsdParseResult,
  name: string,
): ImportReport {
  const warnings: string[] = [];
  const unsupportedModes = new Set<string>();
  let layerCount = 0;

  const colourMode = COLOUR_MODE_NAMES[parsed.colourMode] ?? `mode ${parsed.colourMode}`;
  if (parsed.colourMode !== 3) {
    warnings.push(
      `This file is ${colourMode}. It has been converted to RGB, so colours may shift slightly.`,
    );
  }
  if (parsed.bitsPerChannel > 8) {
    warnings.push(
      `This file is ${parsed.bitsPerChannel} bits per channel and has been reduced to 8, ` +
        'so very gradual gradients may band.',
    );
  }

  const built: Layer[] = [];
  // PixelForge's own state, when this file was written here. It wins over the
  // PSD effects below, because our model has settings PSD cannot express.
  const sidecar = decodeSidecar(parsed.xmp);
  let written = 0;

  const walk = (entries: readonly PsdLayerData[], parentId: string | undefined): void => {
    for (const entry of entries) {
      const blend = blendModeFromPsd(entry.blendMode);
      if (blend.unsupported) unsupportedModes.add(blend.unsupported);

      const isGroup = entry.isGroup && entry.children.length > 0;
      const image = entry.imageData;

      const layer = createLayer({
        name: entry.name,
        width: isGroup || !image ? 1 : Math.max(1, image.width),
        height: isGroup || !image ? 1 : Math.max(1, image.height),
        x: entry.left,
        y: entry.top,
        opacity: Math.min(1, Math.max(0, entry.opacity)),
        blendMode: blend.mode,
        visible: !entry.hidden,
        type: isGroup ? 'group' : entry.text !== undefined ? 'text' : 'raster',
      });

      if (!isGroup && image) layer.ctx.drawImage(toCanvas(image), 0, 0);
      if (parentId) layer.parentId = parentId;
      if (entry.clipping) layer.clipped = true;
      if (isGroup) layer.collapsed = !entry.opened;

      if (entry.text !== undefined) {
        // The string is preserved even where the original styling is not.
        layer.text = {
          text: entry.text,
          style: DEFAULT_TEXT_STYLE,
          boxWidth: null,
          boxHeight: null,
        };
      }

      const mask = maskCanvas(entry, layer);
      if (mask) {
        layer.mask = mask;
        layer.maskEnabled = true;
        layer.maskLinked = true;
      }

      const exact = sidecar?.styles[String(written)];
      written += 1;
      if (exact) {
        layer.styles = exact;
        layer.stylesEnabled = true;
      } else if (entry.effects) {
        const effects = entry.effects as PsdEffects;
        const mapped = psdEffectsToStyles(effects);
        if (mapped) {
          layer.styles = mapped;
          layer.stylesEnabled = effects.disabled !== true;
        }
      }

      built.push(layer);
      layerCount++;

      if (isGroup) walk(entry.children, layer.id);
    }
  };

  walk(parsed.layers, undefined);

  if (unsupportedModes.size > 0) {
    warnings.push(
      `These blend modes have no equivalent here and were read as Normal: ` +
        `${[...unsupportedModes].join(', ')}.`,
    );
  }

  if (built.length === 0) {
    if (!parsed.composite) {
      warnings.push('The file has no layers and no composite, so there was nothing to open.');
      return { warnings, layerCount: 0 };
    }
    // No layer data: fall back to the flattened composite.
    const flat = createLayer({ name, width: parsed.width, height: parsed.height });
    flat.ctx.drawImage(toCanvas(parsed.composite), 0, 0);
    built.push(flat);
    layerCount = 1;
    warnings.push('This file had no editable layers, so its flattened image was opened instead.');
  }

  history.transaction(`Open ${name}`, () => {
    doc.width = parsed.width;
    doc.height = parsed.height;
    doc.layers.length = 0;
    doc.activeLayerId = null;
    doc.selection = null;
    doc.name = name;

    // Paths come only from the sidecar: ag-psd does not implement the image
    // resource that holds a PSD's named paths.
    doc.paths = (sidecar?.paths ?? []).map((path) => ({
      ...path,
      subpaths: path.subpaths.map((sub) => ({
        closed: sub.closed,
        anchors: sub.anchors.map((anchor) => ({ ...anchor })),
      })),
    }));
    doc.activePathId = sidecar?.activePathId ?? null;
    doc.workPathId = null;

    // Guides have a real PSD home, so a file from anywhere brings them.
    doc.guides = sidecar
      ? sidecar.guides.map((guide) => ({ ...guide }))
      : parsed.guides
        .map((guide) => ({
          axis: guide.direction === 'vertical' ? ('x' as const) : ('y' as const),
          position: Math.round(guide.location),
        }))
        .filter((guide) => guide.position >= 0
          && guide.position <= (guide.axis === 'x' ? parsed.width : parsed.height));

    doc.channels = [];

    for (const layer of built) doc.addLayer(layer);
    const top = built[built.length - 1];
    if (top) doc.setActiveLayer(top.id);
  });
  history.clear(`Open ${name}`);
  doc.pristine = false;

  return { warnings, layerCount };
}
