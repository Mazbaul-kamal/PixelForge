import type { OptionSpec } from '../tools/types';
import type { ToolManager } from '../tools/tool-manager';

/**
 * Renders the active tool's option schema. Adding a tool never means editing
 * this file: every OptionSpec variant is handled here once.
 */
export class OptionsBar {
  private readonly host: HTMLElement;
  private readonly tools: ToolManager;
  private readonly detachers: Array<() => void> = [];
  private renderedToolId: string | null = null;

  constructor(host: HTMLElement, tools: ToolManager) {
    this.host = host;
    this.tools = tools;
    this.host.classList.add('pf-optionsbar-filled');

    this.detachers.push(tools.subscribe(() => this.render()));
    this.render();
  }

  destroy(): void {
    for (const detach of this.detachers) detach();
    this.host.replaceChildren();
  }

  private render(): void {
    const tool = this.tools.activeTool;
    if (!tool) {
      this.host.replaceChildren();
      this.renderedToolId = null;
      return;
    }
    if (tool.id === this.renderedToolId) return;
    this.renderedToolId = tool.id;

    const name = document.createElement('span');
    name.className = 'pf-options-tool';
    name.textContent = tool.name;

    const controls = tool.options.map((spec) => this.buildControl(spec));
    this.host.replaceChildren(name, ...controls);
  }

  private buildControl(spec: OptionSpec): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'pf-option';

    if (spec.type === 'button') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pf-option-button';
      button.textContent = spec.label;
      if (spec.title) {
        button.title = spec.title;
        button.setAttribute('aria-label', spec.title);
      }
      button.addEventListener('click', () => spec.run(this.tools.context));
      wrap.appendChild(button);
      return wrap;
    }

    const label = document.createElement('label');
    label.className = 'pf-option-label';
    label.textContent = spec.label;
    wrap.appendChild(label);

    wrap.appendChild(this.buildInput(spec, label));
    return wrap;
  }

  private buildInput(
    spec: Exclude<OptionSpec, { type: 'button' }>,
    label: HTMLLabelElement,
  ): HTMLElement {
    const options = this.tools.context.options;
    const id = `pf-opt-${spec.id}`;
    label.htmlFor = id;

    switch (spec.type) {
      case 'slider': {
        const group = document.createElement('div');
        group.className = 'pf-option-group';

        const input = document.createElement('input');
        input.type = 'range';
        input.id = id;
        input.className = 'pf-range';
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = String(spec.step ?? 1);
        input.value = String(options.get<number>(spec.id));

        const readout = document.createElement('span');
        readout.className = 'pf-option-value';
        const paint = (): void => {
          readout.textContent = `${input.value}${spec.unit ?? ''}`;
        };
        paint();

        input.addEventListener('input', () => {
          options.set(spec.id, Number(input.value));
          paint();
        });

        group.append(input, readout);
        return group;
      }

      case 'number': {
        const input = document.createElement('input');
        input.type = 'number';
        input.id = id;
        input.className = 'pf-input pf-input--compact';
        if (spec.min !== undefined) input.min = String(spec.min);
        if (spec.max !== undefined) input.max = String(spec.max);
        input.step = String(spec.step ?? 1);
        input.value = String(options.get<number>(spec.id));
        input.addEventListener('change', () => options.set(spec.id, Number(input.value)));
        return input;
      }

      case 'colour': {
        const input = document.createElement('input');
        input.type = 'color';
        input.id = id;
        input.className = 'pf-colour';
        input.value = options.get<string>(spec.id);
        input.addEventListener('input', () => options.set(spec.id, input.value));
        return input;
      }

      case 'select': {
        const select = document.createElement('select');
        select.id = id;
        select.className = 'pf-select pf-select--compact';
        for (const choice of spec.choices) {
          const option = document.createElement('option');
          option.value = choice.value;
          option.textContent = choice.label;
          select.appendChild(option);
        }
        select.value = options.get<string>(spec.id);
        select.addEventListener('change', () => options.set(spec.id, select.value));
        return select;
      }

      case 'checkbox': {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = id;
        input.className = 'pf-checkbox';
        input.checked = options.get<boolean>(spec.id);
        input.addEventListener('change', () => options.set(spec.id, input.checked));
        return input;
      }
    }
  }
}
