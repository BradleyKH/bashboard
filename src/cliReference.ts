import reference from '../src-tauri/cli-commands.json';

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
