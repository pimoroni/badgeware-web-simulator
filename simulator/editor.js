/* -- Monaco editor setup: instance + language / theme / completions ---------
   createEditor() registers the Python language tweaks, the badgeware theme and
   the completion provider (once), then mounts and returns the editor instance.
   app.js just calls it; all editor knobs live here. */
import { BADGEWARE_GLOBALS, MEMBERS } from './completions.js';
import { userFS, getSystemPaths } from './fs.js';

/* -- Help text -> markdown ----------------------------------------------------
   Completion/signature `documentation` renders as markdown when handed an
   IMarkdownString. We keep the doc strings in completions.js as plain text and
   format them here: API tokens (types, calls, module.CONST, ALL_CAPS) become
   monospace code spans, everything else is markdown-escaped so prose like
   [sprite:name], *args and <= survives verbatim. */
const MD_TYPES = 'vec2|rect|mat3|indexed_image|image|color|brush|shape|spritesheet|tween|pixel_font|vector_font|font';
const MD_ROOTS = 'screen|image|badge|display|shape|color|brush|text|font|rtc|mat3|vec2|rect|tween|spritesheet|algorithm|loop|State';
// Tried in order at each position; the first (longest, call-shaped) wins.
const MD_CODE_RE = new RegExp(
  '[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*\\([^)\\n]*\\)' +   // calls: vec2(80, 60), screen.text()
  `|(?:${MD_ROOTS})\\.[A-Za-z_]\\w*` +                   // dotted API names: image.X4, font.sins
  `|\\b(?:${MD_TYPES})\\b` +                             // bare type names: a vec2
  '|\\b[A-Z][A-Z0-9_]{2,}\\b',                           // ALL_CAPS constants: LORES, NON_ZERO
  'g');

function escapeMarkdown(text) {
  return text.replace(/[\\`*[\]<]/g, m => '\\' + m);
}

function docToMarkdown(doc) {
  if (!doc) return doc;
  let out = '', last = 0, m;
  MD_CODE_RE.lastIndex = 0;
  while ((m = MD_CODE_RE.exec(doc)) !== null) {
    out += escapeMarkdown(doc.slice(last, m.index)) + '`' + m[0] + '`';
    last = m.index + m[0].length;
  }
  out += escapeMarkdown(doc.slice(last));
  // Single newlines are soft breaks in markdown; keep them as hard breaks so
  // multi-line docs read as written.
  return out.replace(/\n/g, '  \n');
}

// documentation field as an IMarkdownString, or undefined when there's no doc.
function docField(doc) {
  return doc ? { value: docToMarkdown(doc) } : undefined;
}

/* -- Colour swatches ----------------------------------------------------------
   Palette values from picovector api/color.py, resolved for Tufty (the sim's
   model): black and white take the Tufty tuples - a dark blue-black and an
   off-white, not pure 000/fff. Used to draw a swatch next to color.<name> and
   to seed the picker on color.rgb()/color.hsv() calls. */
const PALETTE_RGB = {
  black:  [0x14, 0x1e, 0x28, 255], grape: [0x44, 0x24, 0x34, 255], navy:  [0x30, 0x34, 0x6d, 255],
  grey:   [0x4e, 0x4a, 0x4e, 255], brown: [0x85, 0x4c, 0x30, 255], green: [0x34, 0x65, 0x24, 255],
  red:    [0xd0, 0x46, 0x48, 255], taupe: [0x75, 0x71, 0x61, 255], blue:  [0x59, 0x7d, 0xce, 255],
  orange: [0xd2, 0x7d, 0x2c, 255], smoke: [0x85, 0x95, 0xa1, 255], lime:  [0x6d, 0xaa, 0x2c, 255],
  latte:  [0xd2, 0xaa, 0x99, 255], cyan:  [0x6d, 0xc2, 0xca, 255], yellow:[0xda, 0xd4, 0x5e, 255],
  white:  [0xde, 0xee, 0xd6, 255], transparent: [0x00, 0x00, 0x00, 0],
  light_grey: [0xc0, 0xc0, 0xc0, 255], dark_grey: [0x40, 0x40, 0x40, 255],
};

// Badge HSV: h, s, v each 0-255, hue is 256 counts to a full turn.
function hsvToRgb(h, s, v) {
  const H = (h / 256) * 6, S = s / 255, V = v / 255;
  const i = ((Math.floor(H) % 6) + 6) % 6, f = H - Math.floor(H);
  const p = V * (1 - S), q = V * (1 - S * f), t = V * (1 - S * (1 - f));
  const [r, g, b] = [[V, t, p], [q, V, p], [p, V, t], [p, q, V], [t, p, V], [V, p, q]][i];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r)      h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h /= 6; if (h < 0) h += 1;
  }
  return [Math.round(h * 256) & 255, Math.round((max === 0 ? 0 : d / max) * 255), Math.round(max * 255)];
}

const COLOR_CALL_RE  = /color\.(rgb|hsv)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/g;
const COLOR_CONST_RE = new RegExp('color\\.(' + Object.keys(PALETTE_RGB).join('|') + ')\\b', 'g');

// Mount the Badgeware editor in `container` and return the Monaco instance.
export function createEditor(container) {
  configureMonaco(monaco);
  return monaco.editor.create(container, {
    value:          '# Loading…',
    language:       'python',
    theme:          'badgeware',
    fontSize:       16,
    fontFamily:     'Consolas, Monaco, "Andale Mono", "Ubuntu Mono", monospace',
    fontLigatures:  true,
    minimap:        { enabled: false },
    scrollBeyondLastLine: false,
    lineNumbers:    'on',
    tabSize:        2,
    insertSpaces:   true,
    detectIndentation: false,          // house style is 2 spaces, never adopt a file's own
    autoIndent:     'full',            // apply Python's indent-after-colon rules on Enter
    bracketPairColorization: { enabled: true },
    automaticLayout: true,
    wordWrap:       'on',
    renderLineHighlight: 'line',
    suggestOnTriggerCharacters: true,
    quickSuggestions: { other: true, comments: false, strings: false },
    parameterHints: { enabled: true },
  });
}

// Convert a declarative completion stub (see completions.js) → a Monaco
// CompletionItem. Lives here, with its only consumer, so completions.js stays
// pure data.
function toCompletionItem(entry, range, monaco) {
  const K = monaco.languages.CompletionItemKind;
  const kindMap = {
    Constant: K.Constant,
    Variable: K.Variable,
    Module:   K.Module,
    Class:    K.Class,
    Function: K.Function,
    Method:   K.Method,
    Property: K.Property,
  };

  const insertText = entry.insertText ?? entry.label;
  const isSnippet  = insertText.includes('${');

  return {
    label:           entry.label,
    kind:            kindMap[entry.kind] ?? K.Variable,
    detail:          entry.detail,
    documentation:   docField(entry.doc),
    insertText,
    insertTextRules: isSnippet
      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
      : undefined,
    range,
  };
}

function configureMonaco(monaco) {

  /* -- Type inference: scan document for ident = TypeName(...) patterns --
     Returns the MEMBERS array for the inferred type, or null.             */
  function inferMembersFromDoc(ident, docText) {
    // Match:  ident = TypeName(        → direct constructor
    //         ident = module.method(   → factory method on a known module
    const re = new RegExp(`\\b${ident}\\s*=\\s*(\\w+)(?:\\.(\\w+))?\\s*\\(`, 'g');
    let last = null, m;
    while ((m = re.exec(docText)) !== null) last = m;
    if (!last) return null;

    const [, typeName, method] = last;

    // Direct constructor: pos = vec2(...), bounds = rect(...), etc.
    if (!method) return MEMBERS[typeName] ?? null;

    // Factory call on a known module/type
    switch (typeName) {
      case 'shape':      return MEMBERS.shape;               // any shape.* → shape instance
      case 'image':
      case 'screen': {
        if (method === 'load' || method === 'window' || method === 'sprite') return MEMBERS.image;
        if (method === 'spritesheet') return MEMBERS.spritesheet;
        if (method === 'qr') return MEMBERS.indexed_image;
        return null;
      }
      default:           return null;
    }
  }

  /* -- Completion provider ----------------------------------------- */
  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.', '(', '|'],

    provideCompletionItems(model, position, context) {
      const linePrefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      // -- File-path completion inside string literals -------------
      // Matches the partial path after an opening quote, e.g. open("/rom/fon
      const strMatch = linePrefix.match(/["']((?:\/|\.\/)[^"']*)$/);
      if (strMatch) {
        const partial   = strMatch[1];
        const lastSlash = partial.lastIndexOf('/');
        const dir       = partial.slice(0, lastSlash + 1);   // "/rom/"
        const prefix    = partial.slice(lastSlash + 1);       // "fon"

        const allPaths = [...getSystemPaths(), ...userFS.paths()];
        const seen = new Set();
        const suggestions = [];

        for (const p of allPaths) {
          if (!p.startsWith(dir)) continue;
          const rest  = p.slice(dir.length);
          const slash = rest.indexOf('/');
          const seg   = slash === -1 ? rest : rest.slice(0, slash + 1);
          if (!seg.startsWith(prefix) || seen.has(seg)) continue;
          seen.add(seg);
          const isDir = seg.endsWith('/');
          suggestions.push({
            label:    seg,
            kind:     isDir
              ? monaco.languages.CompletionItemKind.Folder
              : monaco.languages.CompletionItemKind.File,
            detail:   isDir ? 'directory' : p,
            insertText: seg,
            sortText: (isDir ? '0' : '1') + seg,
            range: {
              startLineNumber: position.lineNumber,
              startColumn:     position.column - prefix.length,
              endLineNumber:   position.lineNumber,
              endColumn:       position.column,
            },
          });
        }
        return { suggestions };
      }

      // -- badge.mode() flag completion ----------------------------
      // Inside a badge.mode( … ) call, offer the display-mode flags.
      // LORES / HIRES are the mutually-exclusive resolution choices, so once
      // one of them is present we stop offering either (you can't combine them).
      const modeMatch = linePrefix.match(/badge\.mode\(\s*([^)]*)$/);
      if (modeMatch) {
        const hasResolution = /\b(?:LORES|HIRES)\b/.test(modeMatch[1]);
        const order = hasResolution
          ? ['VSYNC', 'DITHER', 'FAST_UPDATE', 'MEDIUM_UPDATE', 'FULL_UPDATE']
          : ['LORES', 'HIRES', 'VSYNC', 'DITHER', 'FAST_UPDATE', 'MEDIUM_UPDATE', 'FULL_UPDATE'];
        const word  = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          startColumn:     word.startColumn,
          endLineNumber:   position.lineNumber,
          endColumn:       word.endColumn,
        };
        const suggestions = order
          .map(label => BADGEWARE_GLOBALS.find(g => g.label === label))
          .filter(Boolean)
          .map((entry, i) => {
            const item = toCompletionItem(entry, range, monaco);
            item.sortText = String(i).padStart(2, '0');   // preserve our order
            return item;
          });
        return { suggestions };
      }

      // '(' / '|' only drive the badge.mode() list above; elsewhere they
      // shouldn't pop the full global list.
      if (context && (context.triggerCharacter === '(' || context.triggerCharacter === '|')) {
        return { suggestions: [] };
      }

      // Detect "identifier." at end of typed text
      const dotMatch = linePrefix.match(/(\w+)\.\s*$/);

      if (dotMatch) {
        const ident   = dotMatch[1];
        const members = MEMBERS[ident] ?? inferMembersFromDoc(ident, model.getValue());
        if (members) {
          const word  = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            startColumn:     word.startColumn,
            endLineNumber:   position.lineNumber,
            endColumn:       word.endColumn,
          };
          return { suggestions: members.map(m => toCompletionItem(m, range, monaco)) };
        }
        // Unknown object after a dot — let Monaco handle it
        return { suggestions: [] };
      }

      // Global completions
      const word  = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        startColumn:     word.startColumn,
        endLineNumber:   position.lineNumber,
        endColumn:       word.endColumn,
      };
      return { suggestions: BADGEWARE_GLOBALS.map(m => toCompletionItem(m, range, monaco)) };
    },
  });

  /* -- Signature help: parameter hints while typing inside a call --------
     Reuses the completion data. An entry may carry an explicit `signature`
     (a rich, per-parameter form, or an array of overloads); otherwise one is
     derived from its insertText snippet so every callable still hints.      */

  // "text(${1:text}, ${2:at})" -> { label: 'text(text, at)', params: [[5,9],[11,13]] }
  // with character ranges Monaco highlights as the active argument.
  function signatureFromSnippet(insertText) {
    if (!insertText || insertText.indexOf('(') === -1) return null;
    let label = '';
    const params = [];
    for (let i = 0; i < insertText.length; ) {
      if (insertText[i] === '$' && insertText[i + 1] === '{') {
        const end = insertText.indexOf('}', i);
        if (end === -1) { label += insertText[i++]; continue; }
        const body  = insertText.slice(i + 2, end);      // "1:name" or "1"
        const colon = body.indexOf(':');
        const name  = colon === -1 ? 'arg' + body : body.slice(colon + 1);
        const start = label.length;
        label += name;
        params.push([start, label.length]);
        i = end + 1;
      } else {
        label += insertText[i++];
      }
    }
    return params.length ? { label, params } : null;
  }

  // Monaco SignatureInformation[] for an entry (one per overload).
  function signaturesForEntry(entry) {
    const build = sig => ({
      label: sig.label,
      documentation: docField(entry.doc),
      // Explicit params are { label, doc }; snippet params are [start, end] ranges.
      parameters: sig.params.map(p =>
        (p && p.label !== undefined)
          ? { label: p.label, documentation: docField(p.doc) }
          : { label: p }),
    });
    if (entry.signature) {
      return Array.isArray(entry.signature) ? entry.signature.map(build) : [build(entry.signature)];
    }
    const snippet = signatureFromSnippet(entry.insertText);
    return snippet ? [build(snippet)] : null;
  }

  // Walk the text left-to-right tracking a paren/bracket stack, skipping string
  // literals, and return the innermost open call: its receiver, name and how
  // many top-level commas (arguments) precede the cursor.
  function findCall(text) {
    const stack = [];
    for (let i = 0; i < text.length; ) {
      const ch = text[i];
      if (ch === '"' || ch === "'") {
        const quote = ch; i++;
        while (i < text.length && text[i] !== quote) { if (text[i] === '\\') i++; i++; }
        i++; continue;
      }
      if (ch === '(') {
        const before = text.slice(0, i);
        const m = before.match(/(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*$/);
        stack.push(m ? { receiver: m[1] || null, name: m[2], args: 0 } : { bracket: true });
        i++; continue;
      }
      if (ch === '[' || ch === '{') { stack.push({ bracket: true }); i++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { stack.pop(); i++; continue; }
      if (ch === ',' && stack.length) {
        const top = stack[stack.length - 1];
        if (!top.bracket) top.args++;
        i++; continue;
      }
      i++;
    }
    for (let k = stack.length - 1; k >= 0; k--) if (!stack[k].bracket) return stack[k];
    return null;
  }

  function entryForCall(call, docText) {
    if (call.receiver) {
      const members = MEMBERS[call.receiver] ?? inferMembersFromDoc(call.receiver, docText);
      return members ? members.find(e => e.label === call.name) ?? null : null;
    }
    return BADGEWARE_GLOBALS.find(e => e.label === call.name) ?? null;
  }

  monaco.languages.registerSignatureHelpProvider('python', {
    signatureHelpTriggerCharacters:   ['(', ','],
    signatureHelpRetriggerCharacters: [','],

    provideSignatureHelp(model, position) {
      const linePrefix = model.getValueInRange({
        startLineNumber: position.lineNumber, startColumn: 1,
        endLineNumber:   position.lineNumber, endColumn:   position.column,
      });

      const call = findCall(linePrefix);
      if (!call || !call.name) return null;

      const entry = entryForCall(call, model.getValue());
      if (!entry) return null;

      const signatures = signaturesForEntry(entry);
      if (!signatures) return null;

      // For overloads, pick the first whose parameter count still fits the args
      // typed so far (falling back to the widest).
      let activeSignature = 0;
      if (signatures.length > 1) {
        const fit = signatures.findIndex(s => call.args < s.parameters.length);
        activeSignature = fit === -1 ? signatures.length - 1 : fit;
      }
      const params = signatures[activeSignature].parameters;
      const activeParameter = Math.min(call.args, Math.max(0, params.length - 1));

      return { value: { signatures, activeSignature, activeParameter }, dispose() {} };
    },
  });

  /* -- Hover: show an API symbol's signature + docs on hover ------------- */

  // The call form shown at the top of a hover, as plain code (no escaping).
  function hoverTitle(entry) {
    if (entry.signature) {
      return Array.isArray(entry.signature) ? entry.signature[0].label : entry.signature.label;
    }
    const snippet = signatureFromSnippet(entry.insertText);
    if (snippet) return snippet.label;
    return (entry.insertText ?? entry.label).replace(/\$\{\d+:?([^}]*)\}/g, '$1');
  }

  monaco.languages.registerHoverProvider('python', {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;

      const before = model.getValueInRange({
        startLineNumber: position.lineNumber, startColumn: 1,
        endLineNumber:   position.lineNumber, endColumn:   word.startColumn,
      });
      const dot = before.match(/(\w+)\s*\.\s*$/);

      const entry = dot
        ? (MEMBERS[dot[1]] ?? inferMembersFromDoc(dot[1], model.getValue()) ?? [])
            .find(e => e.label === word.word) ?? null
        : BADGEWARE_GLOBALS.find(e => e.label === word.word) ?? null;
      if (!entry) return null;

      const contents = [{ value: '```python\n' + hoverTitle(entry) + '\n```' }];
      if (entry.doc) contents.push({ value: docToMarkdown(entry.doc) });

      return {
        range: {
          startLineNumber: position.lineNumber, startColumn: word.startColumn,
          endLineNumber:   position.lineNumber, endColumn:   word.endColumn,
        },
        contents,
      };
    },
  });

  /* -- Colour swatches + picker on color.rgb/hsv() and color.<name> ------ */

  const rangeAt = (model, offset, len) => {
    const s = model.getPositionAt(offset), e = model.getPositionAt(offset + len);
    return { startLineNumber: s.lineNumber, startColumn: s.column,
             endLineNumber:   e.lineNumber, endColumn:   e.column };
  };
  const monacoColor = (r, g, b, a) => ({ red: r / 255, green: g / 255, blue: b / 255, alpha: a / 255 });

  monaco.languages.registerColorProvider('python', {
    provideDocumentColors(model) {
      const text = model.getValue();
      const out = [];
      let m;

      COLOR_CALL_RE.lastIndex = 0;
      while ((m = COLOR_CALL_RE.exec(text)) !== null) {
        const [full, fn, a1, a2, a3, a4] = m;
        const [r, g, b] = fn === 'rgb' ? [+a1, +a2, +a3] : hsvToRgb(+a1, +a2, +a3);
        out.push({ range: rangeAt(model, m.index, full.length),
                   color: monacoColor(r, g, b, a4 === undefined ? 255 : +a4) });
      }

      COLOR_CONST_RE.lastIndex = 0;
      while ((m = COLOR_CONST_RE.exec(text)) !== null) {
        const [r, g, b, a] = PALETTE_RGB[m[1]];
        out.push({ range: rangeAt(model, m.index, m[0].length), color: monacoColor(r, g, b, a) });
      }
      return out;
    },

    provideColorPresentations(model, info) {
      const c = info.color;
      const r = Math.round(c.red * 255), g = Math.round(c.green * 255),
            b = Math.round(c.blue * 255), a = Math.round(c.alpha * 255);
      const tail = a < 255 ? `, ${a})` : ')';

      // Keep an hsv() call in hsv; everything else (rgb calls and palette
      // constants) becomes an rgb() call when edited.
      const label = model.getValueInRange(info.range).startsWith('color.hsv')
        ? `color.hsv(${rgbToHsv(r, g, b).join(', ')}${tail}`
        : `color.rgb(${r}, ${g}, ${b}${tail}`;

      return [{ label, textEdit: { range: info.range, text: label } }];
    },
  });

  /* -- Custom theme (badgewa.re palette + Prism Tomorrow syntax) --- */
  monaco.editor.defineTheme('badgeware', {
    base:    'vs-dark',
    inherit: true,
    rules: [
      { token: '',                   foreground: 'ebf5ff' },
      { token: 'comment',            foreground: '4a6070', fontStyle: 'italic' },
      { token: 'string',             foreground: '7ec699' },
      { token: 'string.escape',      foreground: 'b4dfc4' },
      { token: 'keyword',            foreground: 'cc99cd' },
      { token: 'keyword.operator',   foreground: '67cdcc' },
      { token: 'number',             foreground: 'f08d49' },
      { token: 'number.float',       foreground: 'f08d49' },
      { token: 'operator',           foreground: '67cdcc' },
      { token: 'delimiter',          foreground: 'b4bcc8' },
      { token: 'delimiter.parenthesis', foreground: 'b4bcc8' },
      { token: 'delimiter.bracket',  foreground: 'b4bcc8' },
      { token: 'type',               foreground: '6196cc' },
      { token: 'identifier',         foreground: 'ebf5ff' },
      { token: 'invalid',            foreground: 'e2777a' },
    ],
    colors: {
      'editor.background':                   '#0a141e',
      'editor.foreground':                   '#ebf5ff',
      'editor.lineHighlightBackground':      '#0d1924',
      'editor.lineHighlightBorder':          '#00000000',
      'editor.selectionBackground':          '#e0892030',
      'editor.selectionHighlightBackground': '#e0892018',
      'editor.inactiveSelectionBackground':  '#e0892018',
      'editor.findMatchBackground':          '#e0892055',
      'editor.findMatchHighlightBackground': '#e0892028',
      'editorLineNumber.foreground':         '#1e3040',
      'editorLineNumber.activeForeground':   '#6a8090',
      'editorCursor.foreground':             '#e08920',
      'editorIndentGuide.background1':       '#0d1a26',
      'editorIndentGuide.activeBackground1': '#1a2d3e',
      'editorRuler.foreground':              '#0d1a26',
      'editorBracketMatch.background':       '#e0892028',
      'editorBracketMatch.border':           '#e08920',
      'editorOverviewRuler.border':          '#0a141e',
      'scrollbarSlider.background':          '#1a2838aa',
      'scrollbarSlider.hoverBackground':     '#1a2838dd',
      'scrollbarSlider.activeBackground':    '#e0892040',
      /* Autocomplete / suggestion widget */
      'editorWidget.background':             '#0c1a26',
      'editorWidget.border':                 '#1a2d3e',
      'editorSuggestWidget.background':      '#0c1a26',
      'editorSuggestWidget.border':          '#1a2d3e',
      'editorSuggestWidget.foreground':      '#ebf5ff',
      'editorSuggestWidget.selectedBackground':      '#1a2d3a',
      'editorSuggestWidget.selectedForeground':      '#ebf5ff',
      'editorSuggestWidget.highlightForeground':     '#e08920',
      'editorSuggestWidget.focusHighlightForeground':'#e08920',
      /* Hover / parameter hints */
      'editorHoverWidget.background':        '#0c1a26',
      'editorHoverWidget.border':            '#1a2d3e',
      /* List selections inside widgets */
      'list.focusBackground':                '#1a2d3a',
      'list.hoverBackground':                '#0f1e2c',
      'list.activeSelectionBackground':      '#1a2d3a',
      'list.activeSelectionForeground':      '#ebf5ff',
      'list.inactiveSelectionBackground':    '#0f1e2c',
      'list.highlightForeground':            '#e08920',
    },
  });

}
