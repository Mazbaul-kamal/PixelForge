/** The CSS grid frame. Later steps fill these regions; step 1 only builds them. */
export interface AppShell {
  root: HTMLElement;
  menuBar: HTMLElement;
  optionsBar: HTMLElement;
  toolRail: HTMLElement;
  stage: HTMLElement;
  panels: HTMLElement;
  statusBar: HTMLElement;
}

function region(tag: string, className: string, label: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.setAttribute('aria-label', label);
  return element;
}

export function createAppShell(mount: HTMLElement): AppShell {
  const root = document.createElement('div');
  root.className = 'pf-app';

  const menuBar = region('header', 'pf-menubar', 'Menu bar');
  const optionsBar = region('div', 'pf-optionsbar', 'Tool options');
  const toolRail = region('nav', 'pf-rail', 'Tools');
  const stage = region('main', 'pf-stage', 'Canvas');
  const panels = region('aside', 'pf-panels', 'Panels');
  const statusBar = region('footer', 'pf-status', 'Status');

  root.append(menuBar, optionsBar, toolRail, stage, panels, statusBar);
  mount.replaceChildren(root);

  return { root, menuBar, optionsBar, toolRail, stage, panels, statusBar };
}
