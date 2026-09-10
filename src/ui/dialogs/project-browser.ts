import { formatBytes } from '../../core/project-store';
import type { ProjectSummary, StorageReport } from '../../core/project-store';
import { openDialog } from '../dialog';

function whenText(updated: number): string {
  const seconds = Math.max(0, (Date.now() - updated) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours ago`;
  return new Date(updated).toLocaleDateString();
}

export interface ProjectBrowserOptions {
  readonly projects: readonly ProjectSummary[];
  readonly storage: StorageReport | null;
  readonly onOpen: (id: string) => void;
  readonly onDelete: (id: string) => void;
}

/** The project list: name, thumbnail, size, when it was last touched. */
export function openProjectBrowser(options: ProjectBrowserOptions): void {
  const body = document.createElement('div');
  body.className = 'pf-project-list';

  if (options.projects.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'pf-dialog-message';
    empty.textContent = 'No saved projects yet. Use File then Save Project to keep one here.';
    body.appendChild(empty);
  }

  for (const project of options.projects) {
    const row = document.createElement('div');
    row.className = 'pf-project-row';

    const thumb = document.createElement('div');
    thumb.className = 'pf-project-thumb';
    if (project.thumbnail) {
      const image = document.createElement('img');
      image.src = URL.createObjectURL(project.thumbnail);
      image.addEventListener('load', () => URL.revokeObjectURL(image.src));
      thumb.appendChild(image);
    }

    const details = document.createElement('div');
    details.className = 'pf-project-details';

    const name = document.createElement('div');
    name.className = 'pf-project-name';
    name.textContent = project.name;

    const meta = document.createElement('div');
    meta.className = 'pf-project-meta';
    meta.textContent = `${formatBytes(project.bytes)} · ${whenText(project.updated)}`;

    details.append(name, meta);

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'pf-button pf-button--primary';
    open.textContent = 'Open';
    open.addEventListener('click', () => {
      dialog.close();
      options.onOpen(project.id);
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'pf-button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => {
      row.remove();
      options.onDelete(project.id);
    });

    row.append(thumb, details, open, remove);
    body.appendChild(row);
  }

  if (options.storage) {
    const usage = document.createElement('p');
    usage.className = 'pf-dialog-note';
    const percent = Math.round(options.storage.ratio * 100);
    usage.textContent =
      `Using ${formatBytes(options.storage.usage)} of ${formatBytes(options.storage.quota)} ` +
      `(${percent}%)${options.storage.persisted ? ', kept by the browser' : ''}.`;
    if (options.storage.ratio >= 0.8) usage.classList.add('pf-warning');
    body.appendChild(usage);
  }

  const dialog = openDialog({
    title: 'Projects',
    body,
    primaryLabel: 'Close',
    cancelLabel: 'Cancel',
    onPrimary: () => {},
  });
}

/** Asked on startup when a recovery snapshot is newer than the saved project. */
export function openRecoveryPrompt(
  name: string,
  when: number,
  onChoice: (restore: boolean) => void,
): void {
  const body = document.createElement('div');

  const message = document.createElement('p');
  message.className = 'pf-dialog-message';
  message.textContent =
    `“${name}” has unsaved changes from ${whenText(when)}, saved automatically before the ` +
    'tab closed. Restore them, or discard and keep the last saved version?';
  body.appendChild(message);

  let restored = false;
  const dialog = openDialog({
    title: 'Recover unsaved work?',
    body,
    primaryLabel: 'Restore',
    cancelLabel: 'Discard',
    onPrimary: () => { restored = true; },
  });
  dialog.addEventListener('close', () => onChoice(restored));
}
