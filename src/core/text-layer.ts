import type { Layer } from './types';

export type TextAlign = 'left' | 'centre' | 'right';

export interface TextStyle {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly italic: boolean;
  /** Extra space between characters, in pixels. */
  readonly letterSpacing: number;
  /** Multiple of the font size. */
  readonly lineHeight: number;
  readonly align: TextAlign;
  readonly colour: string;
  readonly strokeWidth: number;
  readonly strokeColour: string;
}

/**
 * What a text layer actually is. The bitmap is only ever a render of this, so
 * the string and the style survive every edit and can be changed forever.
 *
 * Treated as immutable: an edit produces a new object, which keeps history
 * snapshots that hold it by reference correct.
 */
export interface TextLayerData {
  readonly text: string;
  readonly style: TextStyle;
  /** Fixed width for paragraph text. Null means point text, which grows. */
  readonly boxWidth: number | null;
  readonly boxHeight: number | null;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: 'system-ui, sans-serif',
  fontSize: 48,
  fontWeight: 400,
  italic: false,
  letterSpacing: 0,
  lineHeight: 1.25,
  align: 'left',
  colour: '#000000',
  strokeWidth: 0,
  strokeColour: '#ffffff',
};

export const WEB_SAFE_FONTS: readonly string[] = [
  'system-ui, sans-serif',
  'Arial, Helvetica, sans-serif',
  'Georgia, serif',
  '"Times New Roman", Times, serif',
  '"Courier New", monospace',
  'Verdana, Geneva, sans-serif',
  '"Trebuchet MS", sans-serif',
  'Impact, fantasy',
];

export function cssFont(style: TextStyle): string {
  return `${style.italic ? 'italic ' : ''}${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
}

/**
 * Text measurement, cached by font and string.
 *
 * Without the cache, wrapping a long paragraph re-measures every candidate
 * line on every keystroke and typing visibly lags.
 */
export class TextMeasurer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cache = new Map<string, number>();

  constructor() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not acquire a 2D context for text measurement.');
    this.ctx = ctx;
  }

  width(text: string, style: TextStyle): number {
    if (text.length === 0) return 0;

    const font = cssFont(style);
    const key = `${font}|${style.letterSpacing}|${text}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    this.ctx.font = font;
    this.applyLetterSpacing(this.ctx, style);
    const measured = this.ctx.measureText(text).width;

    // Keep the cache from growing without bound during long typing sessions.
    if (this.cache.size > 4000) this.cache.clear();
    this.cache.set(key, measured);
    return measured;
  }

  applyLetterSpacing(ctx: CanvasRenderingContext2D, style: TextStyle): void {
    const target = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
    if ('letterSpacing' in target) target.letterSpacing = `${style.letterSpacing}px`;
  }
}

export interface TextLine {
  readonly text: string;
  readonly width: number;
}

export interface TextLayout {
  readonly lines: readonly TextLine[];
  readonly width: number;
  readonly height: number;
  /** True when paragraph text does not fit its fixed box. */
  readonly overflow: boolean;
}

const segmenters = new Map<string, Intl.Segmenter>();

function segmenter(granularity: 'word' | 'grapheme'): Intl.Segmenter {
  let found = segmenters.get(granularity);
  if (!found) {
    found = new Intl.Segmenter(undefined, { granularity });
    segmenters.set(granularity, found);
  }
  return found;
}

/** Splits a run into grapheme clusters, never into code units. */
export function graphemes(text: string): string[] {
  return [...segmenter('grapheme').segment(text)].map((entry) => entry.segment);
}

/**
 * Breaks one paragraph to fit `maxWidth`.
 *
 * Words come from Intl.Segmenter rather than a space split, and a word too
 * long for the line is broken at grapheme boundaries. Splitting by character
 * would tear Bengali conjuncts and any combining mark off its base.
 */
function wrapParagraph(
  paragraph: string,
  style: TextStyle,
  maxWidth: number,
  measurer: TextMeasurer,
): string[] {
  if (paragraph.length === 0) return [''];

  const pieces = [...segmenter('word').segment(paragraph)].map((entry) => entry.segment);
  const lines: string[] = [];
  let line = '';

  const pushLine = (): void => {
    lines.push(line);
    line = '';
  };

  for (const piece of pieces) {
    const candidate = line + piece;
    if (measurer.width(candidate, style) <= maxWidth || line.length === 0) {
      // A single piece wider than the whole line has to be broken up.
      if (line.length === 0 && measurer.width(piece, style) > maxWidth) {
        let run = '';
        for (const cluster of graphemes(piece)) {
          if (run.length > 0 && measurer.width(run + cluster, style) > maxWidth) {
            lines.push(run);
            run = '';
          }
          run += cluster;
        }
        line = run;
        continue;
      }
      line = candidate;
      continue;
    }

    pushLine();
    // Leading spaces at the start of a wrapped line look wrong.
    line = piece.trimStart();
  }

  lines.push(line);
  return lines;
}

export function layoutText(data: TextLayerData, measurer: TextMeasurer): TextLayout {
  const { style } = data;
  const paragraphs = data.text.split('\n');
  const lines: TextLine[] = [];

  for (const paragraph of paragraphs) {
    const wrapped =
      data.boxWidth === null
        ? [paragraph]
        : wrapParagraph(paragraph, style, Math.max(1, data.boxWidth), measurer);
    for (const text of wrapped) lines.push({ text, width: measurer.width(text, style) });
  }

  const lineHeight = style.fontSize * style.lineHeight;
  const height = Math.max(lineHeight, lines.length * lineHeight);
  const width = data.boxWidth ?? Math.max(1, ...lines.map((line) => line.width));

  return {
    lines,
    width,
    height,
    overflow: data.boxHeight !== null && height > data.boxHeight,
  };
}

/** Space needed around the glyphs so a stroke is not clipped. */
function padding(style: TextStyle): number {
  return Math.ceil(style.strokeWidth + style.fontSize * 0.35);
}

export interface RenderedText {
  readonly canvas: HTMLCanvasElement;
  readonly layout: TextLayout;
  /** Where the text origin sits inside the bitmap. */
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Draws a text layer's bitmap from its data. */
export function renderText(data: TextLayerData, measurer: TextMeasurer): RenderedText {
  const layout = layoutText(data, measurer);
  const { style } = data;
  const pad = padding(style);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(layout.width) + pad * 2);
  canvas.height = Math.max(1, Math.ceil(layout.height) + pad * 2);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not acquire a 2D context to render text.');

  ctx.font = cssFont(style);
  measurer.applyLetterSpacing(ctx, style);
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';

  const lineHeight = style.fontSize * style.lineHeight;
  const boxWidth = layout.width;

  layout.lines.forEach((line, index) => {
    const y = pad + lineHeight * index + style.fontSize;
    let x = pad;
    if (style.align === 'centre') x = pad + (boxWidth - line.width) / 2;
    else if (style.align === 'right') x = pad + (boxWidth - line.width);

    if (style.strokeWidth > 0) {
      ctx.strokeStyle = style.strokeColour;
      ctx.lineWidth = style.strokeWidth * 2;
      ctx.strokeText(line.text, x, y);
    }
    ctx.fillStyle = style.colour;
    ctx.fillText(line.text, x, y);
  });

  return { canvas, layout, offsetX: pad, offsetY: pad };
}

/**
 * Re-renders a text layer in place, keeping its anchor so the text does not
 * appear to jump when the size or the wrapping changes.
 */
export function applyTextToLayer(layer: Layer, data: TextLayerData, measurer: TextMeasurer): void {
  const anchorX = layer.x + (layer.text ? textPadding(layer.text) : 0);
  const anchorY = layer.y + (layer.text ? textPadding(layer.text) : 0);

  const rendered = renderText(data, measurer);
  layer.canvas = rendered.canvas;
  const ctx = rendered.canvas.getContext('2d');
  if (ctx) layer.ctx = ctx;

  layer.text = data;
  layer.type = 'text';
  layer.x = Math.round(anchorX - rendered.offsetX);
  layer.y = Math.round(anchorY - rendered.offsetY);
}

function textPadding(data: TextLayerData): number {
  return padding(data.style);
}
