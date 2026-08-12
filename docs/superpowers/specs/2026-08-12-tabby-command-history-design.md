# Tabby Command History Plugin Design

## 1. Product Goal

Build a desktop Tabby plugin that learns commands entered in terminal tabs, stores them in the operating system's per-user data directory, isolates history by Tabby connection, and predicts matching commands while the user edits a command line. A user can browse and adopt a prediction, but adoption never executes the command.

The behavior is inspired by the history prediction features of PowerShell PSReadLine, adapted to Tabby's terminal and plugin APIs rather than tied to PowerShell.

## 2. Supported Scope

The first complete release supports Tabby desktop on Windows, macOS, and Linux and attaches to every `BaseTerminalTabComponent` that exposes a writable terminal session and an xterm-compatible frontend.

It includes:

- Generic command-buffer reconstruction without modifying the local or remote shell.
- Per-connection persistence and in-memory matching.
- Three configurable prediction presentations.
- Configurable matching, ranking, key bindings, capacity, and sensitive-command filtering.
- A settings action that clears only the active connection's history after confirmation.
- An extension interface for future PowerShell, Bash, and Zsh command-boundary hooks.

It does not include:

- Cross-connection recommendations or a global history pool.
- A history browser, bulk editor, cross-connection cleanup, import, or export UI.
- Shell hook implementations in the first release.
- Tabby Web, because browser plugins cannot satisfy the required native per-user filesystem persistence.
- Guaranteed capture after the shell performs an edit that Tabby cannot observe, such as shell-native completion that rewrites the line.
- Exact detection of shell continuation prompts in generic mode. Without an enhanced shell hook, an Enter-delimited continuation can be learned as separate submitted lines rather than one executed command.

## 3. Design Principles

1. Terminal input is fail-open. Plugin failure must never prevent a byte from reaching the terminal unless that byte is a currently active, documented history-navigation binding.
2. Connection isolation is enforced at the repository boundary, not only by filtering UI results.
3. No disk access occurs on the per-keystroke query path.
4. A command is not persisted unless capture is confident, visible-echo safety passes, and the sensitive-command policy accepts it.
5. Prediction adoption edits the current line and never appends Enter or another command terminator.
6. Core capture, matching, ranking, and persistence remain independent of Angular and xterm rendering details.

## 4. Architecture

### 4.1 Tabby module

The plugin exports a single Angular `NgModule` and registers:

- `CommandHistoryConfigProvider` through Tabby's `ConfigProvider` extension point.
- `CommandHistorySettingsTabProvider` through `SettingsTabProvider`.
- `CommandHistoryTerminalDecorator` through `TerminalDecorator`.
- Singleton services for identity resolution, repository access, matching, filtering, and runtime coordination.

The plugin targets Tabby desktop 1.0.234 or newer within the 1.x API line and uses the public APIs exported by `tabby-core`, `tabby-terminal`, and `tabby-settings` wherever possible.

### 4.2 Per-terminal runtime

`CommandHistoryTerminalDecorator` attaches one `CommandHistoryController` to each eligible terminal. The controller owns:

- A `CommandInputMiddleware` inserted into the session middleware stack.
- A `CommandBuffer` state machine containing text, cursor position, capture confidence, paste state, and dismissal state.
- A `PredictionOverlay` mounted within the terminal component.
- Subscriptions to session changes, alternate-screen changes, frontend destruction, and configuration changes.

On detach or session replacement, the controller removes its middleware, DOM, and subscriptions. It never leaves handlers attached to a destroyed terminal.

### 4.3 Runtime data flow

1. Terminal input reaches `CommandInputMiddleware`.
2. Recognized editing input updates `CommandBuffer` and is forwarded unchanged to the session.
3. A confident, non-empty buffer triggers an in-memory query for the current connection key.
4. `HistoryMatcher` partitions prefix and substring matches, ranks each partition, and returns a bounded result list.
5. `PredictionOverlay` renders the configured A, B, or C presentation at the current xterm cursor position.
6. Active navigation bindings update selection without forwarding their bytes. All other input is forwarded.
7. Adoption sends the minimal edit sequence needed to make the shell line equal the selected command and updates `CommandBuffer` to the same value. It sends no Enter.
8. On Enter, the controller finalizes a pending command, clears prediction state, and asynchronously asks the repository to persist it only after all safety gates pass.

### 4.4 Extension seam for shell hooks

`CommandCaptureAdapter` defines lifecycle and final-command callbacks for future enhanced capture:

```ts
export interface CommandCaptureAdapter {
    supports (context: ConnectionContext): boolean
    attach (terminal: BaseTerminalTabComponent<any>): Promise<CommandCaptureHandle>
}

export interface CommandCaptureHandle {
    finalCommand$: Observable<string>
    detach (): Promise<void>
}
```

The generic input reconstructor remains the default. A future connection-level setting can select an installed adapter, but the first release does not install or inject shell scripts.

## 5. Connection Identity and Isolation

### 5.1 Saved profiles

A saved or built-in profile uses this canonical identity input:

```text
profile:<profile.type>\0<profile.id>
```

The profile name is metadata only. Renaming a saved profile does not move or merge its history.

### 5.2 Temporary connections

When a Quick Connect or other transient profile has no stable ID, `ConnectionIdentityResolver` creates a canonical endpoint identity from non-secret connection options:

- SSH: normalized user, lowercase host, and effective port.
- Serial: normalized port plus baud rate, data bits, stop bits, and parity.
- Local: normalized executable path, arguments, and declared shell type.
- Other terminal providers: profile type, stable name, and a recursively key-sorted option object after removing secret and volatile fields.

The generic sanitizer removes keys matching password, passphrase, token, secret, API key, private key material, environment values, current working directory, window size, process ID, PTY restore ID, and other session-only state. If no safe stable identity can be produced, the terminal receives a random tab-lifetime key and memory-only history.

### 5.3 Filesystem key

The canonical identity is hashed with SHA-256. Only the lowercase hexadecimal digest becomes the history filename. Queries, appends, compaction, capacity enforcement, and clearing all require an explicit connection key, so a caller cannot accidentally query every file.

## 6. Persistence

### 6.1 User data roots

The default root is platform-specific and may be overridden only by an advanced plugin setting that resolves to an absolute path under the current user's home directory:

- Windows: `%APPDATA%\tabby\cmd-history`
- macOS: `~/Library/Application Support/tabby/cmd-history`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/tabby/cmd-history`

Connection files live under `connections/<sha256>.jsonl`. The repository and Tabby installation directories are never used for history.

### 6.2 JSONL records

The append format is versioned:

```json
{"v":1,"kind":"use","command":"git status","at":"2026-08-12T12:00:00.000Z"}
```

Compacted files contain one record per retained unique command:

```json
{"v":1,"kind":"entry","command":"git status","lastUsedAt":"2026-08-12T12:00:00.000Z","useCount":7}
```

Loading replays both record kinds into the same aggregate. An invalid or truncated line is skipped and logged; valid surrounding records remain available.

### 6.3 Writes and compaction

Each connection has an asynchronous serial append queue shared by all tabs in the plugin process. Terminal input never waits for this queue.

Compaction runs when either:

- The event count exceeds twice the configured unique-command capacity; or
- The file exceeds 2 MiB and at least 512 use events have accumulated since its last compacted entry set.

Compaction writes retained `entry` records to a sibling temporary file, flushes and closes it, and atomically replaces the original. A failed compaction preserves the original file. A startup pass removes only stale temporary files belonging to the same connection and never deletes a valid history file.

When persistence is unavailable, the repository warns once and keeps the current process's per-connection in-memory history. It never falls back to a shared store.

### 6.4 Capacity and deduplication

The default capacity is 4096 unique commands per connection. Before identity comparison, commands receive these normalizations:

- CRLF and CR become LF.
- Leading and trailing whitespace is removed.
- Internal whitespace, quoting, escaping, and case are preserved.

Executing the same normalized command updates `lastUsedAt`, increments `useCount`, and keeps the most recently observed original text. When capacity is exceeded, entries with the oldest `lastUsedAt` are removed first.

## 7. Capture State Machine

### 7.1 Recognized edits

The generic state machine supports printable Unicode text, bracketed paste, Backspace, Delete, Left, Right, Home, End, and common `Ctrl+A`, `Ctrl+E`, `Ctrl+U`, `Ctrl+K`, and `Ctrl+W` edits. Cursor indexes use Unicode grapheme boundaries so an edit does not split a visible character.

Bracketed paste payload is treated as one edit operation. A pasted multiline block remains one history command when the user later submits it. Ordinary lines submitted separately become separate history commands.

### 7.2 Confidence loss

The buffer becomes uncertain and predictions disappear after an unrecognized control sequence or an operation whose resulting shell buffer cannot be observed, including shell-native Tab completion. An uncertain buffer is not persisted. Enter or `Ctrl+C` resets the state to a new confident empty buffer.

### 7.3 Enter and visible-echo safety

Enter creates a pending command only when the buffer is confident and non-empty. In default strict capture mode, the xterm logical line or logical multiline region immediately before submission must correspond to the reconstructed command. This prevents hidden password input and unrelated no-echo program input from being persisted.

Generic mode defines this event as an observed command-line submission, not proof that the shell started or completed a process. Shell continuation prompts are not reliably distinguishable across all local and remote shells. Exact final multiline commands require a future enhanced `CommandCaptureAdapter`; the generic mode keeps the best-effort Enter-delimited behavior explicit rather than guessing a shell grammar.

Advanced settings may enable permissive capture globally. The setting displays a warning that every confidently reconstructed Enter-delimited line can then be recorded, including input outside a shell prompt. Sensitive filtering still runs unless separately disabled.

### 7.4 Control-C

`Ctrl+C` is always forwarded to the terminal. It also immediately clears the internal command buffer, candidates, selection, dismissal state, paste state, and any pending persistence request. The plugin does not replace or delay the terminal's interrupt behavior.

### 7.5 Alternate screen

While the terminal is in alternate-screen mode, capture and predictions are disabled, runtime state is cleared, and every input byte is passed through. Returning to the normal screen starts with an empty confident buffer.

## 8. Matching and Ranking

Predictions begin after one input character by default. Empty or whitespace-only buffers return no candidates.

Matching is case-insensitive by default and configurable. Results are partitioned into:

1. Commands beginning with the query.
2. Commands containing the query elsewhere.

Every prefix result sorts ahead of every substring result. Within a partition, normalized component scores are combined:

```text
score = 0.55 * recency + 0.30 * frequency + 0.15 * matchCloseness
```

- Recency decays with elapsed time from `lastUsedAt`.
- Frequency uses logarithmic scaling so repeated commands do not permanently dominate.
- Match closeness rewards an earlier match and less unmatched text.

Ties resolve deterministically by newer `lastUsedAt`, higher `useCount`, and finally command text. The three weights are advanced settings and must sum to 1. The settings UI normalizes edited values before saving.

## 9. Prediction UI and Adoption

### 9.1 Presentation modes

All modes are included. Mode B is the default.

- Mode A, inline: show only the selected command's remaining text as a ghost prediction. Up and Down cycle through candidates one at a time.
- Mode B, list: show up to five candidates in a cursor-anchored list whenever matches exist. The active row is highlighted.
- Mode C, hybrid: show the top inline prediction and keep the list collapsed. Down opens the list; Escape collapses or dismisses it.

The default maximum is five visible candidates for B and C and is configurable. Overlay positioning uses xterm's buffer cursor coordinates and screen bounds through a small `TerminalGeometryAdapter`. Rendering-version workarounds are isolated inside that adapter.

The overlay repositions after input, terminal resize, font zoom, scroll, and selection change. It flips above the cursor when insufficient space exists below and clips within the terminal viewport.

### 9.2 Default key behavior

- Up and Down select candidates only while candidates are active; otherwise their bytes pass to the shell.
- Right adopts the active candidate only while a candidate is active; otherwise it passes to the shell.
- Escape closes predictions for the current buffer. A subsequent text edit allows them to appear again.
- Tab always passes to the shell and marks the generic reconstructed buffer uncertain.
- `Ctrl+C` always passes through and clears plugin state.

Navigation and adoption bindings are configurable. Configuration rejects bindings that collide with `Ctrl+C` or ordinary printable input.

### 9.3 Safe adoption

For a single-line prefix prediction when the cursor is at the end, adoption sends only the unmatched suffix. Otherwise it moves from the known cursor to the end, removes the known buffer by grapheme, and inserts the complete selected command. The middleware emits these bytes downstream without recursively treating them as user input, then sets its own buffer to the adopted command.

A multiline command is offered only when the terminal reports bracketed-paste support. Adoption wraps the text in bracketed-paste markers so embedded newlines edit the command buffer rather than execute it. Without bracketed-paste support, multiline entries remain stored but are excluded from predictions.

No adoption path sends Enter, carriage return, newline outside bracketed-paste framing, or a shell command delimiter.

## 10. Sensitive History Policy

Sensitive filtering runs before an event can enter a disk queue. It is enabled by default.

The initial case-insensitive indicators are:

- `password`
- `asplaintext`
- `token`
- `apikey`
- `secret`

Users can add exclusion regular expressions. Invalid expressions are rejected inline and the last valid saved configuration remains active. The entire command is discarded on a match; the plugin never writes a redacted form that could retain fragments of a credential.

Users may explicitly disable sensitive filtering. Strict visible-echo capture remains independently enabled unless they also change capture mode.

## 11. Settings

The Tabby settings page contains:

- Plugin enabled.
- Presentation mode A, B, or C; default B.
- Maximum visible candidates; default 5.
- Minimum query length; default 1.
- Case-sensitive matching; default off.
- Unique history capacity per connection; default 4096.
- Recency, frequency, and match-closeness weights; defaults 55, 30, and 15.
- Strict or permissive capture; default strict.
- Sensitive filtering enabled; default on.
- User exclusion regular expressions.
- Candidate navigation, adoption, and dismissal bindings.
- Clear active connection history.

The clear action is disabled without an active eligible terminal. Otherwise it names the active connection, requires confirmation, clears only its memory index and hashed file, and refreshes predictions in every open tab using the same key.

Settings live in Tabby's configuration. Command history never lives in Tabby's configuration document.

## 12. Failure Handling

- Middleware and controller exceptions log diagnostic context without raw command text and pass the original input through.
- Matcher failures hide predictions for that input and do not change the command buffer.
- Overlay failures remove the overlay and leave capture and terminal input functional.
- Repository read or write failures warn once per failure episode and use connection-local memory only.
- Invalid JSONL records are skipped without rewriting the source merely because it contains an error.
- A missing or unsupported frontend disables visual predictions for that terminal and passes all input through.
- An unresolved connection identity uses tab-lifetime memory and cannot access another connection's repository.
- Plugin detach closes queues after pending appends, cancels subscriptions, removes middleware, and removes overlay nodes.

## 13. Performance Requirements

- Querying and ranking 4096 unique commands must complete within 10 ms at the 95th percentile in the automated benchmark environment.
- No filesystem operation occurs synchronously on the input path.
- One history file is loaded at most once per plugin process and connection key, then shared by tabs using that key.
- Rendering updates are coalesced to one animation frame.
- Compaction runs asynchronously and never holds terminal input or matching locks.

## 14. Testing Strategy

### 14.1 Unit tests

- `CommandBuffer`: printable input, Unicode graphemes, paste, cursor edits, deletion, control edits, unknown sequences, Enter, `Ctrl+C`, confidence, and alternate screen.
- `ConnectionIdentityResolver`: saved profiles, SSH Quick Connect, serial, local, sanitizer coverage, stable hashing, and unsafe fallback.
- `SensitiveCommandFilter`: built-in indicators, custom expressions, disabled mode, and invalid-expression handling.
- `HistoryMatcher`: prefix partition, substring partition, case rules, recency, logarithmic frequency, closeness, deterministic ties, and result limits.
- `JsonlHistoryRepository`: append, replay, aggregate, capacity, isolation, corrupt lines, failed writes, memory fallback, and atomic compaction.
- Presentation reducers for A, B, C and their selection behavior.

### 14.2 Integration and component tests

- A fake Tabby terminal and session verify middleware attachment, detachment, input forwarding, active-key suppression, adoption without Enter, session replacement, and same-key tab sharing.
- xterm-compatible buffer fixtures verify visible-echo safety and geometry calculations.
- Angular component tests verify defaults, validation, confirmation, active-connection clearing, and live configuration updates.
- Temporary real directories verify that two connection keys never read, modify, compact, or clear each other's files.

### 14.3 Build and package tests

- TypeScript typecheck.
- Lint.
- Complete automated test suite.
- Production Webpack build.
- npm package inspection confirming the `tabby-plugin` keyword, compiled `dist`, declarations, README, and license, with no source history or test fixtures shipped accidentally.

### 14.4 Manual Tabby acceptance matrix

Test the packaged plugin in the current stable Tabby desktop release with:

- PowerShell and `cmd.exe` on Windows.
- WSL Bash.
- Local Bash or Zsh on macOS/Linux when available.
- Saved SSH and SSH Quick Connect.
- Split panes and multiple tabs sharing one connection.
- Two different connections with identical command text.
- Password/no-echo prompts.
- Vim, less, top, or another alternate-screen application.
- Bracketed multiline paste.
- All three presentation modes and configuration changes without restart.
- `Ctrl+C` during an edited line and while a process is running.
- Storage unavailable and a history file containing a truncated final line.

## 15. Acceptance Criteria

The release is complete when:

1. Commands from one connection never appear in another connection's predictions.
2. History survives a Tabby restart in the documented per-user data directory.
3. Typing produces prefix-first, ranked predictions in default mode B.
4. Modes A, B, and C can be selected in settings and update active terminals.
5. Up and Down navigate, Right adopts without execution, Escape dismisses, and Tab remains a shell input.
6. `Ctrl+C` retains its interrupt behavior and clears all plugin command state.
7. Strict capture does not persist tested no-echo password input or alternate-screen input.
8. Sensitive matches do not reach the filesystem while filtering is enabled.
9. Clearing history affects only the active connection after confirmation.
10. A storage, parser, matcher, or overlay failure does not make terminal input unusable.
11. Automated tests, lint, typecheck, production build, and package inspection pass.
12. The real-Tabby acceptance matrix has no unresolved release-blocking failures.
