import { cssFont } from '../core/text-layer';
import type { Layer } from '../core/types';
import type { Viewport } from '../core/viewport';

export interface TextEditorOptions {
  readonly host: HTMLElement;
  readonly layer: Layer;
  readonly viewport: Viewport;
  /** Padding between the layer origin and the text origin. */
  readonly padding: number;
  readonly onInput: (text: string) => void;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
}

export interface TextEditorHandle {
  /** Re-place the overlay after a zoom, pan or re-render. */
  reposition(padding: number): void;
  readonly element: HTMLElement;
  destroy(): void;
}

/**
 * Editing happens on the canvas, not in a dialog.
 *
 * A contenteditable sits exactly over the text layer with the same font
 * metrics scaled to the current zoom, but with transparent glyphs: the visible
 * text is the layer's own render, while the browser supplies a real caret,
 * selection and IME handling.
 */
export function openTextEditor(options: TextEditorOptions): TextEditorHandle {
  const { host, layer, viewport } = options;

  const element = document.createElement('div');
  element.className = 'pf-text-editor';
  element.contentEditable = 'plaintext-only';
  element.spellcheck = false;
  element.textContent = layer.text?.text ?? '';

  const place = (padding: number): void => {
    const data = layer.text;
    if (!data) return;

    const origin = viewport.docToScreen(layer.x + padding, layer.y + padding);
    const zoom = viewport.zoom;
    const style = data.style;

    element.style.left = `${origin.x}px`;
    element.style.top = `${origin.y}px`;
    element.style.font = cssFont({ ...style, fontSize: style.fontSize * zoom });
    element.style.lineHeight = `${style.fontSize * style.lineHeight * zoom}px`;
    element.style.letterSpacing = `${style.letterSpacing * zoom}px`;
    element.style.textAlign = style.align === 'centre' ? 'center' : style.align;
    element.style.width = data.boxWidth === null ? 'auto' : `${data.boxWidth * zoom}px`;
    element.style.whiteSpace = data.boxWidth === null ? 'pre' : 'pre-wrap';
  };

  place(options.padding);
  host.appendChild(element);

  const onInput = (): void => {
    // innerText keeps the line breaks the browser inserted.
    options.onInput(element.innerText.replace(/\n$/, ''));
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      options.onCancel();
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      options.onCommit();
    }
  };

  const onPointerDownOutside = (event: PointerEvent): void => {
    if (event.target instanceof Node && element.contains(event.target)) return;
    options.onCommit();
  };

  element.addEventListener('input', onInput);
  element.addEventListener('keydown', onKeyDown);
  // Deferred so the click that created the editor does not immediately close it.
  const timer = window.setTimeout(() => {
    window.addEventListener('pointerdown', onPointerDownOutside, true);
  }, 0);

  element.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  return {
    element,
    reposition: place,
    destroy(): void {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', onPointerDownOutside, true);
      element.removeEventListener('input', onInput);
      element.removeEventListener('keydown', onKeyDown);
      element.remove();
    },
  };
}
