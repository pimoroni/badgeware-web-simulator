/* -- Monaco editor setup: instance + language / theme / completions ---------
   createEditor() registers the Python language tweaks, the badgeware theme and
   the completion provider (once), then mounts and returns the editor instance.
   app.js just calls it; all editor knobs live here. */
import { BADGEWARE_GLOBALS, MEMBERS } from './completions.js';
import { userFS, getSystemPaths } from './fs.js';

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
    documentation:   entry.doc,
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
      case 'image':      return (method === 'load' || method === 'window') ? MEMBERS.image : null;
      case 'screen':     return method === 'window' ? MEMBERS.image : null;
      case 'SpriteSheet': {
        if (method === 'animation') return MEMBERS.AnimatedSprite;
        if (method === 'sprite')    return MEMBERS.image;
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
