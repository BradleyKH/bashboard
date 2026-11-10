import type { Action } from './keymap';

/**
 * Whether a key action belongs to a text pane's own fields rather than the workspace.
 * In panes other than terminals (docs/design/keys.md section 4.5), these actions act on the pane's
 * text; every other action still reaches `dispatchAction`.
 */
export function textFieldOwns(action: Action): boolean {
  switch (action.type) {
    case 'copy':
    case 'paste':
    case 'sendInput':
    case 'find':
    case 'goToLine':
      return true;
    default:
      return false;
  }
}
