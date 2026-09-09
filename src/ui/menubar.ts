export interface MenuItem {
  label: string;
  shortcut?: string;
  run: () => void;
}

export interface MenuDefinition {
  label: string;
  items: readonly MenuItem[];
}

/** A small menu bar: click or keyboard, one open menu at a time. */
export function buildMenuBar(host: HTMLElement, menus: readonly MenuDefinition[]): () => void {
  host.replaceChildren();
  host.classList.add('pf-menubar-filled');

  let openPanel: HTMLElement | null = null;
  let openButton: HTMLButtonElement | null = null;

  const close = (): void => {
    if (openPanel) openPanel.hidden = true;
    openButton?.setAttribute('aria-expanded', 'false');
    openPanel = null;
    openButton = null;
  };

  for (const menu of menus) {
    const wrap = document.createElement('div');
    wrap.className = 'pf-menu';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pf-menu-button';
    button.textContent = menu.label;
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');

    const panel = document.createElement('div');
    panel.className = 'pf-menu-panel';
    panel.setAttribute('role', 'menu');
    panel.hidden = true;

    for (const item of menu.items) {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.className = 'pf-menu-item';
      entry.setAttribute('role', 'menuitem');

      const label = document.createElement('span');
      label.textContent = item.label;
      entry.appendChild(label);

      if (item.shortcut) {
        const hint = document.createElement('span');
        hint.className = 'pf-menu-shortcut';
        hint.textContent = item.shortcut;
        entry.appendChild(hint);
      }

      entry.addEventListener('click', () => {
        close();
        item.run();
      });
      panel.appendChild(entry);
    }

    button.addEventListener('click', () => {
      const wasOpen = openPanel === panel;
      close();
      if (wasOpen) return;
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      openPanel = panel;
      openButton = button;
      panel.querySelector<HTMLElement>('.pf-menu-item')?.focus();
    });

    wrap.append(button, panel);
    host.appendChild(wrap);
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (!(event.target instanceof Node) || !host.contains(event.target)) close();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };

  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeyDown);

  return () => {
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('keydown', onKeyDown);
    host.replaceChildren();
  };
}
