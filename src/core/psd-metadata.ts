import type { DocumentGuide } from './guides';
import type { LayerStyles } from './layer-styles';
import type { VectorPath } from './path';

/** Bumped if the shape below ever changes incompatibly. */
const SIDECAR_VERSION = 1;

const OPEN = '<pixelforge:state>';
const CLOSE = '</pixelforge:state>';

/**
 * The parts of a document PSD cannot carry.
 *
 * Layer effects and guides map onto real PSD structures and are written there
 * as well, so Photoshop shows them; this sidecar exists because those models
 * are not identical to ours (spread and midpoint have no exact PSD equivalent)
 * and because ag-psd does not implement the image resource that holds named
 * paths at all. Anything found here wins on reopen, so a PixelForge round trip
 * is exact while the PSD stays readable everywhere else.
 */
export interface PsdSidecar {
  readonly version: number;
  /** Keyed by the layer's index in a depth-first walk of the written tree. */
  readonly styles: Record<string, LayerStyles>;
  readonly paths: readonly VectorPath[];
  readonly activePathId: string | null;
  readonly guides: readonly DocumentGuide[];
}

export function buildSidecar(
  styles: Record<string, LayerStyles>,
  paths: readonly VectorPath[],
  activePathId: string | null,
  guides: readonly DocumentGuide[],
): PsdSidecar {
  return { version: SIDECAR_VERSION, styles, paths, activePathId, guides };
}

export function isEmptySidecar(sidecar: PsdSidecar): boolean {
  return Object.keys(sidecar.styles).length === 0
    && sidecar.paths.length === 0
    && sidecar.guides.length === 0;
}

/**
 * Wraps the sidecar in an XMP packet.
 *
 * XMP is where an application is meant to put its own metadata, and every
 * reader that does not recognise the namespace ignores it, so this cannot
 * affect how another program reads the file.
 */
export function encodeSidecar(sidecar: PsdSidecar): string {
  const json = JSON.stringify(sidecar);
  // XMP is XML, so the payload has to survive being parsed as character data.
  const escaped = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>`
    + `<x:xmpmeta xmlns:x="adobe:ns:meta/">`
    + `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`
    + `<rdf:Description rdf:about="" xmlns:pixelforge="https://pixelforge.local/ns/1.0/">`
    + `${OPEN}${escaped}${CLOSE}`
    + `</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

export function decodeSidecar(xmp: string | undefined): PsdSidecar | null {
  if (!xmp) return null;
  const start = xmp.indexOf(OPEN);
  const end = xmp.indexOf(CLOSE, start);
  if (start < 0 || end < 0) return null;

  const escaped = xmp.slice(start + OPEN.length, end);
  const json = escaped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  try {
    const parsed = JSON.parse(json) as Partial<PsdSidecar>;
    if (parsed.version !== SIDECAR_VERSION) return null;
    return {
      version: SIDECAR_VERSION,
      styles: parsed.styles ?? {},
      paths: parsed.paths ?? [],
      activePathId: parsed.activePathId ?? null,
      guides: parsed.guides ?? [],
    };
  } catch {
    // Someone else's XMP, or ours from a build that wrote it differently.
    return null;
  }
}
