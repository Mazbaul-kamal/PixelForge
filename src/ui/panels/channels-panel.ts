import {
  CHANNEL_VIEW_NAMES, CHANNEL_VIEWS, deleteChannel, duplicateChannel,
  loadChannelAsSelection, newEmptyChannel, renameChannel, saveSelectionAsChannel,
  setChannelVisible,
} from '../../core/channels';
import type { AlphaChannel, ChannelView } from '../../core/channels';
import type { PixelDocument } from '../../core/document';
import type { History } from '../../core/history';
import { createPanel } from '../panel';

export interface ChannelsPanelDeps {
  readonly doc: PixelDocument;
  readonly history: History;
  /** Recomposite and redraw; channels change what the view shows. */
  readonly changed: () => void;
  readonly notify: (message: string, detail?: string) => void;
}

function button(label: string, title: string, run: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'pf-icon-button';
  element.textContent = label;
  element.title = title;
  element.addEventListener('click', run);
  return element;
}

/**
 * The colour channels of the composite, and any stored selections beneath.
 *
 * Selecting a colour channel isolates it in the view as grey; an alpha channel
 * can be shown over the composite as a tint, or loaded back as a selection.
 */
export class ChannelsPanel {
  readonly root: HTMLElement;
  private readonly deps: ChannelsPanelDeps;
  private readonly colourList: HTMLElement;
  private readonly alphaList: HTMLElement;
  private readonly unsubscribe: () => void;
  private renaming: string | null = null;

  constructor(deps: ChannelsPanelDeps) {
    this.deps = deps;

    const panel = createPanel('Channels', 'channels');
    this.root = panel.root;

    this.colourList = document.createElement('div');
    this.colourList.className = 'pf-channel-list';
    panel.body.appendChild(this.colourList);

    const divider = document.createElement('div');
    divider.className = 'pf-channel-divider';
    panel.body.appendChild(divider);

    this.alphaList = document.createElement('div');
    this.alphaList.className = 'pf-channel-list pf-channel-list--alpha';
    panel.body.appendChild(this.alphaList);

    const actions = document.createElement('div');
    actions.className = 'pf-channel-actions';
    actions.append(
      button('◌', 'Load the channel as a selection', () => this.withChannel(
        (id) => loadChannelAsSelection(this.deps.doc, this.deps.history, id),
      )),
      button('⬚', 'Save the selection as a channel', () => {
        if (!saveSelectionAsChannel(this.deps.doc, this.deps.history)) {
          this.deps.notify('Select something first.', 'The selection becomes a channel.');
          return;
        }
        this.after();
      }),
      button('+', 'New empty channel', () => {
        newEmptyChannel(this.deps.doc, this.deps.history);
        this.after();
      }),
      button('⧉', 'Duplicate the channel', () => this.withChannel(
        (id) => duplicateChannel(this.deps.doc, this.deps.history, id),
      )),
      button('🗑', 'Delete the channel', () => this.withChannel(
        (id) => deleteChannel(this.deps.doc, this.deps.history, id),
      )),
    );
    panel.body.appendChild(actions);

    this.unsubscribe = deps.history.subscribe(() => this.render());
    this.render();
  }

  destroy(): void {
    this.unsubscribe();
    this.root.remove();
  }

  /** The channel the buttons act on: the last one clicked, else the last one. */
  private selected: string | null = null;

  private withChannel(run: (id: string) => boolean): void {
    const id = this.selected
      ?? this.deps.doc.channels[this.deps.doc.channels.length - 1]?.id
      ?? null;
    if (!id || !run(id)) {
      this.deps.notify('Select a channel first.');
      return;
    }
    this.after();
  }

  private after(): void {
    this.deps.changed();
    this.render();
  }

  private setView(view: ChannelView): void {
    this.deps.doc.channelView = view;
    this.after();
  }

  render(): void {
    const { doc } = this.deps;

    this.colourList.replaceChildren();
    for (const view of CHANNEL_VIEWS) {
      const row = document.createElement('div');
      row.className = 'pf-channel-row';
      row.classList.toggle('is-active', doc.channelView === view);

      const name = document.createElement('span');
      name.className = 'pf-channel-name';
      name.textContent = CHANNEL_VIEW_NAMES[view];

      const hint = document.createElement('span');
      hint.className = 'pf-channel-hint';
      hint.textContent = view === 'rgb' ? 'composite' : '';

      row.append(name, hint);
      row.addEventListener('click', () => this.setView(view));
      this.colourList.appendChild(row);
    }

    this.alphaList.replaceChildren();
    if (doc.channels.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pf-channel-empty';
      empty.textContent = 'No stored selections. Select something, then press ⬚.';
      this.alphaList.appendChild(empty);
      return;
    }

    for (const channel of doc.channels) {
      this.alphaList.appendChild(this.row(channel));
    }
  }

  private row(channel: AlphaChannel): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pf-channel-row';
    row.classList.toggle('is-active', this.selected === channel.id);

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'pf-channel-eye';
    eye.textContent = channel.visible ? '◉' : '○';
    eye.title = channel.visible ? 'Hide the tint' : 'Show the channel as a tint';
    eye.addEventListener('click', (event) => {
      event.stopPropagation();
      setChannelVisible(this.deps.doc, channel.id, !channel.visible);
      this.after();
    });

    const swatch = document.createElement('span');
    swatch.className = 'pf-channel-swatch';
    swatch.style.background = channel.colour;

    const name = document.createElement('span');
    name.className = 'pf-channel-name';
    name.textContent = channel.name;

    row.append(eye, swatch, name);
    row.addEventListener('click', () => {
      this.selected = channel.id;
      this.render();
    });
    name.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      this.beginRename(channel, name);
    });

    return row;
  }

  private beginRename(channel: AlphaChannel, label: HTMLElement): void {
    if (this.renaming) return;
    this.renaming = channel.id;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pf-channel-rename';
    input.value = channel.name;

    const finish = (commit: boolean): void => {
      if (this.renaming !== channel.id) return;
      this.renaming = null;
      const value = input.value;
      input.replaceWith(label);
      if (commit) renameChannel(this.deps.doc, this.deps.history, channel.id, value);
      this.after();
    };

    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));

    label.replaceWith(input);
    input.focus();
    input.select();
  }
}
