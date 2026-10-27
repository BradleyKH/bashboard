import { Channel, invoke } from '@tauri-apps/api/core';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { openLink } from './links';
import { parseOsc133, parseOsc7, parseOsc9 } from './osc';
import { webglBudget } from './rendererBudget';
import { noteShellFallback } from './shellFallback';
import type { CellSize } from './layout';
import type { PaneView } from './paneView';
import type { Settings } from './settings';
import type { OscShellState } from './terminalStatus';

// FitAddon reserves this width for the scrollbar (ViewportConstants.DEFAULT_SCROLL_BAR_WIDTH).
const FIT_SCROLLBAR_PX = 14;

// The addon only reports result counts when decorations are set; backgrounds must be opaque.
const FIND_OPTIONS: ISearchOptions = {
  caseSensitive: false,
  regex: false,
  decorations: {
    matchBackground: '#2a5a66',
    activeMatchBackground: '#4fb3c8',
    matchOverviewRuler: '#2a5a66',
    activeMatchColorOverviewRuler: '#4fb3c8',
  },
};

export interface FindResults {
  resultIndex: number;
  resultCount: number;
}

type PrivateTerminal = {
  _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } };
};

export type PaneKeyHandler = (e: KeyboardEvent, term: Terminal, send: (data: string) => void) => boolean;

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
  onExit: (code: number) => void;
  /** Fires when OSC 9;9 or OSC 7 reports a directory different from the last one. */
  onCwdChange?: () => void;
  /** Fires when OSC 133 reports a command starting or finishing (`oscState().running` flipped). */
  onShellChange?: () => void;
  /** Fires once: on the first OSC 133 A or the first output chunk, whichever comes first. */
  onReady?: () => void;
  /** Fires on the BEL character (xterm's onBell). */
  onBell?: () => void;
  /** False builds the pane detached and without a WebGL slot; defaults to true. */
  expanded?: boolean;
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
  /** Assigned by the Rust side on spawn; null before spawn and after the shell exits. */
  private id: number | null = null;
  private readonly host: HTMLElement;
  /** xterm's container; the workspace may put a title strip in the host ahead of it. */
  private readonly body: HTMLElement;
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly search = new SearchAddon();
  private lastQuery = '';
  private readonly onExitCb: (code: number) => void;
  private readonly spawnCwd: string | undefined;
  private readonly spawnCommand: string[] | undefined;
  private resolvedProfile: string | undefined;
  private readonly onCwdChangeCb: (() => void) | undefined;
  private readonly onShellChangeCb: (() => void) | undefined;
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
    this.onExitCb = opts.onExit;
    this.spawnCwd = opts.cwd;
    this.spawnCommand = opts.command;
    this.resolvedProfile = opts.profile;
    this.onCwdChangeCb = opts.onCwdChange;
    this.onShellChangeCb = opts.onShellChange;
    this.onReadyCb = opts.onReady;
    this.currentCwd = opts.cwd ?? null;
    this.expanded = opts.expanded ?? true;

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
      fontFamily: toFontFamily(opts.settings.font.family),
      fontSize: opts.settings.font.size,
      scrollback: opts.settings.scrollback,
      // Focus sits in the find bar while it steps through matches, so the active match is drawn
      // with the inactive selection color.
      theme: { background: '#00000000', selectionInactiveBackground: '#4fb3c880' },
      linkHandler: { activate: (e, text) => openLink(e, text), allowNonHttpProtocols: false },
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon((e, uri) => openLink(e, uri)));
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.attachCustomKeyEventHandler((e) => opts.keyHandler(e, this.term, (data) => this.write(data)));
    this.term.onData((data) => this.write(data));
    this.term.onBell(() => opts.onBell?.());
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
      this.onOsc133(marker.kind);
      return true;
    });

    this.term.open(this.body);
    this.term.textarea?.addEventListener('focus', () => opts.onFocus());
    if (this.expanded) this.loadRenderer();
  }

  get ptyId(): number | null {
    return this.id;
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

  /** OSC 133 state: `seen` once any marker arrived, `running` between C and D. */
  oscState(): OscShellState {
    return { ...this.osc };
  }

  async start(): Promise<void> {
    this.fitIfReady();
    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (bytes) => {
      if (this.disposed) return;
      this.term.write(new Uint8Array(bytes));
      this.fireReady();
    };
    const onExit = new Channel<number>();
    onExit.onmessage = (code) => {
      this.id = null;
      if (this.disposed) return;
      this.term.write(`\r\n[process exited with code ${code}]\r\n`);
      this.onExitCb(code);
    };

    const cols = this.term.cols;
    const rows = this.term.rows;
    const { id, profile, fallbackFrom } = await invoke<{
      id: number;
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
    this.resolvedProfile = profile;
    if (fallbackFrom) noteShellFallback(fallbackFrom, profile);
    this.spawned = true;
    // ConPTY's ESC[6n reply can arrive before pty_spawn resolves; it must still reach the pty.
    for (const data of this.pending) this.write(data);
    this.pending = [];
    if (this.term.cols !== cols || this.term.rows !== rows) {
      void invoke('pty_resize', { id, cols: this.term.cols, rows: this.term.rows });
    }

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
      ? this.search.findNext(query, { ...FIND_OPTIONS, incremental })
      : this.search.findPrevious(query, FIND_OPTIONS);
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
    this.fitIfReady();
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

  private onOsc133(kind: 'A' | 'B' | 'C' | 'D'): void {
    const wasRunning = this.osc.running;
    const running = kind === 'C' ? true : kind === 'D' ? false : wasRunning;
    this.osc = {
      seen: true,
      running,
      changedAt: running !== wasRunning ? Date.now() : this.osc.changedAt,
    };
    if (kind === 'A') this.fireReady();
    if (running !== wasRunning) this.onShellChangeCb?.();
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
    if (this.disposed) return;
    if (this.id === null) {
      if (!this.spawned) this.pending.push(data);
      return;
    }
    void invoke('pty_write', { id: this.id, data });
  }
}
