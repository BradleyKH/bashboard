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
- **Plain text** (`.txt`, or no extension) opens in the text editor, with long lines wrapped.
- **Other text files** (code, JSON, YAML, HTML, and so on) open in the text editor with a
  line-number gutter; lines do not wrap and scroll sideways instead.
- **Binary files, and other files over 2 MiB,** show their name, size, an Open with default app
  button, and an Open in editor button. Open with default app is left out for a file that would
  run as a program when opened (3.12).

**Find** (`previewFind.ts`): every text preview has a Find button on its toolbar, beside Edit
for markdown and CSV; an image has none. Ctrl+Shift+F anywhere in the Files pane does the same. It opens a bar in the
toolbar that works like the terminal's (4.4): case-insensitive, literal, as you type, Enter for
the next match and Shift+Enter for the previous, "n of m" or "No results". Matches are painted
with the CSS Custom Highlight API, so the rendered markdown's DOM is never rewritten; past 5000
matches it stops and the count reads "5000+ matches". In the text editor, a hidden copy of the
text laid out under the transparent textarea carries the highlights. The search follows the
text as it changes: an edit, a reload, or the Edit toggle re-runs it. Esc closes the bar and
selects the current match (in the editor, as the caret's selection).

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

**Text editor.** A monospaced text area. It saves one second after typing stops, on blur, and
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
longer exists is shown dimmed and opens nothing.

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
zoom buttons (`markdownModeToggle.ts`), Preview on by default. Preview renders the file as the
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
