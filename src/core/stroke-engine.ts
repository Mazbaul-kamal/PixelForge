import type { Point } from './types';

export interface BrushSettings {
  /** Diameter in document pixels. */
  size: number;
  /** 0..1. The solid core ends at radius x hardness. */
  hardness: number;
  /** 0..1, applied per dab, so overlapping dabs build up. */
  flow: number;
  /** Fraction of the dab diameter between stamps. */
  spacing: number;
  /** CSS colour of the paint. */
  colour: string;
  /** Round dabs for brushes; square dabs for the block eraser. */
  shape: 'round' | 'square';
  /** 0..1. 0 is raw input, 1 is heavily damped. */
  smoothing: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
}

export interface StrokeSample {
  readonly x: number;
  readonly y: number;
  readonly pressure: number;
}

/** Dabs smaller than this cannot be seen and are not worth stamping. */
const MIN_RADIUS = 0.35;
/** Never advance by less than this, or a stroke can stall in a loop. */
const MIN_STEP = 0.5;
/** How many catch-up steps the smoother runs when a stroke ends. */
const FLUSH_STEPS = 8;

/**
 * Stamp-based stroke rendering.
 *
 * Dabs are laid down by arc length, not per pointer event, so a fast flick and
 * a slow scribble produce the same continuous line. Everything is stamped at
 * full flow into a buffer the caller owns; stroke opacity is applied once when
 * that buffer is composited, because stamping at opacity would let overlapping
 * dabs within one stroke darken each other.
 */
export class StrokeEngine {
  private readonly ctx: CanvasRenderingContext2D;
  private settings: BrushSettings;

  /** Smoothed pen position, which lags the raw input. */
  private current: StrokeSample | null = null;
  /** Newest raw input, used to catch up when the stroke ends. */
  private target: StrokeSample | null = null;
  /** Distance still to travel before the next dab. */
  private toNextDab = 0;
  private painted = false;

  constructor(ctx: CanvasRenderingContext2D, settings: BrushSettings) {
    this.ctx = ctx;
    this.settings = settings;
  }

  update(settings: BrushSettings): void {
    this.settings = settings;
  }

  get hasPainted(): boolean {
    return this.painted;
  }

  begin(sample: StrokeSample): void {
    this.current = sample;
    this.target = sample;
    this.stamp(sample);
    this.toNextDab = this.stepFor(sample.pressure);
  }

  /** Feeds one input sample. Call it for every coalesced sample. */
  extend(sample: StrokeSample): void {
    if (!this.current) {
      this.begin(sample);
      return;
    }
    this.target = sample;

    const factor = this.smoothingFactor();
    const next: StrokeSample = {
      x: this.current.x + (sample.x - this.current.x) * factor,
      y: this.current.y + (sample.y - this.current.y) * factor,
      pressure: this.current.pressure + (sample.pressure - this.current.pressure) * factor,
    };

    this.walk(this.current, next);
    this.current = next;
  }

  /** Catches the smoothed position up to the last raw sample. */
  finish(): void {
    const target = this.target;
    if (!this.current || !target) return;

    for (let i = 0; i < FLUSH_STEPS; i++) {
      const remaining = Math.hypot(target.x - this.current.x, target.y - this.current.y);
      if (remaining < 0.01) break;

      const next: StrokeSample = {
        x: this.current.x + (target.x - this.current.x) * 0.5,
        y: this.current.y + (target.y - this.current.y) * 0.5,
        pressure: target.pressure,
      };
      this.walk(this.current, next);
      this.current = next;
    }

    this.walk(this.current, target);
    this.current = null;
    this.target = null;
  }

  /** Lays dabs along a segment at even arc-length spacing. */
  private walk(from: StrokeSample, to: StrokeSample): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance === 0) return;

    let travelled = 0;
    while (travelled + this.toNextDab <= distance) {
      travelled += this.toNextDab;

      const t = travelled / distance;
      const pressure = from.pressure + (to.pressure - from.pressure) * t;
      this.stamp({ x: from.x + dx * t, y: from.y + dy * t, pressure });
      this.toNextDab = this.stepFor(pressure);
    }

    this.toNextDab -= distance - travelled;
  }

  /** Spacing follows the dab's actual size, so low pressure cannot leave gaps. */
  private stepFor(pressure: number): number {
    return Math.max(MIN_STEP, this.radiusFor(pressure) * 2 * this.settings.spacing);
  }

  private radiusFor(pressure: number): number {
    const scale = this.settings.pressureSize ? pressure : 1;
    return Math.max(MIN_RADIUS, (this.settings.size / 2) * scale);
  }

  private smoothingFactor(): number {
    // 0 smoothing follows the pointer exactly; 1 damps hard but still moves.
    const amount = Math.min(Math.max(this.settings.smoothing, 0), 1);
    return 1 - amount * 0.88;
  }

  private stamp(sample: StrokeSample): void {
    const radius = this.radiusFor(sample.pressure);
    const alpha =
      this.settings.flow * (this.settings.pressureOpacity ? sample.pressure : 1);
    if (alpha <= 0) return;

    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = Math.min(alpha, 1);

    if (this.settings.shape === 'square') {
      // Snapped to whole pixels, which is the point of a block eraser.
      const side = Math.max(1, Math.round(radius * 2));
      ctx.fillStyle = this.settings.colour;
      ctx.fillRect(Math.round(sample.x - side / 2), Math.round(sample.y - side / 2), side, side);
    } else {
      ctx.fillStyle = this.dabGradient(sample, radius);
      ctx.beginPath();
      ctx.arc(sample.x, sample.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
    this.painted = true;
  }

  private dabGradient(at: Point, radius: number): CanvasGradient | string {
    const hardness = Math.min(Math.max(this.settings.hardness, 0), 1);
    // A fully hard dab is a flat fill; the arc path supplies the smooth edge.
    if (hardness >= 1) return this.settings.colour;

    const gradient = this.ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, radius);
    gradient.addColorStop(0, this.settings.colour);
    gradient.addColorStop(hardness, this.settings.colour);
    gradient.addColorStop(1, transparentOf(this.settings.colour));
    return gradient;
  }
}

/**
 * The same colour at zero alpha. Going through a canvas keeps this working for
 * every CSS colour form rather than only hex.
 */
const probe = document.createElement('canvas').getContext('2d');

export function transparentOf(colour: string): string {
  if (!probe) return 'rgba(0, 0, 0, 0)';
  probe.fillStyle = '#000000';
  probe.fillStyle = colour;

  const resolved = probe.fillStyle;
  if (typeof resolved === 'string' && resolved.startsWith('#') && resolved.length === 7) {
    const r = parseInt(resolved.slice(1, 3), 16);
    const g = parseInt(resolved.slice(3, 5), 16);
    const b = parseInt(resolved.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, 0)`;
  }
  return 'rgba(0, 0, 0, 0)';
}
