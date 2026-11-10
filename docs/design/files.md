# Files, search, editors, and scratch pads

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

## 3.8 Repo files (`src-tauri/src/files.rs`)

A path's repo is the nearest folder at or above it holding `.git` (a directory, or the file a
worktree has); a folder in no repo is its own repo, without git. A linked worktree is its
own repo root here, so each worktree of one repository has its own `repo_root`; the Git pane's
Branches tab lists them together through the worktree commands in 3.9.

| Command | Purpose |
| --- | --- |
| `repo_root(path) -> { root, isGit, branch? }` | The repo a folder belongs to |
| `fs_list(dir) -> Entry[]` | Folders, then files, each with name, size, and modified time |
| `fs_read_text(path) -> { text, modified, lossy }` | Up to 2 MiB; a file with a NUL byte in its first 8 KiB is refused as binary. Invalid UTF-8 decodes with U+FFFD in place of the bad bytes and sets `lossy` |
| `fs_read_bytes(path) -> bytes` | A file's raw bytes, up to 32 MiB (`tooLarge:` past that), sent as binary IPC rather than JSON; the image preview's source |
| `fs_write_text(path, text, expectedModified)` | Writes through a temp file and a rename; refused when the file's modified time differs from `expectedModified`, so a save never overwrites a change made on disk since the read, and refused when the file on disk is not valid UTF-8 |
| `fs_move(path, toDir)` | Moves a file into another folder; refused when the target name exists |
| `fs_rename(path, newName) -> path` | Renames a file or folder within its folder; refused (`invalid:`) for a name Windows forbids and (`exists:`) when another entry has the name, though a change of case alone goes through |
| `fs_watch(dir, onChange) -> id`, `fs_unwatch(id)` | One folder, not recursive, debounced 200 ms |

Paths must be absolute and are normalized before use, so `..` segments cannot step outside the
folder they name. `fs_write_text`, `fs_move`, and `fs_rename` work on any existing entry, and nothing creates or
deletes files except the scratch commands above.

## 3.11 Code search (`src-tauri/src/search.rs`)

`search_start(root, query, options, onBatch) -> id` searches a repo on a background thread and
streams results over a `Channel`; `search_cancel(id)` stops it, and a new search from the same
pane cancels the previous one.

- The walk uses `ignore`, so `.gitignore`, `.ignore`, and global git excludes apply, and hidden
  files and `.git` are skipped. Files over 2 MiB and binary files are skipped.
- The query is literal unless `regex` is set; `caseSensitive`, `wholeWord`, and an `include`
  glob narrow it (section 7).
- Paths whose file name contains the query arrive first, as one batch. Line matches follow,
  batched per file with line numbers and match offsets.
- A search stops at 5,000 matches and reports that it was truncated.

## 3.12 Editors (`src-tauri/src/editors.rs`)

`editors() -> { id, name }[]` lists the editors found on `PATH` or in their usual install folders;
`name` is the display name from the table below. The front end labels a saved
`editor.preferred` that is not in the list by its raw id.
`open_in_editor(path, line?)` opens a file or folder in `editor.preferred` (section 8):

| Id | Editor | Arguments |
| --- | --- | --- |
| `zed` | Zed | `zed <path>:<line>` |
| `vscode` | VS Code | `code -g <path>:<line>` |
| `cursor` | Cursor | `cursor -g <path>:<line>` |
| `visualStudio` | Visual Studio | `devenv /edit <path>` (no line) |
| `notepadpp` | Notepad++ | `notepad++ -n<line> <path>` |
| `sublime` | Sublime Text | `subl <path>:<line>` |
| `rider` | Rider | `rider64 --line <line> <path>` |
| `intellij` | IntelliJ IDEA | `idea64 --line <line> <path>` |
| `webstorm` | WebStorm | `webstorm64 --line <line> <path>` |
| `pycharm` | PyCharm | `pycharm64 --line <line> <path>` |
| `rustrover` | RustRover | `rustrover64 --line <line> <path>` |
| `goland` | GoLand | `goland64 --line <line> <path>` |
| `clion` | CLion | `clion64 --line <line> <path>` |
| `phpstorm` | PhpStorm | `phpstorm64 --line <line> <path>` |
| `windsurf` | Windsurf | `windsurf -g <path>:<line>` |
| `vscodeInsiders` | VS Code Insiders | `code-insiders -g <path>:<line>` |
| `vscodium` | VSCodium | `codium -g <path>:<line>` |
| `default` | The file's default app | Opened through the shell (no line) |

With no line, each editor above except Visual Studio and the default app takes the path alone.

Windsurf, VS Code Insiders, and VSCodium, like VS Code, put only a `.cmd` shim on `PATH`
(`windsurf.cmd`, `code-insiders.cmd`, `codium.cmd`), which is traded for the exe one folder up.
Their install folders are `%LOCALAPPDATA%\Programs\Windsurf`; `%LOCALAPPDATA%\Programs\Microsoft
VS Code Insiders` then `%ProgramFiles%\Microsoft VS Code Insiders`; and
`%LOCALAPPDATA%\Programs\VSCodium` then `%ProgramFiles%\VSCodium`.

The JetBrains launchers hand the file to a running instance of the same IDE and exit, and a
folder opens as a project. Each IDE is found in three steps, first match wins: its launcher exe
(`rider64.exe`, `idea64.exe`, and so on) on `PATH`; a Toolbox App script on `PATH` (`rider.cmd`,
`idea.cmd`, and so on), read for the exe path it names and never run, since running it would go
through `cmd.exe` (section 9); then `*\bin\<exe>` under `%LOCALAPPDATA%\Programs` and
`%ProgramFiles%\JetBrains`, taking the highest `version` in the install's `product-info.json`
(compared segment by segment as numbers, an install without a version ranking last). Installs
are matched by exe name, never by folder name, and the free and paid editions of IntelliJ IDEA
and PyCharm share exe names, so either counts.

Terminal editors are not in the table. Emacs is reachable through `editor.command`
(`emacsclientw -n +{line} {path}`).

A non-empty `editor.command` replaces the table: it is split into arguments, with `{path}` and
`{line}` filled in (an absent line fills `1`). When the preferred editor is not found, the file
opens in its default app and a toast says so.

The default app is never used for a file whose default action runs it: an extension in `PATHEXT`
or one Windows hands to a script host, installer, or shortcut (`.lnk`, `.url`, `.hta`, `.ps1`,
`.msi`, `.reg`, and the like; `RUNNABLE` in `editors.rs`). Those open in Notepad instead, so
double-clicking a file from a cloned repo never executes it.

`open_with_default_app(path)` opens a file in its default app directly, for the binary notice
(4.12), and refuses the same runnable files with an error; `can_open_with_default_app(path)`
answers whether it would open one, so the notice can leave its button out.

## 4.12 Files and pins

A Files pane shows one folder: on the left, a list with folders first and then files, under a
breadcrumb that leads up to the repo root; on the right, a preview of the selected file. The
divider between them drags. With no file selected (nothing, or a folder), the preview and
divider hide and the list fills the pane. The list follows the folder on disk (`fs_watch`, 3.8).

**Sort.** A button in the breadcrumb, left of the list's zoom buttons, shows the order (such as
"Modified ↓") and opens a menu of Name, Type, and Modified, the current one checked
(`sortEntries`, `nextSort`). Picking the current key reverses it; picking another starts it A to
Z for Name and Type and newest first for Modified. Type compares extensions, ignoring case (a
dotfile such as `.gitignore` has none). Ties go by name, A to Z. Folders stay above the files and
sort by name, A to Z, under every key except Name descending, which reverses them too. A new pane
starts at Modified, newest first; each pane saves its own sort (4.11).

**Title strip buttons.** After the folder's name, the title strip (4.4) carries Open in File
Explorer, Search in this folder (described below), and Open terminal here, all for the current
folder.

The preview depends on the file:

- **Markdown** (`.md`) renders through `markdown-it` with raw HTML off, then `DOMPurify`. Links
  to `http` and `https` open in the browser; a relative link to another file opens it in the
  same pane. Images are not loaded. An Edit toggle switches to the text editor below.
- **CSV and TSV** (`.csv`, `.tsv`) show as a table (`csvModel.ts`, `csvView.ts`): the first
  row is a sticky header, short rows are padded, and quoted fields may hold the delimiter,
  newlines, and doubled quotes. Past 5000 rows the table stops with a note giving the total. An
  Edit toggle switches to the text editor with line numbers, as for markdown.
- **Images** (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.ico`, `.avif`, `.svg`) up to
  32 MiB show fitted to the preview over a checkerboard, with their pixel size and file size
  on the toolbar (`imageView.ts`). Clicking the image, or the toolbar's Actual size and Fit
  button, toggles between fitted and actual size. The bytes come through `fs_read_bytes` into
  a `blob:` URL, since the CSP allows no file path as an image source; an SVG runs
  no script as an `<img>`. A change on disk reloads the image. A file that does not decode
  shows the binary notice.
- **Plain text** (`.txt`, or no extension) opens in the text editor, with long lines wrapped. A
  name with a language in 4.22, such as `Dockerfile` or `.bashrc`, opens as code instead.
- **Other text files** (code, JSON, YAML, HTML, and so on) open in the text editor with a
  line-number gutter; lines do not wrap and scroll sideways instead. Code with a language is
  colored (4.22).
- **Binary files, and other files over 2 MiB,** show their name, size, an Open with default app
  button, and an Open in editor button. Open with default app is left out for a file that would
  run as a program when opened (3.12).

**Find** (`previewFind.ts`): every text preview has a Find button on its toolbar, beside Edit
for markdown and CSV; an image has none. Ctrl+Shift+F anywhere in the Files pane does the same. It opens a bar in the
toolbar that works like the terminal's (4.4): case-insensitive, literal, as you type, Enter for
the next match and Shift+Enter for the previous, "n of m" or "No results". Matches are painted
with the CSS Custom Highlight API, so the rendered markdown's DOM is never rewritten; past 5000
matches it stops and the count reads "5000+ matches". The text editor paints its matches as
decorations in its own document, since it draws only the lines in view (4.22). The search
follows the text as it changes: an edit, a reload, or the Edit toggle re-runs it. Esc closes the
bar and selects the current match (in the editor, as the caret's selection).

**Go to line** (`goToLine.ts`, `goToLineModel.ts`): Ctrl+G in a Files pane showing code, or in
a Search pane's preview, opens a Line field in the toolbar beside Find, its placeholder giving
the file's line count. It takes `42` or the compiler's `42:7` (or `42,7`); the editor follows the
typed line as it changes, banding it and placing the caret as a search match does (4.14), with a
column putting the caret there. Enter or Esc closes the field and focuses the editor; so does
leaving it. Plain text, markdown's rendered view, and CSV have no line numbers, so there Ctrl+G
does nothing.

**Zoom.** The preview toolbar ends in − and + buttons that step the preview's text size through
browser-style levels from 50% to 300%; the breadcrumb has the same pair for the list, between
the sort button and the pin button. Ctrl+wheel over the list or the preview steps that
one's level too: a mouse notch is one step, and a touchpad pinch adds up its small deltas so it
steps a level at a time rather than jumping to either end. Each scales from its base size, which
follows `font.size` (section 5) and holds while browsing the pane. Every step is
saved to `textZoom.filePreview` or `textZoom.filesList` in workspace.json (section 7), the level
a new Files pane starts at; other open panes keep their own. The Git diff (4.13), the Search
preview (4.14), scratch pads (4.15), and the Containers logs panel (4.16) zoom the same way,
each under its own `textZoom` key.

**Expand.** The Expand preview button after the − and + buttons fills the pane with the
preview on every preview but the binary notice (markdown, CSV, images, plain text, and code);
a binary or too-large file has no button. Its icon is a side panel with a left-pointing arrow, kept
distinct from the title strip's zoom icon (4.2) since both show at once, and the two combine
into a full-window reader. Expanded, the list, breadcrumb, and divider hide, and the toolbar
shows the file's name, since the breadcrumb that located it is hidden. The button then reads
Show file list and its icon points right. Find, zoom, Edit, editing and saving, and relative
markdown links work as before, and a followed link keeps the pane expanded.

Either the button or Esc anywhere in the preview brings the list back, at the divider position
it had, with the previewed file selected and the list focused, so Up and Down browse on from
there. An open find bar takes the first Esc, so with the bar open it takes two presses.
Showing a folder in the pane (a pin, `bb open` on a folder, 3.13) also brings the list back;
selecting a file the same way (a pinned file, `bb open` on a file, a markdown link) keeps the
preview expanded. A file that shows the binary notice shows the list.

**Text editor.** A monospaced CodeMirror 6 editor (4.22), which colors code by language. It saves one second after typing stops, on blur, and
on Ctrl+S, through `fs_write_text` with the modified time it last read. When the file changes on
disk and there are no unsaved edits, it reloads in place, so a to-do list Claude edits updates
in front of you. With unsaved edits, a bar offers Reload (discarding them) or Keep mine
(overwriting the file). A file that is not valid UTF-8 (a `lossy` read) opens read-only under a
note saying why, since saving the decoded text would replace its invalid bytes; a reload
re-checks, so the editor unlocks once the file on disk is valid UTF-8.

**Rows.** Clicking a row selects it; double-clicking a folder opens it, and double-clicking a
file opens it in the editor (3.12). Selection follows File Explorer (`fileSelection.ts`):
Ctrl+click toggles a row, Shift+click selects from the anchor (the last plain or Ctrl click) to
the row, Ctrl+Shift+click adds that range, Shift+Up and Shift+Down extend it, and Ctrl+A selects
every visible row. The preview follows the cursor, the row last clicked or moved to, which an
outline marks when it is not selected. A refresh or a filter drops selected rows that are gone.

Each row's menu, from its menu button or a right-click (through the keyboard, the cursor's row),
has the items below. A right-click or menu button on a row outside the selection selects just
that row first; on a row inside a selection of several, the menu acts on all of them and offers
only Copy paths (one per line), Insert paths, and Move <n> files to (its files).

- Open terminal here (folders only): a new terminal of the default profile in that folder, as a
  split of the Files pane.
- Search in this folder (folders only): as the title strip button below.
- Open in editor.
- Open in Local Browser (a single selected `.html` or `.htm` file, Windows only): a Local Browser
  pane (4.21) on the file's `file:///` URL, beside the Files pane. A path off a local drive (a
  network share) shows a toast instead.
- Copy path.
- Insert path: pastes the path, relative to the Files pane's root and quoted for the shell of
  the tab's most recently focused terminal (`pathInsertText`, 4.4), as a bracketed paste without
  Enter, then focuses that terminal.
- Move to (files only, and only when there are targets): the repo's pinned folders and the
  current folder's subfolders (`fs_move`), as a submenu.
- Rename: as F2, below.
- Pin.

The title strip's Search in this folder button shows the Search pane's kind icon (⌕). It opens a new Search pane (4.14) as a split of the Files pane, on the
folder's own repo root (`repo_root`, since a Files pane opened outside any repo can browse into
one), with Files to include set to the folder as an anchored glob (`/src/ui/**`, glob characters
escaped and a comma standing in as `?`; `folderInclude`), or empty at the repo root, and focuses
its query field. A right-click on the breadcrumb, or on the list outside any row (or the
Menu key with no row selected), opens a menu for the current folder: Open terminal here, Open in
File Explorer, Search in this folder, Copy path, and Pin, which reads Unpin while the folder is pinned and toggles it as the pin button
does.

A right-click in the preview outside the text editor offers Copy (with text selected), Find
(disabled when the preview has no find bar), Open in editor, and Copy path, for the previewed
file; with no file previewed there is no menu. The text editor has the text field menu (4.4).

Rows, files and folders alike, drag their paths onto a terminal or scratch pad (4.4). Dragging
a selected row drags the whole selection; dragging another row drags just it, selecting it.

**Moving by drag.** A drag of files only (no folders) also targets folders: a folder row in any
Files pane, a breadcrumb segment, or elsewhere in a Files pane's list for the folder it shows. The
target highlights, and the ghost reads `Move to <folder>: <name> +N`. The folder the files are in
is not a target, nor is anything while a pane's preview is expanded. The drop moves the files
through the pane they came from (`fs_move` per file, after saving the preview's pending text);
each failure, such as a name already taken, is toasted and the rest still move.

**Keyboard and filter.** While the list has focus:

- Up and Down move the selection, previewing as a click does; Enter acts as a double click.
- F2 renames the cursor's entry, selecting just it: its name becomes a field with a file's name
  selected up to its extension. The field marks a name Windows forbids or another entry has (a
  change of case alone is allowed). Enter renames through `fs_rename`, after saving the preview's
  pending text, and the renamed entry stays selected and previewed; a failure is toasted. Escape
  or leaving the field cancels, so a stray click never renames on disk. The list holds its
  refreshes while the field is open.
- Typing a printable character filters the list to names containing the typed text, ignoring
  case, and shows the filter above the list with a clear button. Backspace edits it, and Esc
  clears it. Moving to another folder clears it too.
- Backspace with no filter goes up one folder, stopping at the repo root.

**History.** Back and forward buttons beside the breadcrumb step through the folders this pane
has shown, as a browser does; the mouse's back and forward buttons do the same over the pane.
History is not saved.

**Pins** are files and folders kept per repo in `repos.json` (section 7). A pin inside the repo
is stored relative to its root; one outside it, such as a meeting notes folder, is stored as an
absolute path. The breadcrumb's pin button pins the current folder. In the Pins section
(4.6), clicking a pinned folder shows it in the active tab's Files pane for that repo, or opens
one; clicking a pinned file does the same with its folder and selects it. A pin whose path no
longer exists is shown dimmed and opens nothing. A pin can also hold a shell command, its path
then being the folder the command runs in (command pins, 4.6).

## 4.14 Search pane

A query field with toggles for Match case, Whole word, and Regex, and a Files to include field
taking a glob. The search runs 250 ms after typing stops (3.11). Opening the pane while the
focused terminal has a selection starts with that text as the query.

Results list matching file names first, then matches grouped by file, each group collapsible,
with line numbers and the match highlighted. A footer gives the count, or says the results stop
at the first 5,000. Up and Down move through matches.

**Preview.** Selecting a result previews its file beside the list in the Files pane's preview
(`FilePreview`, 4.12) in source mode: every text file opens in the text editor with line numbers,
since results point at source lines. A markdown file adds a Raw / Preview button group after the
zoom buttons (`markdownModeToggle.ts`), Preview on by default. Code and markdown files also show the
Plain | Syntax button group (4.22), before the zoom buttons and so before Raw / Preview; plain
text and CSV, which open as uncolored source, show none. Preview renders the file as the
Files pane does, without its Edit toggle, followed by a muted "View raw to edit"; a match row in a
markdown file stays in Preview, showing the file from the top, and switching to Raw then scrolls
to and marks its line. A relative link there shows its
target in this preview, even when it is not a result, and the list keeps its row. Raw is the text
editor below. The choice lasts for the pane, so the next markdown file opens the same way. A match scrolls its line to the middle
and marks it with a band, with the caret at its start; the list keeps focus, so Up and Down go on
stepping. Stepping between matches in one file moves the band without re-reading the file; a new
search makes the next selection read it again. The editor saves as it does in the Files pane, and
Find, the preview menu, and the − and + zoom buttons work as there, the zoom saving to
`textZoom.searchPreview`. The Search pane has no folder watch, so a file changed on disk while
previewed is caught by the editor's save conflict check rather than a reload. Esc in the preview,
when no find bar takes it, focuses the results list.

When focus leaves the preview after a save there, the search runs again (debounced, so the click
that moved focus lands first), since the edit may have moved or removed matches. If the selected
row is gone from that run's results, the selection clears but the preview stays.

**Row buttons.** A hovered or selected row, and a hovered file group header, shows two buttons:
Show in Files (the Files pane's kind icon) and Open in editor (↗). Show in Files shows the file's
folder with the file selected in the tab's Files pane for the repo, or opens one (`showFiles`,
4.12). Open in editor, Enter, and a double click open the file in the editor at that line (3.12);
on a group header or file name row, with no line. Match rows, file group headers, and file name
rows drag the file's path, with no line number, onto a terminal or scratch pad (4.4).

A right-click on a match row offers Open in editor and Show in Files, then Copy path and Insert
path after a separator. A file group header has the same menu with Collapse or Expand after
another separator; a file name row has it without the collapse item. Copy path and Insert path
use the file's path with no line number.

## 4.15 Scratch pads

A scratch pad is an untitled text area, like a new tab in Notepad++, in the terminal font. Its
title is its first non-empty line, shortened, or "Scratch". It saves to `scratch/<id>.txt` (3.7)
half a second after typing stops and comes back on restore.

- **Send** (Ctrl+Enter) pastes the whole text into the tab's most recently focused terminal as a
  bracketed paste without Enter, so a prompt can be drafted here and reviewed before sending,
  then focuses that terminal. It is disabled while the tab has no terminal.
- **Copy** copies the whole text. **Clear** empties it.
- **Save as** writes it to a file chosen in the native save dialog, opened from the core, then
  turns the pad into a Files pane (4.12) on that file's folder with the file selected and its
  preview filling the pane, so further edits save to the file through the text editor. The pad's
  own `scratch/<id>.txt` is deleted, leaving the file as the only copy. Text typed while the
  dialog was open is not in the file, so the pad then stays a pad.
- **− and +** at the toolbar's right end, and Ctrl+wheel over the pad, zoom its text as the Files
  pane's buttons do (4.12), saving to `textZoom.scratch`. Layout checks measure the pad at its
  unzoomed size, so zooming does not change which splits fit.

The text area's right-click menu is the text field menu (4.4) with Send (disabled while the tab
has no terminal), Copy all, Clear, and Save as after a separator, each as its button does.

A scratch pad is a drop target for dragged paths (4.4): they are inserted at its caret.

Closing a pad that is not empty asks first, and closing it deletes its file. Closing a tab with
pads that are not empty lists them in the tab's confirm dialog (4.10).

## 4.22 Code colors (`src/code/`)

Text previews color code by language, as a code editor does. The colors are on by default, and
a Plain | Syntax button group on each surface that shows code turns them off for that pane.
Plain looks exactly like an uncolored preview: every character in the content text color
(`--content-fg`, section 8).

**Engine.** The text editor (4.12) is a CodeMirror 6 `EditorView` in both modes, so there is one
editor whatever the toggle says. Plain leaves the language and highlighting extensions out of the
editor's language `Compartment` and Syntax puts them back, which keeps the caret, scroll
position, selection, and undo history. Read-only code (rendered markdown fences, Git diffs) runs
the same Lezer parsers and the same role highlighter through `highlightTree` from
`@lezer/highlight`: `tokenize` returns one list of colored spans per line and `renderLine` builds
a line from them (`highlightStatic.ts`), so one language table and one color scheme serve every
surface. CodeMirror builds the document from text nodes, never HTML,
and runs nothing from the file. Its injected styles need `style-src 'unsafe-inline'`, which the
CSP already allows.

**Surfaces.**

| Surface | Colors | Toggle |
| --- | --- | --- |
| Files preview, code files (4.12) | The file's language | On the preview toolbar, before the zoom buttons |
| Search preview (4.14) | The file's language; Raw markdown as markdown | Same place, for code and markdown; none for plain text and CSV |
| Markdown Edit and CSV Edit (4.12) | Markdown; CSV stays plain | Same place for markdown, which keeps it while editing; none for CSV |
| Rendered markdown (4.12, 4.14) | Fenced blocks, by the fence's info string | Same place |
| Git diff (4.13) | Each file's language | In the diff bar, before the zoom buttons |

Plain text (`.txt`, no extension) opens in the same editor with lines wrapped and has no toggle.
A file whose language is not in the table shows uncolored with the toggle disabled, its tooltip
reading "No colors for this file type". Scratch pads (4.15) keep their own textarea and have no
colors.

Each pane keeps its own mode in its saved state (`codeColors` on the files, search, and git
entries, section 7), and the latest choice made in any pane is saved to `codeColors` in
workspace.json, the mode a new pane starts in. A saved pane without the field starts in Syntax.

**Languages** (`languages.ts`) map file names to CodeMirror language support, each loaded by a
dynamic `import()` the first time a file needs it, so the start-up bundle carries none of them. A
file shows uncolored until its language loads, then colors in place. Adding a language is one
row.

| Language | Package | Matches |
| --- | --- | --- |
| HTML (with embedded CSS and JS) | `@codemirror/lang-html` | `.html`, `.htm` |
| CSS, SCSS, Less | `@codemirror/lang-css`, `lang-sass`, `lang-less` | `.css`, `.scss`, `.sass`, `.less` |
| JavaScript, TypeScript, JSX, TSX | `@codemirror/lang-javascript` | `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, `.tsx` |
| JSON | `@codemirror/lang-json` | `.json`, `.jsonc`, `.json5` |
| C# | `@codemirror/legacy-modes` (`clike`) | `.cs`, `.csx` |
| Python | `@codemirror/lang-python` | `.py`, `.pyi` |
| Markdown (fences colored by language) | `@codemirror/lang-markdown` | `.md`, `.markdown` |
| YAML | `@codemirror/lang-yaml` | `.yml`, `.yaml` |
| Rust | `@codemirror/lang-rust` | `.rs` |
| SQL | `@codemirror/lang-sql` | `.sql` |
| XML | `@codemirror/lang-xml` | `.xml`, `.csproj`, `.props`, `.targets`, `.xaml`, `.svg` |
| Shell | `@codemirror/legacy-modes` (`shell`) | `.sh`, `.bash`, `.bashrc`, `.bash_profile`, `.profile` |
| PowerShell | `@codemirror/legacy-modes` (`powershell`) | `.ps1`, `.psm1`, `.psd1` |
| TOML | `@codemirror/legacy-modes` (`toml`) | `.toml` |
| Dockerfile | `@codemirror/legacy-modes` (`dockerfile`) | `Dockerfile`, `*.dockerfile` |

A fence's info string, its first word, matches a language's name, a common alias, or one of its
extensions, ignoring case (`ts`, `tsx`, `cs`, `csharp`, `c#`, `py`, `sh`, `bash`, `ps1`, `pwsh`,
`yml`, `rs`, and so on). An unknown or missing info string stays uncolored.

The legacy modes (C#, Shell, PowerShell, TOML, Dockerfile) tokenize line by line rather than
parse, so they color keywords, strings, comments, numbers, and types but do not tell function
names from other identifiers.

**Roles.** A `tagHighlighter` maps Lezer's highlight tags to eleven role classes, and a scheme is
one color per role, set as `--syn-<role>` custom properties on `:root`. Switching schemes rewrites
the properties and never touches an editor or re-parses anything.

| Role | Tags |
| --- | --- |
| `keyword` | keywords, control keywords, modifiers, `this` and `self` |
| `string` | strings, template text, characters |
| `escape` | escapes in strings, regular expressions |
| `constant` | numbers, booleans, `null`, atoms |
| `comment` | line and block comments, doc comments |
| `function` | function and method names, at definition and call |
| `type` | type, class, interface, and namespace names |
| `property` | property and field names |
| `tag` | HTML, XML, and JSX tag names |
| `attribute` | attribute names |
| `meta` | decorators, C# attributes (`[Obsolete]`), preprocessor lines, front matter |

Everything else (identifiers, operators, punctuation) takes `--content-fg`, so plain text in a
colored file matches the rest of the app and follows the Text color setting (section 8). Schemes
supply foreground colors only, never a background, since the backdrop shows through every pane.

**Schemes** (`schemes.ts`), one per accent preset, are each the token colors of the editor theme
they are named for (its dark variant), lifted where needed so every role keeps a WCAG contrast of
at least 4.5:1 against `#1e1e1e`, a pane over the default scrim. A test pins the contrast; the
comment color is the one usually lifted.

| Scheme | Pairs with | Character |
| --- | --- | --- |
| Nord | Silver | Cool blue-gray keywords, frost-teal functions, muted green strings |
| Ayu | Orange | Orange keywords, gold functions, lime strings, sky-blue types |
| Gruvbox | Gold | Warm retro: red keywords, yellow types, olive strings, orange constants |
| Monokai | Green | Pink keywords, green functions, yellow strings, purple constants |
| Tokyo Night | Teal | Purple keywords, blue functions, cyan types, green strings |
| One Dark | Blue | Violet keywords, blue functions, green strings, gold types |
| Catppuccin Mocha | Violet | Pastel: mauve keywords, blue functions, green strings, peach constants |
| Dracula | Pink | Pink keywords, green functions, yellow strings, purple constants |

**Match accent**, the default, picks the scheme paired with the current accent, so changing the
accent changes the code colors with it. A custom accent (a hand-edited `accentColor`) pairs by
nearest hue among the presets, and one with HSV saturation under 0.2 pairs as Silver does
(`pairedScheme`). The schemes' palettes are MIT-licensed, and the About tab (4.18) credits each.

**Settings.** `codeColors.scheme` (section 8) is `matchAccent` or a scheme's id, set under
Appearance in the Settings tab, after Text color. Below the dropdown a preview shows a short TSX
snippet that exercises every role, in the terminal font, colored with the chosen scheme. With
Match accent, the dropdown names the scheme it resolves to, as "Match accent (Tokyo Night)". The
preview redraws when the scheme, accent, Text color, or font changes, without waiting for a
save. It is a `preview: 'codeColors'` option on the select field (`settingsModel.ts`), rendered
by `codeColorsPreview.ts`.

**Editor behavior.** The editor keeps everything 4.12 describes: save timing and the
change-on-disk bar, CRLF files kept CRLF on save, read-only for a `lossy` read, the line-number
gutter and sideways scrolling for code, wrapped lines for plain text, `revealLine`'s band, zoom,
and the text field menu (4.4). Its keymap is CodeMirror's `standardKeymap` (caret motion,
selection, Backspace, Delete) plus only Ctrl+Z (undo) and Ctrl+Y (redo) from `historyKeymap`, with
none of `defaultKeymap`'s extras. Ctrl+Shift+Z stays the app's pane zoom, and Ctrl+U and Alt+U are
unbound. Enter and Shift+Enter insert a bare newline with no auto-indent, as a textarea does.

Tab indents in every text editor (code, plain text, and markdown and CSV in Edit mode). With a
selection it adds one indent unit to each selected line (`indentMore`); without one it pads each
caret to the next indent stop, a tab or the spaces to the next multiple of the unit. Shift+Tab
removes one unit from each selected line (`indentLess`). In a read-only editor both fall through
to the browser and move focus. The unit is CodeMirror's `indentUnit`, set per file by
`detectIndentUnit` (`indentModel.ts`) when the editor opens and again on each reload from disk:
a tab when more lines start with a tab than with spaces, else the most common step of 2 to 8
spaces between the indents of successive lines (steps of 1, a block comment's ` * `, and
dedents are not counted). A file with no indented lines gets a tab for Makefiles and `.go` and
`.mk` files, else two spaces. Keyboard focus leaves the editor through CodeMirror's tab focus
mode: Esc and then Tab within two seconds moves focus as a plain Tab would.

The editor's keydown handler runs at the highest precedence, ahead of CodeMirror's keymap, and
makes the same lookup the panes' key handlers make (4.5): Ctrl+S saves, and any other action
that is not a `textFieldOwns` one (copy, paste, send input, find) goes to the app, so chords such
as Ctrl+Shift+Left are never shadowed. The Files and Search panes' own key handlers skip keys
that start inside the preview, leaving them to the editor's lookup.
`isTextField` (`textFieldTarget.ts`, shared by the text field menu and the context menu in
`contextMenu.ts`) treats anything inside the editor's `.cm-content` as a text field, so
`textFieldOwns` actions reach it as they reach a textarea and a right-click there opens the text
field menu. That menu works through a `TextFieldAdapter`, which edits a textarea or input as the
browser does and the editor through its view, its Undo going through CodeMirror's history.

**Find.** CodeMirror draws only the lines in view, so the editor's find cannot paint DOM ranges
as rendered markdown's does. The editor implements the find surface over its document text
instead: matches come from a search of the text and are painted as CodeMirror mark decorations
in the same colors as the Custom Highlight ranges, the current match scrolls into view through
`EditorView.scrollIntoView`, and Esc leaves it selected. The bar, the 5000-match cap, and the
"n of m" count are shared with every other preview (`previewFind.ts`).

**Rendered markdown.** `markdown-it` renders fences plainly and tags each `<code>` with its
language. After `DOMPurify`, `colorFences` (`fenceColors.ts`) tokenizes every tagged block and
then rewrites each as one span per line joined by newline text nodes, built from text nodes and
run once the languages have loaded, so a block's `textContent` is unchanged and copy keeps its
text. A pass that lands after the body re-rendered, after the toggle went to Plain, or while the
Edit toggle shows the editor writes nothing. An open find bar re-runs after the pass, since the
spans split the text nodes its ranges pointed into.

**Git diff.** Each file's hunks are colored from two reconstructed texts: the new side (context
and added lines) and the old side (context and removed lines). Each is parsed whole and its
tokens mapped back to the rows, so a string or comment that spans lines inside a hunk colors
correctly. A hunk that begins inside a construct opened above it (a block comment, a multi-line
string) can color wrongly until the construct ends, since the hunk never shows enough of the
file to know. A diff of several files, such as a commit's, splits at its `diff --git` headers and
colors each file by its own path, taken from its `+++` line, else its `---` line for a deletion,
else `rename to`, since the `diff --git` header is ambiguous when a path contains spaces; a diff
with no headers takes the path of the file the pane selected. A merge file (`diff --cc`) stays
uncolored.

The diff's rows render plain first, and coloring then runs file by file, yielding between files
and every few hundred rows, so a large diff appears at once and fills in. A row's `+`, `-`, or
space prefix, any text no token covers, and its added or removed tint stay as they are; only
tokens take role colors. Header lines, hunk lines (`@@`), and `\ No newline` markers stay
uncolored. The toggle is disabled while no file in the diff has a language, and changing it
repaints the diff where it was scrolled.
