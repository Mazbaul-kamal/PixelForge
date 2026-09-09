/** A titled block in the right-hand panel column. */
export interface Panel {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
}

export function createPanel(title: string, modifier?: string): Panel {
  const root = document.createElement('section');
  root.className = modifier ? `pf-panel pf-panel--${modifier}` : 'pf-panel';

  const heading = document.createElement('h2');
  heading.className = 'pf-panel-title';
  heading.textContent = title;

  const body = document.createElement('div');
  body.className = 'pf-panel-body';

  root.append(heading, body);
  return { root, body };
}
