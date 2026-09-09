import type { ToolManager } from '../tools/tool-manager';

const ICONS: Record<string, string> = {
  hand: '<path d="M6 9V4.6a1.3 1.3 0 0 1 2.6 0V9"/><path d="M8.6 8.6V3.4a1.3 1.3 0 0 1 2.6 0v5.2"/><path d="M11.2 9V4.9a1.3 1.3 0 0 1 2.6 0V12a5.2 5.2 0 0 1-5.2 5.2H8A5 5 0 0 1 3.7 14L2.5 11.7a1.3 1.3 0 0 1 2.1-1.5L6 11.8"/>',
};

const FALLBACK_ICON = '<circle cx="10" cy="10" r="5.6"/>';

function icon(toolId: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[toolId] ?? FALLBACK_ICON;
  return svg;
}

/** The left rail. Built from the registry, so a new tool needs no edit here. */
export class ToolRail {
  private readonly host: HTMLElement;
  private readonly tools: ToolManager;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly detach: () => void;
  private renderedIds = '';

  constructor(host: HTMLElement, tools: ToolManager) {
    this.host = host;
    this.tools = tools;
    this.host.classList.add('pf-rail-filled');

    this.detach = tools.subscribe(() => this.render());
    this.render();
  }

  destroy(): void {
    this.detach();
    this.host.replaceChildren();
  }

  private render(): void {
    const registered = this.tools.registered;
    const ids = registered.map((tool) => tool.id).join(',');

    if (ids !== this.renderedIds) {
      this.buttons.clear();
      const list = document.createElement('div');
      list.className = 'pf-rail-tools';
      list.setAttribute('role', 'toolbar');
      list.setAttribute('aria-label', 'Tools');
      list.setAttribute('aria-orientation', 'vertical');

      for (const tool of registered) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pf-tool';
        button.title = `${tool.name}  (${tool.shortcut.toUpperCase()})`;
        button.setAttribute('aria-label', `${tool.name} tool, shortcut ${tool.shortcut}`);
        button.appendChild(icon(tool.id));
        button.addEventListener('click', () => this.tools.setActiveTool(tool.id));

        this.buttons.set(tool.id, button);
        list.appendChild(button);
      }

      const existing = this.host.querySelector('.pf-rail-tools');
      if (existing) existing.replaceWith(list);
      else this.host.prepend(list);
      this.renderedIds = ids;
    }

    const activeId = this.tools.activeTool?.id ?? null;
    for (const [id, button] of this.buttons) {
      const isActive = id === activeId;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }
  }
}
