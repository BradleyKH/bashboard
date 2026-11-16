import reference from '../src-tauri/cli-commands.json';
import { platformOs, supports, type Os } from './platform';

/** One `bb` command or option; `bb help` prints `usage` and `summary` from the same file. */
export interface CliEntry {
  name: string;
  usage: string;
  summary: string;
  details: string;
  examples: string[];
}

export const CLI_INTRO: string = reference.intro;
export const CLI_COMMANDS: CliEntry[] = reference.commands;
export const CLI_OPTIONS: CliEntry[] = reference.options;

/**
 * An entry as the running OS shows it. Without the Local Browser, `bb browse` hands the address
 * to the system browser (the summary matches the one `bb help` prints), and the start page and
 * its bare example do not exist.
 */
export function entryFor(e: CliEntry, os: Os = platformOs()): CliEntry {
  if (e.name !== 'browse' || supports('localBrowser', os)) return e;
  return {
    ...e,
    summary: 'Open a localhost address in the system browser',
    details: e.details.replace('Without a URL it opens the start page.', 'A localhost address is required.'),
    examples: e.examples.filter((x) => x !== 'bb browse'),
  };
}
