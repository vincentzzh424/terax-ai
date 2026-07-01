import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  IBufferCell,
  IBufferLine,
  IBufferRange,
  ILink,
  ILinkHandler,
  ILinkProvider,
  Terminal,
} from "@xterm/xterm";

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

// "Open with link" modifier: Cmd on mac, Ctrl elsewhere -- matches iTerm/VS Code.
function linkModifierHeld(event: MouseEvent): boolean {
  return IS_MAC ? event.metaKey : event.ctrlKey;
}

// http(s) URLs. Mirrors xterm's strictUrlRegex: stop at whitespace and common
// delimiters, trim trailing punctuation/brackets so sentence-ending `.` or a
// wrapping `)` isn't swallowed into the URL.
const URL_RE =
  /(?:https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

// A path segment character: Unicode letters/digits plus the punctuation that
// shows up in real filenames (`.` `_` `+` `-`). CJK filenames
// (e.g. `安全工作报告.md`) need the Unicode property classes -- `\w` alone is
// ASCII-only and silently drops them.
const SEG = "[\\p{L}\\p{N}._+-]+";
// Final segment must end in a short alphabetic extension so bare words
// (`hello`, `key`, `value`) and numeric runs (dates `2024/01/01`) don't get
// linkified. The backend existence check is the real filter, this just keeps
// the candidate set small.
const TAIL = `${SEG}\\.[A-Za-z][A-Za-z0-9]{0,5}`;

// A local file path with an optional `:line` or `:line:col` suffix (Claude
// Code, compiler diagnostics). Forms: home (`~/`), relative dot (`./`,`../`),
// absolute (`/`), slash-bearing relative (`a/b.ext`), or a bare filename with
// extension (`report.md`, the common `ls` case). Needs the `u` flag for
// `\p{L}`/`\p{N}` to work.
const PATH_RE = new RegExp(
  `(?:^|[\\s"'(){}[\\]<>(),;:=])(((?:~/|\\.{1,2}/)(?:${SEG}/)*${SEG}|/(?:${SEG}/)+${SEG}|(?:${SEG}/)+${TAIL}|${TAIL})(?::\\d+(?::\\d+)?)?)`,
  "gu",
);

// Strip a trailing `:line` or `:line:col` (Claude Code / compiler diagnostics)
// before resolving -- the file is what we open, not the coordinates.
function stripLineSuffix(path: string): string {
  return path.replace(/:\d+(?::\d+)?$/, "");
}

type Candidate = {
  start: number;
  end: number;
  text: string;
  kind: "url" | "path";
};

export function findCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  // Clone with global flag; preserve PATH_RE's `u` flag (\p{L} needs it).
  const ure = new RegExp(URL_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = ure.exec(text))) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
      kind: "url",
    });
  }
  const pre = new RegExp(PATH_RE.source, PATH_RE.flags);
  while ((m = pre.exec(text))) {
    const prefixLen = m[0].length - m[1].length;
    const start = m.index + prefixLen;
    const end = start + m[1].length;
    // Skip path matches that overlap a URL on the same line.
    if (out.some((c) => start < c.end && end > c.start)) continue;
    out.push({ start, end, text: m[1], kind: "path" });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// Map each string index of a translated line to its 0-based cell column. Wide
// chars occupy two cells but one string char, so a naive index->column map
// drifts when CJK text precedes a path on the same line.
function buildCellMap(line: IBufferLine, cell: IBufferCell): number[] {
  const map: number[] = [];
  for (let x = 0; x < line.length; x++) {
    line.getCell(x, cell);
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i++) map.push(x);
  }
  return map;
}

function rangeFor(
  y: number,
  c: Candidate,
  map: number[],
): IBufferRange {
  return {
    start: { x: map[c.start] + 1, y },
    end: { x: map[c.end - 1] + 1, y },
  };
}

// Existence is resolved on the backend (expands ~, joins against cwd) and
// cached by (text, cwd) so repeated hovers don't re-IPC.
const existsCache = new Map<string, boolean>();
const pending = new Map<string, Promise<boolean>>();

function pathExists(text: string, cwd: string | null): Promise<boolean> {
  const resolvePath = stripLineSuffix(text);
  const key = `${resolvePath}\0${cwd ?? ""}`;
  const cached = existsCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const existing = pending.get(key);
  if (existing) return existing;
  const p = invoke<string | null>("fs_resolve_existing", { path: resolvePath, cwd })
    .then((r) => {
      const ok = !!r;
      existsCache.set(key, ok);
      return ok;
    })
    .catch(() => {
      existsCache.set(key, false);
      return false;
    });
  pending.set(key, p);
  p.finally(() => pending.delete(key));
  return p;
}

function dispatchOpenFile(path: string): void {
  window.dispatchEvent(new CustomEvent<string>("terax:open-file", { detail: path }));
}

// Classify a clicked link's text and act on it. `text` is the link's payload:
// for OSC 8 hyperlinks that's the URI (e.g. `file:///...`, `https://...`),
// for the plain-text provider it's the matched buffer text. http(s) opens in
// the browser; anything else is resolved as a local path against the leaf cwd.
function openLinkTarget(raw: string, getCwd: () => string | null): void {
  const text = raw.trim();
  if (/^https?:\/\//i.test(text)) {
    void openUrl(text).catch((e) => console.error("[terax] openUrl failed:", e));
    return;
  }
  let path = text;
  if (path.toLowerCase().startsWith("file://")) {
    // file: URIs are percent-encoded (%20, CJK percent-escapes).
    try {
      path = decodeURIComponent(path.slice("file://".length));
    } catch {
      path = path.slice("file://".length);
    }
  }
  path = stripLineSuffix(path);
  const cwd = getCwd();
  void invoke<string | null>("fs_resolve_existing", { path, cwd })
    .then((canon) => {
      if (canon) dispatchOpenFile(canon);
    })
    .catch((e) => console.error("[terax] resolve link failed:", e));
}

function makeUrlLink(y: number, c: Candidate, map: number[], getCwd: () => string | null): ILink {
  const uri = c.text;
  return {
    text: uri,
    range: rangeFor(y, c, map),
    decorations: { underline: true, pointerCursor: true },
    activate(event) {
      if (!linkModifierHeld(event)) return;
      openLinkTarget(uri, getCwd);
    },
  };
}

function makePathLink(
  y: number,
  c: Candidate,
  map: number[],
  text: string,
  getCwd: () => string | null,
): ILink {
  return {
    text,
    range: rangeFor(y, c, map),
    decorations: { underline: true, pointerCursor: true },
    activate(event) {
      if (!linkModifierHeld(event)) return;
      openLinkTarget(text, getCwd);
    },
  };
}

async function buildLinks(
  term: Terminal,
  y: number,
  getCwd: () => string | null,
): Promise<ILink[] | undefined> {
  const line = term.buffer.active.getLine(y - 1);
  if (!line) return undefined;
  const text = line.translateToString(true);
  if (!text) return undefined;
  const candidates = findCandidates(text);
  if (candidates.length === 0) return undefined;
  const map = buildCellMap(line, term.buffer.active.getNullCell());
  const cwd = getCwd();
  const results = await Promise.all(
    candidates.map(async (c): Promise<ILink | null> => {
      if (c.kind === "url") return makeUrlLink(y, c, map, getCwd);
      const ok = await pathExists(c.text, cwd);
      return ok ? makePathLink(y, c, map, c.text, getCwd) : null;
    }),
  );
  const links = results.filter((r): r is ILink => r !== null);
  return links.length ? links : undefined;
}

export function makeTerminalLinkProvider(
  term: Terminal,
  getCwd: () => string | null,
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      // Always invoke the callback: xterm waits on it, so a rejected promise
      // would leave the line without links and swallow the error silently.
      void buildLinks(term, y, getCwd).then(
        (links) => callback(links),
        () => callback(undefined),
      );
    },
  };
}

// Handler for OSC 8 hyperlinks emitted by tools like Claude Code (the blue
// file-path links). Without it xterm renders the style but clicks do nothing.
export function makeTerminalLinkHandler(
  getCwd: () => string | null,
): ILinkHandler {
  return {
    activate(event, text) {
      if (!linkModifierHeld(event)) return;
      openLinkTarget(text, getCwd);
    },
  };
}
