/**
 * True when the event target is somewhere the user is typing, so shortcuts
 * must not fire. Range and checkbox inputs are not typing surfaces.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['range', 'checkbox', 'radio', 'button', 'color'].includes(target.type);
  }
  return false;
}
