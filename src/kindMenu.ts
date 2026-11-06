import './kindMenu.css';
import { openContextMenu } from './contextMenu';
import { item, type MenuItem } from './contextMenuModel';
import { PANE_KINDS, type PaneKind } from './paneKinds';

let kindFilter: (kind: PaneKind) => boolean = () => true;

/** Decides which kinds the menu offers; the current pane's kind is always listed. */
export function setKindMenuFilter(filter: (kind: PaneKind) => boolean): void {
  kindFilter = filter;
}

/** One item per offered kind, the current one checked; choosing the current kind does nothing. */
export function kindMenuItems(
  current: PaneKind,
  onChoose: (kind: PaneKind) => void,
  filter: (kind: PaneKind) => boolean = kindFilter,
): MenuItem[] {
  return PANE_KINDS.filter((info) => info.kind === current || filter(info.kind)).map((info) =>
    item(
      info.label,
      () => {
        if (info.kind !== current) onChoose(info.kind);
      },
      { icon: info.icon, checked: info.kind === current },
    ),
  );
}

/** Popup for changing a pane's kind (docs/design/workspace.md section 4.11). */
export const kindMenu = {
  open(anchor: HTMLElement, current: PaneKind, onChoose: (kind: PaneKind) => void): void {
    openContextMenu(kindMenuItems(current, onChoose), { anchorEl: anchor, align: 'left' });
  },
};
