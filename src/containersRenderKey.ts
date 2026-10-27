import type { Container, EngineState } from './containers';
import type { ContainerGroup } from './containerGroups';

export interface RenderKeyInput {
  engines: readonly EngineState[];
  groups: readonly ContainerGroup[];
  expandedGroups: ReadonlySet<string>;
  /** Group keys and container keys with an action in flight. */
  busy: ReadonlySet<string>;
  /** The container key whose logs are open, if any. */
  logsKey: string | null;
  /** The usage text a row shows for a container key, or '' when it shows none. */
  usageText: (key: string) => string;
}

export function containerKey(c: Pick<Container, 'engine' | 'id'>): string {
  return `${c.engine}:${c.id}`;
}

/**
 * Everything the list renders except the text that changes in place (a container's status
 * text and its usage numbers). Two renders with the same key differ only in that text, so
 * the pane updates it without replacing elements; a press held across a stats tick then
 * still lands on the element it started on.
 */
export function renderKey(input: RenderKeyInput): string {
  const { expandedGroups, busy } = input;
  return JSON.stringify([
    input.engines.map((e) => [e.engine, e.running]),
    input.logsKey,
    input.groups.map((g) => {
      const expanded = expandedGroups.has(g.key);
      return [
        g.key,
        g.name,
        g.state,
        expanded,
        busy.has(g.key),
        // Rows are drawn only while expanded, so a collapsed group's members need not rebuild
        // anything beyond the header count, which the container states already cover.
        g.containers.map((c) => {
          const key = containerKey(c);
          return [
            c.id,
            c.name,
            c.service,
            c.image,
            c.state,
            c.ports.map((p) => [p.host, p.container, p.protocol]),
            busy.has(key),
            expanded && input.usageText(key) !== '',
          ];
        }),
      ];
    }),
  ]);
}
