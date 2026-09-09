import type { ToolManager } from '../tools/tool-manager';

const ZOOM_ICON =
  '<circle cx="8.6" cy="8.6" r="5.1"/><path d="M12.4 12.4 17 17"/><path d="M6.3 8.6h4.6"/>';

const MOVE_ICON =
  '<path d="M10 2.5v15M2.5 10h15"/><path d="M10 2.5 7.6 5M10 2.5 12.4 5"/><path d="M10 17.5 7.6 15M10 17.5 12.4 15"/><path d="M2.5 10 5 7.6M2.5 10 5 12.4"/><path d="M17.5 10 15 7.6M17.5 10 15 12.4"/>';

const BRUSH_ICON =
  '<path d="M15.6 3.2a2 2 0 0 1 1.2 3.4l-6.5 6.5-3.4-3.4 6.5-6.5a2 2 0 0 1 2.2 0z"/><path d="M6.9 9.7 4.4 12.2a3.4 3.4 0 0 0-.9 3.3l-1 1.9 1.9-1a3.4 3.4 0 0 0 3.3-.9l2.5-2.5"/>';

const ERASER_ICON =
  '<path d="m8.4 16.5-4-4a1.6 1.6 0 0 1 0-2.3l6.2-6.2a1.6 1.6 0 0 1 2.3 0l3.4 3.4a1.6 1.6 0 0 1 0 2.3l-6.8 6.8z"/><path d="M6.2 10.7 11.9 16.5"/><path d="M8.4 16.5H17"/>';

const MARQUEE_ICON =
  '<rect x="3" y="4.5" width="14" height="11" stroke-dasharray="3 2"/>';

const ELLIPSE_ICON = '<ellipse cx="10" cy="10" rx="7" ry="5.5" stroke-dasharray="3 2"/>';
const LASSO_ICON =
  '<path d="M10 3.4c3.9 0 7 2.1 7 4.8s-3.1 4.8-7 4.8c-2.4 0-4.5-.8-5.8-2"/><path d="M4.2 11c-.9.9-1.2 2-.7 2.8.6.9 2 1 3 .3"/><circle cx="6.5" cy="15.6" r="1.4"/>';
const POLYGON_LASSO_ICON =
  '<path d="M3.5 8.5 9 3.8l7.2 3.4-2.4 6.4-6.6 1.1z" stroke-dasharray="3 2"/>';

const ICONS: Record<string, string> = {
  marquee: MARQUEE_ICON,
  'ellipse-marquee': ELLIPSE_ICON,
  lasso: LASSO_ICON,
  'polygon-lasso': POLYGON_LASSO_ICON,
  brush: BRUSH_ICON,
  eraser: ERASER_ICON,
  move: MOVE_ICON,
  zoom: ZOOM_ICON,
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
        button.addEventListener('dblclick', () => {
          this.tools.setActiveTool(tool.id);
          tool.onRailDoubleClick?.(this.tools.context);
        });

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
