import type { PixelDocument } from './document';
import type { History } from './history';
import type { CombineMode } from './selection';
import { SelectionMask } from './selection';

/** Which colour channel the view is isolating, or the full composite. */
export type ChannelView = 'rgb' | 'red' | 'green' | 'blue';

export const CHANNEL_VIEWS: readonly ChannelView[] = ['rgb', 'red', 'green', 'blue'];

export const CHANNEL_VIEW_NAMES: Record<ChannelView, string> = {
  rgb: 'RGB',
  red: 'Red',
  green: 'Green',
  blue: 'Blue',
};

/**
 * A stored selection.
 *
 * Immutable, like the document's other records: editing one replaces the whole
 * object, so history can hold it by reference and the compositor can cache an
 * overlay by identity. The mask itself is already immutable.
 */
export interface AlphaChannel {
  readonly id: string;
  readonly name: string;
  readonly mask: SelectionMask;
  /** Shown over the composite as a tint, the way a quick mask reads. */
  readonly visible: boolean;
  readonly colour: string;
  /** 0..1 */
  readonly opacity: number;
}

let counter = 0;

function nextId(): string {
  counter += 1;
  return `alpha-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createChannel(name: string, mask: SelectionMask): AlphaChannel {
  return { id: nextId(), name, mask, visible: false, colour: '#ff2d55', opacity: 0.5 };
}

function nextName(doc: PixelDocument): string {
  const taken = new Set(doc.channels.map((channel) => channel.name));
  let index = doc.channels.length + 1;
  while (taken.has(`Alpha ${index}`)) index += 1;
  return `Alpha ${index}`;
}

/** Stores the current selection as a new channel. */
export function saveSelectionAsChannel(doc: PixelDocument, history: History): boolean {
  if (!doc.selection) return false;
  const channel = createChannel(nextName(doc), doc.selection);
  return history.transaction('Save Selection', () => {
    doc.channels = [...doc.channels, channel];
  });
}

/** Loads a channel back as the selection, combining with what is there. */
export function loadChannelAsSelection(
  doc: PixelDocument, history: History, id: string, mode: CombineMode = 'new',
): boolean {
  const channel = doc.channels.find((existing) => existing.id === id);
  if (!channel) return false;

  return history.transaction('Load Channel', () => {
    doc.selection = mode === 'new' || !doc.selection
      ? channel.mask
      : doc.selection.combine(channel.mask, mode);
  });
}

export function deleteChannel(doc: PixelDocument, history: History, id: string): boolean {
  if (!doc.channels.some((channel) => channel.id === id)) return false;
  return history.transaction('Delete Channel', () => {
    doc.channels = doc.channels.filter((channel) => channel.id !== id);
  });
}

export function duplicateChannel(doc: PixelDocument, history: History, id: string): boolean {
  const channel = doc.channels.find((existing) => existing.id === id);
  if (!channel) return false;
  return history.transaction('Duplicate Channel', () => {
    doc.channels = [...doc.channels, { ...channel, id: nextId(), name: `${channel.name} copy` }];
  });
}

export function renameChannel(
  doc: PixelDocument, history: History, id: string, name: string,
): boolean {
  const channel = doc.channels.find((existing) => existing.id === id);
  const trimmed = name.trim();
  if (!channel || !trimmed || trimmed === channel.name) return false;
  return history.transaction('Rename Channel', () => {
    doc.channels = doc.channels.map((existing) => (
      existing.id === id ? { ...existing, name: trimmed } : existing
    ));
  });
}

/** Visibility is a view state, so it is not worth a history entry. */
export function setChannelVisible(doc: PixelDocument, id: string, visible: boolean): boolean {
  const channel = doc.channels.find((existing) => existing.id === id);
  if (!channel || channel.visible === visible) return false;
  doc.channels = doc.channels.map((existing) => (
    existing.id === id ? { ...existing, visible } : existing
  ));
  return true;
}

/** An empty channel, for painting a mask from scratch. */
export function newEmptyChannel(doc: PixelDocument, history: History): boolean {
  const channel = createChannel(nextName(doc), SelectionMask.empty(doc.width, doc.height));
  return history.transaction('New Channel', () => {
    doc.channels = [...doc.channels, channel];
  });
}

export function anyChannelVisible(doc: PixelDocument): boolean {
  return doc.channels.some((channel) => channel.visible);
}
