import { Channel, invoke } from '@tauri-apps/api/core';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ITheme } from '@xterm/xterm';
import { terminalAccent } from './accent';
import { contentTextColor, terminalWhites } from './contentText';
import { openLink } from './links';
import { type Osc133, parseOsc133, parseOsc7, parseOsc9 } from './osc';
import { webglBudget } from './rendererBudget';
import { replayText } from './scrollbackModel';
import { noteShellFallback } from './shellFallback';
import type { CellSize } from './layout';
import type { PaneView } from './paneView';
import { platformOs } from './platform';
import { parseProgramStatus, PROGRAM_STATUS_QUERY_REPLY, type ProgramStatusReport } from './programStatus';
import type { PtyRef } from './savedWorkspace';
import type { Settings } from './settings';
import type { OscShellState, ProgramStatusState } from './terminalStatus';

// FitAddon reserves this width for the scrollbar (ViewportConstants.DEFAULT_SCROLL_BAR_WIDTH).
const FIT_SCROLLBAR_PX = 14;

// The addon only reports result counts when decorations are set.
function findOptions(accent: string): ISearchOptions {
  const t = terminalAccent(accent);
  return {
    caseSensitive: false,
    regex: false,
    decorations: {
      matchBackground: t.matchBackground,
      activeMatchBackground: t.activeMatchBackground,
      matchOverviewRuler: t.matchBackground,
      activeMatchColorOverviewRuler: t.activeMatchBackground,
    },
  };
}

export interface FindResults {
  resultIndex: number;
  resultCount: number;
}

type PrivateTerminal = {
  _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } };
};

export type PaneKeyHandler = (e: KeyboardEvent, term: Terminal, send: (data: string) => void) => boolean;

/** A command boundary reported by OSC 133 `C` (start) and `D` (end). */
export type CommandEvent = { kind: 'start' } | { kind: 'end'; durationMs: number; exitCode: number | null };

export interface TerminalPaneOptions {
  host: HTMLElement;
  paneId: string;
  settings: Settings;
  cwd?: string;
  /** Shell profile id; omitted lets the core use `shell.defaultProfile`. */
  profile?: string;
  /** Program and arguments to run in place of a shell profile (a container shell). */
  command?: string[];
  keyHandler: PaneKeyHandler;
  onFocus: () => void;
  /** Opens a loopback URL in a Local Browser pane beside this one. */
  onOpenLocal?: (url: string) => void;
  onExit: (code: number) => void;
  /** Fires when OSC 9;9 or OSC 7 reports a directory different from the last one. */
  onCwdChange?: () => void;
  /**
   * Fires when the pane's status inputs change: OSC 133 reports a command starting or finishing
   * (`oscState().running` flipped), or an OSC 7501 report or clear changes `programState()`.
   */
  onShellChange?: () => void;
  /** Fires on an OSC 7501 change outside a reattach replay, before `onShellChange`. */
  onProgramChange?: (prev: ProgramStatusState | null, next: ProgramStatusState | null) => void;
  /** Fires on OSC 133 `C` and `D`, before `onShellChange`. A `D` with no preceding `C` fires nothing. */
  onCommand?: (ev: CommandEvent) => void;
  /** Fires once: on the first OSC 133 A or the first output chunk, whichever comes first. */
  onReady?: () => void;
  /** Fires on the BEL character (xterm's onBell). */
  onBell?: () => void;
  /** False builds the pane detached and without a WebGL slot; defaults to true. */
  expanded?: boolean;
  /** Names this terminal's saved scrollback file. */
  scrollbackId: string;
  /** Saved scrollback, written above the shell's first output when it resolves non-blank. */
  replay?: Promise<string>;
  /** A running pty to reattach to instead of spawning; a gone pty falls back to a spawn. */
  attach?: PtyRef;
  /** Fires once the pane holds a pty, spawned or reattached. */
  onSpawned?: () => void;
}

export function toFontFamily(family: string): string {
  const names = family
    .split(',')
    .map((n) => n.trim().replace(/^["']|["']$/g, ''))
    .filter((n) => n !== '')
    .map((n) => (/\s/.test(n) ? `"${n}"` : n));
  return [...names, 'monospace'].join(', ');
}

/** One terminal view bound to one pty on the Rust side. */
export class TerminalPane implements PaneView {
  readonly kind = 'terminal' as const;
  readonly paneId: string;
  readonly scrollbackId: string;
  /** Assigned by the Rust side on spawn; null before spawn and after the shell exits. */
  private id: number | null = null;
  /** The pty's start time from the core, which with `id` lets a later page reattach to it. */
  private startedAt: number | null = null;
  private readonly attachTo: PtyRef | undefined;
  private readonly onSpawnedCb: (() => void) | undefined;
  /**
   * True while a reattach replays old output. xterm.js answers queries it parses (cursor
   * position, device attributes), and answers to old queries must not reach the shell as input;
   * nor should old bells and command markers raise attention.
   */
  private muted = false;
  /** Set by every write xterm.js parses, so the periodic scrollback save skips idle terminals. */
  private outputUnsaved = false;
  private readonly host: HTMLElement;
  /** xterm's container; the workspace may put a title strip in the host ahead of it. */
  private readonly body: HTMLElement;
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly search = new SearchAddon();
  private readonly serializer = new SerializeAddon();
  private readonly replay: Promise<string> | undefined;
  private lastQuery = '';
  private accent: string;
  /** The resolved #rrggbb, not the setting's mode. */
  private textColor: string;
  private readonly onExitCb: (code: number) => void;
  private readonly spawnCwd: string | undefined;
  private readonly spawnCommand: string[] | undefined;
  private resolvedProfile: string | undefined;
  private readonly onCwdChangeCb: (() => void) | undefined;
  private readonly onShellChangeCb: (() => void) | undefined;
  private readonly onCommandCb: ((ev: CommandEvent) => void) | undefined;
  private readonly onProgramChangeCb: TerminalPaneOptions['onProgramChange'];
  /** The root record of the program's OSC 7501 reports (docs/design/sessions.md section 4.24). */
  private program: ProgramStatusState | null = null;
  private commandStartedAt: number | null = null;
  private onReadyCb: (() => void) | undefined;
  private osc: OscShellState = { seen: false, running: false, changedAt: Date.now() };
  private currentCwd: string | null;
  private expanded: boolean;
  private pending: string[] = [];
  private spawned = false;
  private resizeObserver: ResizeObserver | null = null;
  private webgl: WebglAddon | null = null;
  private holdsWebglSlot = false;
  private disposed = false;

  constructor(opts: TerminalPaneOptions) {
    this.host = opts.host;
    this.paneId = opts.paneId;
    this.scrollbackId = opts.scrollbackId;
    this.onExitCb = opts.onExit;
    this.spawnCwd = opts.cwd;
    this.spawnCommand = opts.command;
    this.resolvedProfile = opts.profile;
    this.onCwdChangeCb = opts.onCwdChange;
    this.onShellChangeCb = opts.onShellChange;
    this.onCommandCb = opts.onCommand;
    this.onProgramChangeCb = opts.onProgramChange;
    this.onReadyCb = opts.onReady;
    this.replay = opts.replay;
    this.attachTo = opts.attach;
    this.onSpawnedCb = opts.onSpawned;
    this.currentCwd = opts.cwd ?? null;
    this.expanded = opts.expanded ?? true;
    this.accent = opts.settings.accentColor;
    this.textColor = contentTextColor(opts.settings.contentTextColor, opts.settings.accentColor);

    // The body is a flex child so a strip inserted before it takes its height from the host.
    this.host.style.display = 'flex';
    this.host.style.flexDirection = 'column';
    this.body = document.createElement('div');
    this.body.className = 'pane-body';
    this.body.style.cssText = 'position: relative; z-index: 1; flex: 1 1 auto; min-width: 0; min-height: 0;';
    this.host.appendChild(this.body);

    this.term = new Terminal({
      allowProposedApi: true,
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'outline',
      // Option+B, Option+F, and Option+Backspace reach readline and Claude Code as Meta, as a Mac
      // terminal user expects; otherwise xterm.js types the Option character (∫, ƒ).
      macOptionIsMeta: platformOs() === 'macos',
      fontFamily: toFontFamily(opts.settings.font.family),
      fontSize: opts.settings.font.size,
      scrollback: opts.settings.scrollback,
      // Focus sits in the find bar while it steps through matches, so the active match is drawn
      // with the inactive selection color.
      theme: this.theme(),
      linkHandler: { activate: (e, text) => openLink(e, text, { onOpenLocal: opts.onOpenLocal }), allowNonHttpProtocols: false },
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(this.serializer);
    this.term.loadAddon(new WebLinksAddon((e, uri) => openLink(e, uri, { onOpenLocal: opts.onOpenLocal })));
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.attachCustomKeyEventHandler((e) => opts.keyHandler(e, this.term, (data) => this.write(data)));
    this.term.onData((data) => this.write(data));
    this.term.onWriteParsed(() => {
      this.outputUnsaved = true;
    });
    this.term.onBell(() => {
      if (!this.muted) opts.onBell?.();
    });
    this.term.onResize(({ cols, rows }) => {
      if (this.id !== null) void invoke('pty_resize', { id: this.id, cols, rows });
    });
    // Returning false for non 9;9 payloads lets other OSC 9 handlers (e.g. progress) see them.
    this.term.parser.registerOscHandler(9, (data) => {
      const path = parseOsc9(data);
      if (path === null) return false;
      this.setCwd(path);
      return true;
    });
    this.term.parser.registerOscHandler(7, (data) => {
      const path = parseOsc7(data);
      if (path !== null) this.setCwd(path);
      return true;
    });

    this.term.parser.registerOscHandler(133, (data) => {
      const marker = parseOsc133(data);
      if (marker === null) return false;
      this.onOsc133(marker);
      return true;
    });

    this.term.parser.registerOscHandler(7501, (data) => {
      const msg = parseProgramStatus(data);
      if (msg === null) return true;
      if (msg.type === 'query') {
        // A replayed probe answers no one; write() also drops it, this keeps the rule visible.
        if (!this.muted) this.write(PROGRAM_STATUS_QUERY_REPLY);
      } else {
        this.setProgram(msg.type === 'clear' ? null : msg.report);
      }
      return true;
    });

    this.term.open(this.body);
    this.term.textarea?.addEventListener('focus', () => opts.onFocus());
    if (this.expanded) this.loadRenderer();
  }

  get ptyId(): number | null {
    return this.id;
  }

  /** The running pty, for the saved workspace; null before it starts and after it exits. */
  get pty(): PtyRef | null {
    return this.id !== null && this.startedAt !== null ? { id: this.id, startedAt: this.startedAt } : null;
  }

  /** The command this pane runs instead of a shell profile, when it is not a shell. */
  get command(): readonly string[] | undefined {
    return this.spawnCommand;
  }

  get cwd(): string | null {
    return this.currentCwd;
  }

  get folder(): string | null {
    return this.currentCwd;
  }

  /** Pastes without Enter; xterm adds bracketed-paste markers when the running program asked for them. */
  pasteText(text: string): void {
    this.term.paste(text);
  }

  /** The requested profile id until the spawn resolves it; undefined means the default, not yet known. */
  get profile(): string | undefined {
    return this.resolvedProfile;
  }

  /** The program's last OSC 7501 report, or null when none or cleared. */
  programState(): ProgramStatusState | null {
    return this.program ? { ...this.program } : null;
  }

  /** OSC 133 state: `seen` once any marker arrived, `running` between C and D. */
  oscState(): OscShellState {
    return { ...this.osc };
  }

  async start(): Promise<void> {
    this.fitIfReady();
    if (this.attachTo && (await this.attach(this.attachTo))) return;
    if (this.disposed) return;
    if (this.replay) {
      // Written before the spawn so the shell's first output lands under it.
      const saved = await this.replay.catch(() => '');
      if (this.disposed) return;
      const text = replayText(saved);
      if (text) this.term.write(text);
    }
    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (bytes) => {
      if (this.disposed) return;
      this.term.write(new Uint8Array(bytes));
      this.fireReady();
    };
    const onExit = this.exitChannel();

    const cols = this.term.cols;
    const rows = this.term.rows;
    const { id, startedAt, profile, fallbackFrom } = await invoke<{
      id: number;
      startedAt: number;
      profile: string;
      fallbackFrom: string | null;
    }>('pty_spawn', {
      cols,
      rows,
      cwd: this.spawnCwd,
      profile: this.resolvedProfile,
      command: this.spawnCommand,
      onData,
      onExit,
    });
    if (this.disposed) {
      invoke('pty_kill', { id }).catch(() => {});
      return;
    }
    this.id = id;
    this.startedAt = startedAt;
    this.resolvedProfile = profile;
    if (fallbackFrom) noteShellFallback(fallbackFrom, profile);
    this.spawned = true;
    // ConPTY's ESC[6n reply can arrive before pty_spawn resolves; it must still reach the pty.
    for (const data of this.pending) this.write(data);
    this.pending = [];
    if (this.term.cols !== cols || this.term.rows !== rows) {
      void invoke('pty_resize', { id, cols: this.term.cols, rows: this.term.rows });
    }
    this.observeResize();
    this.onSpawnedCb?.();
  }

  /**
   * Reattaches to a pty that outlived the page that spawned it (docs/design/terminal.md section
   * 3.1); false when the core no longer runs it, so the caller spawns instead. The core's first
   * message is always the replay of its recent output; nothing runs the ready callback, since the
   * shell is not starting and a resume command typed into a live agent would reach the agent.
   */
  private async attach(target: PtyRef): Promise<boolean> {
    let first = true;
    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (bytes) => {
      if (this.disposed) return;
      if (!first) {
        this.term.write(new Uint8Array(bytes));
        return;
      }
      first = false;
      this.muted = true;
      this.term.write(new Uint8Array(bytes), () => {
        this.muted = false;
      });
    };
    try {
      await invoke('pty_attach', { id: target.id, startedAt: target.startedAt, onData, onExit: this.exitChannel() });
    } catch {
      return false;
    }
    if (this.disposed) {
      invoke('pty_kill', { id: target.id }).catch(() => {});
      return true;
    }
    this.id = target.id;
    this.startedAt = target.startedAt;
    this.onReadyCb = undefined;
    this.spawned = true;
    for (const data of this.pending) this.write(data);
    this.pending = [];
    // ConPTY redraws its screen on a resize, which repairs whatever the replay could not: a
    // full-screen program whose mode switch fell outside the replay, or a cut-off sequence. A
    // resize to the size it already has is ignored, so step one column away and back.
    const { cols, rows } = this.term;
    await invoke('pty_resize', { id: target.id, cols: Math.max(2, cols - 1), rows }).catch(() => {});
    await invoke('pty_resize', { id: target.id, cols, rows }).catch(() => {});
    this.observeResize();
    this.onSpawnedCb?.();
    return true;
  }

  private exitChannel(): Channel<number> {
    const onExit = new Channel<number>();
    onExit.onmessage = (code) => {
      this.id = null;
      this.startedAt = null;
      if (this.disposed) return;
      this.term.write(`\r\n[process exited with code ${code}]\r\n`);
      this.onExitCb(code);
    };
    return onExit;
  }

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(() => this.fitIfReady());
    this.resizeObserver.observe(this.body);
  }

  focus(): void {
    this.term.focus();
  }

  /** Moves to the next or previous match; returns whether any match exists. */
  find(query: string, direction: 'next' | 'previous'): boolean {
    if (this.disposed) return false;
    // A changed query re-searches from the current match, so typing extends it in place.
    const incremental = direction === 'next' && query !== this.lastQuery;
    this.lastQuery = query;
    return direction === 'next'
      ? this.search.findNext(query, { ...findOptions(this.accent), incremental })
      : this.search.findPrevious(query, findOptions(this.accent));
  }

  /** Clears match highlights and the selection the search made. */
  clearFind(): void {
    if (this.disposed) return;
    this.lastQuery = '';
    this.search.clearDecorations();
    this.term.clearSelection();
  }

  /** Fires with the match count and the active match index (-1 when none), as the search addon reports them. Dispose to unsubscribe. */
  onFindResults(cb: (r: FindResults) => void): { dispose(): void } {
    return this.search.onDidChangeResults((r) => cb({ resultIndex: r.resultIndex, resultCount: r.resultCount }));
  }

  applySettings(settings: Settings): void {
    this.term.options.fontFamily = toFontFamily(settings.font.family);
    this.term.options.fontSize = settings.font.size;
    this.term.options.scrollback = settings.scrollback;
    const textColor = contentTextColor(settings.contentTextColor, settings.accentColor);
    if (settings.accentColor !== this.accent || textColor !== this.textColor) {
      this.accent = settings.accentColor;
      this.textColor = textColor;
      this.term.options.theme = this.theme();
    }
    this.fitIfReady();
  }

  private theme(): ITheme {
    return {
      ...terminalWhites(this.textColor),
      background: '#00000000',
      selectionInactiveBackground: terminalAccent(this.accent).selectionInactiveBackground,
    };
  }

  /** Collapsing drops WebGL and stops fitting; expanding reloads WebGL if the budget allows and refits. */
  setExpanded(expanded: boolean): void {
    if (this.disposed || expanded === this.expanded) return;
    this.expanded = expanded;
    if (!expanded) {
      this.dropWebgl();
      return;
    }
    if (this.webgl === null) this.loadRenderer();
    // The host is re-attached by the caller after this returns.
    requestAnimationFrame(() => this.fitIfReady());
  }

  /** Types text into the pty as if from the keyboard. */
  typeText(text: string): void {
    this.write(text);
  }

  /** Cell size in CSS px plus the host chrome the fit addon will not lay columns or rows into. */
  cellSize(): CellSize {
    // xterm exposes measured cell dimensions only through its private render service, the
    // same source FitAddon uses.
    const cell = (this.term as unknown as PrivateTerminal)._core?._renderService?.dimensions?.css?.cell;
    const scrollbar = this.term.options.scrollback === 0 ? 0 : FIT_SCROLLBAR_PX;
    // Everything in the host outside the body: borders plus any in-flow title strip.
    const borderX = this.host.offsetWidth - this.body.clientWidth;
    const borderY = this.host.offsetHeight - this.body.clientHeight;
    return {
      width: cell?.width || (this.body.clientWidth - scrollbar) / this.term.cols,
      height: cell?.height || this.body.clientHeight / this.term.rows,
      // +1 covers the fit addon truncating the host size to whole px.
      padX: scrollbar + borderX + 1,
      padY: borderY + 1,
    };
  }

  /**
   * The normal buffer as escape sequences, for restoring on the next launch. Modes are left out
   * so a replay cannot switch on mouse reporting or bracketed paste for the new shell, and the
   * alternate buffer is left out since the full-screen program that drew it will not be running.
   */
  serialize(): string {
    if (this.disposed) return '';
    return this.serializer.serialize({ excludeModes: true, excludeAltBuffer: true });
  }

  /** True when output arrived since the last call. */
  takeUnsavedOutput(): boolean {
    const unsaved = this.outputUnsaved;
    this.outputUnsaved = false;
    return unsaved && !this.disposed;
  }

  /** The terminal's selected text, or '' when nothing is selected. */
  selection(): string {
    return this.disposed ? '' : this.term.getSelection();
  }

  /** Writes a status line into the terminal, e.g. a spawn failure. */
  notice(text: string): void {
    if (!this.disposed) this.term.write(`\r\n${text}\r\n`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.id !== null) {
      invoke('pty_kill', { id: this.id }).catch(() => {});
      this.id = null;
    }
    this.pending = [];
    this.onReadyCb = undefined;
    this.term.dispose();
    this.webgl = null;
    this.releaseWebglSlot();
  }

  /** Design 4.4: WebGL while the shared budget allows, DOM renderer otherwise or on context loss. */
  private loadRenderer(): void {
    if (!webglBudget.tryAcquire()) return;
    this.holdsWebglSlot = true;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => this.dropWebgl());
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch {
      this.releaseWebglSlot();
    }
  }

  private dropWebgl(): void {
    this.webgl?.dispose();
    this.webgl = null;
    this.releaseWebglSlot();
  }

  private releaseWebglSlot(): void {
    if (!this.holdsWebglSlot) return;
    this.holdsWebglSlot = false;
    webglBudget.release();
  }

  /** A detached or zero-sized body must never be fit: it would shrink the pty to the minimum. */
  private fitIfReady(): void {
    if (this.disposed || !this.expanded || !this.body.isConnected) return;
    if (this.body.clientWidth === 0 || this.body.clientHeight === 0) return;
    this.fit.fit();
  }

  private onOsc133(marker: Osc133): void {
    const kind = marker.kind;
    const wasRunning = this.osc.running;
    const running = kind === 'C' ? true : kind === 'D' ? false : wasRunning;
    this.osc = {
      seen: true,
      running,
      changedAt: running !== wasRunning ? Date.now() : this.osc.changedAt,
    };
    if (kind === 'A') {
      this.fireReady();
      // The prompt is back, so whatever program reported status has exited.
      this.setProgram(null);
    }
    if (kind === 'C') {
      this.commandStartedAt = Date.now();
      if (!this.muted) this.onCommandCb?.({ kind: 'start' });
    } else if (kind === 'D' && this.commandStartedAt !== null) {
      const durationMs = Date.now() - this.commandStartedAt;
      this.commandStartedAt = null;
      if (!this.muted) this.onCommandCb?.({ kind: 'end', durationMs, exitCode: marker.exitCode ?? null });
    }
    if (running !== wasRunning) this.onShellChangeCb?.();
  }

  private setProgram(report: ProgramStatusReport | null): void {
    const prev = this.program;
    if (report === null && prev === null) return;
    const now = Date.now();
    const sameState = prev !== null && report !== null && prev.report.state === report.state;
    this.program = report === null ? null : { report, changedAt: sameState ? prev.changedAt : now, reportedAt: now };
    // Replayed reports restore the state but must not leave done marks for old work.
    if (!sameState && !this.muted) this.onProgramChangeCb?.(prev, this.program);
    // Every report refreshes: a repeated one can still tip precedence over quiet hooks.
    this.onShellChangeCb?.();
  }

  private fireReady(): void {
    const cb = this.onReadyCb;
    if (!cb) return;
    this.onReadyCb = undefined;
    cb();
  }

  private setCwd(path: string): void {
    if (path === this.currentCwd) return;
    this.currentCwd = path;
    this.onCwdChangeCb?.();
  }

  private write(data: string): void {
    if (this.disposed || this.muted) return;
    if (this.id === null) {
      if (!this.spawned) this.pending.push(data);
      return;
    }
    void invoke('pty_write', { id: this.id, data });
  }
}
