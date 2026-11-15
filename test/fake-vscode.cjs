// A small stand-in for the `vscode` module so the extension's glue code (wizard,
// session, status bar, terminal, commands) can be exercised from plain Node.
// It is NOT VS Code: it only proves the wiring. Use F5 for the real thing.
const fs = require('node:fs');

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => {
      this.listeners.push(fn);
      return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== fn)) };
    };
  }
  fire(value) {
    for (const l of [...this.listeners]) l(value);
  }
  dispose() {
    this.listeners = [];
  }
}

const Uri = {
  file: (p) => ({ scheme: 'file', fsPath: p, path: p, authority: '', toString: () => 'file://' + p }),
  parse: (s) => ({ scheme: s.split(':')[0], toString: () => s }),
  from: ({ scheme, authority = '', path = '/' }) => ({
    scheme,
    authority,
    path,
    fsPath: path,
    toString: () => `${scheme}://${authority}${path}`,
  }),
};

class FileSystemError extends Error {
  constructor(message) {
    super(typeof message === 'string' ? message : message?.toString?.() ?? 'FileSystemError');
    this.name = 'FileSystemError';
  }
  static FileNotFound(uri) {
    return new FileSystemError(`FileNotFound: ${uri}`);
  }
  static FileExists(uri) {
    return new FileSystemError(`FileExists: ${uri}`);
  }
  static FileIsADirectory(uri) {
    return new FileSystemError(`FileIsADirectory: ${uri}`);
  }
  static Unavailable(msg) {
    return new FileSystemError(`Unavailable: ${msg}`);
  }
}

/** Everything the test wants to observe or steer. */
const fake = {
  log: [],
  config: {},
  folders: [],
  watchers: [],
  terminals: [],
  executed: [],
  messages: [],
  registered: new Map(),
  fsProviders: new Map(),
  statusBar: undefined,
  onQuickPick: () => undefined,
  onInput: () => undefined,
  onMessage: () => undefined,
  onOpenDialog: () => undefined,
  windowState: new EventEmitter(),
  saved: new EventEmitter(),
  closedTerminal: new EventEmitter(),
  workspaceFoldersChanged: new EventEmitter(),
};

function memento() {
  const data = new Map();
  return { get: (k, d) => (data.has(k) ? data.get(k) : d), update: async (k, v) => void data.set(k, v) };
}

function makeContext(storageDir) {
  const secrets = new Map();
  return {
    subscriptions: [],
    globalState: memento(),
    globalStorageUri: Uri.file(storageDir),
    secrets: {
      get: async (k) => secrets.get(k),
      store: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    },
  };
}

const message = (kind) => async (text, ...rest) => {
  const options = rest[0] && typeof rest[0] === 'object' ? rest.shift() : {};
  fake.messages.push({ kind, text, options, buttons: rest });
  return fake.onMessage(kind, text, options, rest);
};

function configuration(section) {
  return {
    get: (k, d) => {
      if (k in fake.config) return fake.config[k];
      if (section && `${section}.${k}` in fake.config) return fake.config[`${section}.${k}`];
      return d;
    },
    inspect: () => ({ defaultValue: undefined }),
    update: async () => undefined,
  };
}

const vscode = {
  EventEmitter,
  Uri,
  FileSystemError,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  RelativePattern: class {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({ appendLine: (l) => fake.log.push(l), show() {}, dispose() {} }),
    createStatusBarItem: () => (fake.statusBar = { text: '', tooltip: '', show() {}, dispose() {} }),
    showQuickPick: async (items, options) => fake.onQuickPick(items, options ?? {}),
    showInputBox: async (options) => fake.onInput(options ?? {}),
    showInformationMessage: message('info'),
    showWarningMessage: message('warning'),
    showErrorMessage: message('error'),
    showOpenDialog: async (o) => fake.onOpenDialog(o),
    showWorkspaceFolderPick: async () => fake.folders.find((f) => f.uri.scheme === 'file') ?? fake.folders[0],
    withProgress: async (_o, task) => task({ report() {} }),
    createTerminal: (options) => {
      const term = {
        name: options.name,
        pty: options.pty,
        output: '',
        closed: false,
        exitStatus: undefined,
        show() {
          options.pty.open({ columns: 80, rows: 24 });
        },
        dispose() {
          options.pty.close();
          term.closed = true;
          term.exitStatus = { code: 0 };
          fake.closedTerminal.fire(term);
        },
      };
      options.pty.onDidWrite((s) => (term.output += s));
      options.pty.onDidClose(() => {
        term.closed = true;
        term.exitStatus = { code: 0 };
        fake.closedTerminal.fire(term);
      });
      fake.terminals.push(term);
      return term;
    },
    onDidChangeActiveTextEditor: new EventEmitter().event,
    onDidChangeWindowState: fake.windowState.event,
    onDidCloseTerminal: fake.closedTerminal.event,
  },
  workspace: {
    get workspaceFolders() {
      return fake.folders;
    },
    getWorkspaceFolder: (uri) =>
      fake.folders.find((f) => f.uri.scheme === uri.scheme && (uri.fsPath || '').startsWith(f.uri.fsPath || '')),
    getConfiguration: (section) => configuration(section),
    createFileSystemWatcher: () => {
      const w = { create: new EventEmitter(), change: new EventEmitter(), del: new EventEmitter(), dispose() {} };
      w.onDidCreate = w.create.event;
      w.onDidChange = w.change.event;
      w.onDidDelete = w.del.event;
      fake.watchers.push(w);
      return w;
    },
    onDidSaveTextDocument: fake.saved.event,
    onDidChangeWorkspaceFolders: fake.workspaceFoldersChanged.event,
    updateWorkspaceFolders: (start, deleteCount, ...adds) => {
      const next = [...fake.folders];
      next.splice(start, deleteCount ?? 0, ...adds.map((a, i) => ({ uri: a.uri, name: a.name, index: start + i })));
      fake.folders = next.map((f, i) => ({ ...f, index: i }));
      return true;
    },
    registerFileSystemProvider: (scheme, provider) => {
      fake.fsProviders.set(scheme, provider);
      return { dispose() { fake.fsProviders.delete(scheme); } };
    },
    fs: { delete: async (uri) => fs.promises.rm(uri.fsPath, { force: true }) },
  },
  commands: {
    registerCommand: (id, fn) => (fake.registered.set(id, fn), { dispose() {} }),
    executeCommand: async (id, ...args) => {
      if (fake.registered.has(id)) return fake.registered.get(id)(...args);
      fake.executed.push({ id, args });
    },
    getCommands: async () => [...fake.registered.keys()],
  },
  env: { openExternal: async () => true },
};

module.exports = { vscode, fake, makeContext, Uri };
