import { moveItem } from './favorites';

/**
 * A global command pin (docs/design/dashboard.md section 4.6): listed for every folder and run in
 * the focused pane's, so it carries no path of its own.
 */
export interface GlobalPin {
  label?: string;
  command: string;
}

/** pins.json (docs/design/data.md sections 3.7 and 7), in display order. */
export type GlobalPinsFile = GlobalPin[];

export function parseGlobalPins(raw: unknown): GlobalPinsFile {
  if (!Array.isArray(raw)) return [];
  const out: GlobalPinsFile = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { label, command } = item as Record<string, unknown>;
    const cmd = typeof command === 'string' ? command.trim() : '';
    if (!cmd) continue;
    const text = typeof label === 'string' ? label.trim() : '';
    const pin: GlobalPin = { ...(text ? { label: text } : {}), command: cmd };
    if (!out.some((p) => sameGlobalPin(p, pin))) out.push(pin);
  }
  return out;
}

/** Same command, ignoring the label; commands compare exactly, since case can matter to a shell. */
export function sameGlobalPin(a: GlobalPin, b: GlobalPin): boolean {
  return a.command === b.command;
}

export function globalPinName(pin: GlobalPin): string {
  return pin.label ?? pin.command;
}

function makePin(label: string, command: string): GlobalPin | null {
  const cmd = command.trim();
  if (!cmd) return null;
  const text = label.trim();
  return { ...(text ? { label: text } : {}), command: cmd };
}

/** Adds a pin at the end; a blank or already pinned command returns `file` itself. */
export function addGlobalPin(file: GlobalPinsFile, label: string, command: string): GlobalPinsFile {
  const pin = makePin(label, command);
  if (!pin || file.some((p) => sameGlobalPin(p, pin))) return file;
  return [...file, pin];
}

export function removeGlobalPin(file: GlobalPinsFile, index: number): GlobalPinsFile {
  if (index < 0 || index >= file.length) return file;
  return file.filter((_, i) => i !== index);
}

/** Replaces the label and command in place; a blank command, or one another pin holds, changes nothing. */
export function editGlobalPin(file: GlobalPinsFile, index: number, label: string, command: string): GlobalPinsFile {
  const pin = makePin(label, command);
  if (!pin || index < 0 || index >= file.length) return file;
  if (file.some((p, i) => i !== index && sameGlobalPin(p, pin))) return file;
  return file.map((p, i) => (i === index ? pin : p));
}

export function moveGlobalPin(file: GlobalPinsFile, from: number, to: number): GlobalPinsFile {
  return moveItem(file, from, to);
}

/** The top bar's global pins menu order: by name, ignoring case, with each pin's index in the file. */
export function alphabetizedGlobalPins(file: GlobalPinsFile): { pin: GlobalPin; index: number }[] {
  return file
    .map((pin, index) => ({ pin, index }))
    .sort((a, b) => globalPinName(a.pin).localeCompare(globalPinName(b.pin), undefined, { sensitivity: 'base' }));
}
