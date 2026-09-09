export type NoticeTone = 'error' | 'info';

const AUTO_DISMISS_MS = 4500;

/**
 * Inline notices. Errors say what went wrong and what to do about it, and stay
 * until dismissed; alert() would block the app and cannot show two problems.
 */
export class NoticeStack {
  readonly root: HTMLElement;

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'pf-notices';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    host.appendChild(this.root);
  }

  show(title: string, detail = '', tone: NoticeTone = 'info'): void {
    const notice = document.createElement('div');
    notice.className = `pf-notice pf-notice--${tone}`;

    const text = document.createElement('div');
    text.className = 'pf-notice-text';

    const heading = document.createElement('p');
    heading.className = 'pf-notice-title';
    heading.textContent = title;
    text.appendChild(heading);

    if (detail) {
      const body = document.createElement('p');
      body.className = 'pf-notice-detail';
      body.textContent = detail;
      text.appendChild(body);
    }

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'pf-notice-close';
    dismiss.textContent = '×';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.addEventListener('click', () => notice.remove());

    notice.append(text, dismiss);
    this.root.appendChild(notice);

    if (tone === 'info') {
      setTimeout(() => notice.remove(), AUTO_DISMISS_MS);
    }
  }

  error(title: string, detail = ''): void {
    this.show(title, detail, 'error');
  }
}
