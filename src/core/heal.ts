/** Beyond this many pixels the relaxation gets slow enough to be worth a warning. */
export const MAX_HEAL_PIXELS = 300_000;

export interface HealRequest {
  /** RGBA of the surface being healed. */
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** Coverage of the region to replace, same dimensions. */
  readonly mask: Uint8ClampedArray;
  readonly iterations?: number;
}

export interface HealResult {
  readonly pixels: Uint8ClampedArray;
  readonly area: number;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function maskBounds(mask: Uint8ClampedArray, width: number, height: number): Box | null {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]! < 128) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : { left, top, right, bottom };
}

/**
 * Heals a masked region: borrow texture from nearby, then correct its colour
 * so the seam disappears.
 *
 * A plain smooth interpolation from the boundary removes a blemish but leaves
 * a blurred patch with no texture. Copying a neighbouring patch keeps the
 * texture but shows an edge where the two differ in tone. Doing both — copy,
 * then solve for a smooth correction field that is zero-Laplacian inside and
 * matches the difference at the boundary — is what makes the repair invisible.
 */
export function healRegion(request: HealRequest): HealResult | null {
  const { pixels, width, height, mask } = request;
  const bounds = maskBounds(mask, width, height);
  if (!bounds) return null;

  const regionWidth = bounds.right - bounds.left + 1;
  const regionHeight = bounds.bottom - bounds.top + 1;
  const area = regionWidth * regionHeight;

  const source = findSourceOffset(pixels, width, height, mask, bounds);
  const output = new Uint8ClampedArray(pixels);

  // Work on the region plus a one pixel ring, which carries the boundary
  // condition for the relaxation.
  const left = Math.max(0, bounds.left - 1);
  const top = Math.max(0, bounds.top - 1);
  const right = Math.min(width - 1, bounds.right + 1);
  const bottom = Math.min(height - 1, bounds.bottom + 1);
  const w = right - left + 1;
  const h = bottom - top + 1;

  const inside = new Uint8Array(w * h);
  const patch = new Float32Array(w * h * 3);
  const correction = new Float32Array(w * h * 3);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = left + x;
      const gy = top + y;
      const local = y * w + x;
      const global = gy * width + gx;
      const covered = mask[global]! >= 128;
      inside[local] = covered ? 1 : 0;

      // Inside the hole take the borrowed texture; outside keep what is there.
      const sx = covered ? Math.min(width - 1, Math.max(0, gx + source.dx)) : gx;
      const sy = covered ? Math.min(height - 1, Math.max(0, gy + source.dy)) : gy;
      const from = (sy * width + sx) * 4;

      patch[local * 3] = pixels[from]!;
      patch[local * 3 + 1] = pixels[from + 1]!;
      patch[local * 3 + 2] = pixels[from + 2]!;

      if (!covered) {
        // Boundary condition: how far the borrowed texture is from reality.
        const here = global * 4;
        correction[local * 3] = pixels[here]! - patch[local * 3]!;
        correction[local * 3 + 1] = pixels[here + 1]! - patch[local * 3 + 1]!;
        correction[local * 3 + 2] = pixels[here + 2]! - patch[local * 3 + 2]!;
      }
    }
  }

  // Relax the correction field: harmonic inside, fixed on the ring.
  const iterations = request.iterations ?? 220;
  for (let step = 0; step < iterations; step++) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const local = y * w + x;
        if (inside[local] === 0) continue;

        for (let c = 0; c < 3; c++) {
          correction[local * 3 + c] =
            (correction[(local - 1) * 3 + c]! +
              correction[(local + 1) * 3 + c]! +
              correction[(local - w) * 3 + c]! +
              correction[(local + w) * 3 + c]!) / 4;
        }
      }
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const local = y * w + x;
      if (inside[local] === 0) continue;

      const global = ((top + y) * width + (left + x)) * 4;
      // Partial coverage at a soft brush edge blends rather than replaces.
      const coverage = mask[(top + y) * width + (left + x)]! / 255;
      for (let c = 0; c < 3; c++) {
        const healed = patch[local * 3 + c]! + correction[local * 3 + c]!;
        output[global + c] = pixels[global + c]! * (1 - coverage) + healed * coverage;
      }
    }
  }

  return { pixels: output, area };
}

/**
 * Picks where to borrow texture from, by trying offsets around the region and
 * keeping the one whose boundary ring best matches the real surroundings.
 */
function findSourceOffset(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8ClampedArray,
  bounds: Box,
): { dx: number; dy: number } {
  const regionWidth = bounds.right - bounds.left + 1;
  const regionHeight = bounds.bottom - bounds.top + 1;

  const ring: number[] = [];
  for (let y = bounds.top; y <= bounds.bottom; y++) {
    for (let x = bounds.left; x <= bounds.right; x++) {
      const index = y * width + x;
      if (mask[index]! >= 128) continue;
      if (
        (x > 0 && mask[index - 1]! >= 128) ||
        (x < width - 1 && mask[index + 1]! >= 128) ||
        (y > 0 && mask[index - width]! >= 128) ||
        (y < height - 1 && mask[index + width]! >= 128)
      ) {
        ring.push(index);
      }
    }
  }
  if (ring.length === 0) return { dx: regionWidth + 4, dy: 0 };

  let best = { dx: regionWidth + 4, dy: 0 };
  let bestScore = Infinity;

  const spans = [1.2, 1.8, 2.6];
  for (const span of spans) {
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      const dx = Math.round(Math.cos(angle) * regionWidth * span);
      const dy = Math.round(Math.sin(angle) * regionHeight * span);
      if (dx === 0 && dy === 0) continue;

      let score = 0;
      let counted = 0;
      for (const index of ring) {
        const x = index % width;
        const y = (index - x) / width;
        const sx = x + dx;
        const sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) { score += 4000; continue; }
        // Never borrow from inside the hole itself.
        if (mask[sy * width + sx]! >= 128) { score += 4000; continue; }

        const a = index * 4;
        const b = (sy * width + sx) * 4;
        for (let c = 0; c < 3; c++) {
          const diff = pixels[a + c]! - pixels[b + c]!;
          score += diff * diff;
        }
        counted++;
      }

      const normalised = counted === 0 ? Infinity : score / counted;
      if (normalised < bestScore) {
        bestScore = normalised;
        best = { dx, dy };
      }
    }
  }
  return best;
}
