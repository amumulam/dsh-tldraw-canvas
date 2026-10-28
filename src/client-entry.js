import * as React from 'react';
import { Tldraw, TldrawApp } from '@tldraw/tldraw';
import { convertLegacySnapshot, isV1Document, isV5Snapshot } from './migrate.js';

const h = React.createElement;

/** Dictionary namespace owned by this plugin. */
const NS = 'tldraw';
/** This implementation's identity in the tab system. */
const ID = 'dsh-tldraw-canvas/canvas';
/** The tab kind this implementation owns. */
const KIND = 'tldraw';
/** The Host endpoint that reads and writes one Session's canvas. */
const ENDPOINT = '/api/tldraw';

const zh = {
  tab: '画板',
  guideTitle: 'Tldraw 画板',
  guideDescription: '为这个 Session 画草图、连线并随手标注',
  loading: '正在打开画板…',
  loadFailed: '画板打开失败',
  retry: '重试',
  saved: '已保存',
  saving: '保存中…',
  dirty: '等待保存…',
  saveFailed: '保存失败，下次修改时会重试',
  autosave: '自动保存到此 Session 的工作目录',
  errorDetail: '错误详情',
  renderFailed: '画板渲染失败',
  pathLabel: '文件',
  migrated: '已迁移旧画板',
  migratedTitle: '旧版 tldraw v5 画板已转换为 v1 格式',
  skipped: '部分旧图形未迁移',
};

const en = {
  tab: 'Canvas',
  guideTitle: 'Tldraw Canvas',
  guideDescription: 'Sketch, connect, and annotate inside this Session',
  loading: 'Opening the canvas…',
  loadFailed: 'Could not open the canvas',
  retry: 'Retry',
  saved: 'Saved',
  saving: 'Saving…',
  dirty: 'Waiting to save…',
  saveFailed: 'Save failed; the next edit retries',
  autosave: 'Autosaves inside this Session’s working directory',
  errorDetail: 'Error details',
  renderFailed: 'The canvas failed to render',
  pathLabel: 'File',
  migrated: 'Legacy canvas migrated',
  migratedTitle: 'The old tldraw v5 canvas was converted to the v1 format',
  skipped: 'Some old shapes were not migrated',
};

const CSS = `
.dsh-tldraw{position:relative;width:100%;height:100%;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);overflow:hidden}
.dsh-tldraw-bar{display:flex;align-items:center;gap:8px;flex:none;height:30px;padding:0 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden}
.dsh-tldraw-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.dsh-tldraw-dot[data-state='dirty']{background:var(--dsw-alias-state-warn-primary)}
.dsh-tldraw-dot[data-state='saving']{background:var(--dsw-alias-state-warn-primary);animation:dsh-tldraw-pulse 1s ease-in-out infinite}
.dsh-tldraw-dot[data-state='saved']{background:var(--dsw-alias-state-success-primary)}
.dsh-tldraw-dot[data-state='error']{background:var(--dsw-alias-state-error-primary)}
@keyframes dsh-tldraw-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.dsh-tldraw-label{flex:none}
.dsh-tldraw-note{flex:none;padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);font-size:11px;line-height:16px}
.dsh-tldraw-path{min-width:0;overflow:hidden;text-overflow:ellipsis;opacity:.7}
.dsh-tldraw-spacer{flex:1}
.dsh-tldraw-canvas{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden}
.dsh-tldraw-placeholder{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center}
.dsh-tldraw-placeholder h2{margin:0;font-size:15px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-tldraw-placeholder p{margin:0;max-width:300px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsh-tldraw-spinner{width:22px;height:22px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dsh-tldraw-spin .8s linear infinite}
@keyframes dsh-tldraw-spin{to{transform:rotate(360deg)}}
.dsh-tldraw-button{height:30px;padding:0 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.dsh-tldraw-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsh-tldraw-button:disabled{opacity:.45;cursor:default}
.dsh-tldraw-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-tldraw-error{box-sizing:border-box;margin-top:6px;max-width:100%;max-height:120px;overflow:auto;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);font-family:var(--dsw-font-family-code,monospace);font-size:11px;line-height:17px;text-align:left;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
`;

/**
 * Read the canvas the Host stored for an exact Session.
 *
 * @param {string} sessionId - the Session whose canvas is requested.
 * @param {AbortSignal} signal - cancels a superseded read.
 * @returns {Promise<{ snapshot: unknown, relativePath?: string, updatedAt?: number | null }>} the stored canvas.
 */
async function fetchCanvas(sessionId, signal) {
  const response = await fetch(`${ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, {
    signal,
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true) {
    throw new Error(body?.error ?? `HTTP ${String(response.status)}`);
  }
  return body;
}

/**
 * Replace the canvas stored for an exact Session.
 *
 * @param {string} sessionId - the Session whose canvas is saved.
 * @param {unknown} snapshot - the tldraw v1 document.
 * @param {{ keepalive?: boolean }} [options] - allow a best-effort save during unload.
 * @returns {Promise<{ relativePath?: string, updatedAt?: number }>} the Host's write receipt.
 */
async function putCanvas(sessionId, snapshot, options = {}) {
  const response = await fetch(`${ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sessionId, snapshot }),
    keepalive: options.keepalive === true,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true) {
    throw new Error(body?.error ?? `HTTP ${String(response.status)}`);
  }
  return body;
}

/**
 * Format the save time for the status bar.
 *
 * @param {number} time - epoch milliseconds.
 * @returns {string} a locale time.
 */
function formatTime(time) {
  try {
    return new Date(time).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/**
 * A fresh v1 document with its own page objects.
 *
 * @returns {Record<string, any>} a blank tldraw v1 document.
 */
function createBlankDocument() {
  if (TldrawApp.defaultDocument !== undefined) {
    return JSON.parse(JSON.stringify(TldrawApp.defaultDocument));
  }
  return {
    id: 'doc',
    name: 'Canvas',
    version: TldrawApp.version ?? 15.5,
    pages: {
      page: { id: 'page', name: 'Page 1', childIndex: 1, shapes: {}, bindings: {} },
    },
    pageStates: {
      page: { id: 'page', selectedIds: [], camera: { point: [0, 0], zoom: 1 } },
    },
    assets: {},
  };
}

/**
 * The guide artwork for this tab type. It inherits the host text color.
 *
 * @param {{ size?: number }} props - the guide's icon size.
 * @returns {import('react').ReactElement} an original canvas glyph.
 */
function TldrawGuideIcon({ size = 16 }) {
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 20 20',
      fill: 'none',
      'aria-hidden': 'true',
      style: { display: 'block' },
    },
    h('rect', {
      x: 2.25,
      y: 3,
      width: 15.5,
      height: 14,
      rx: 3,
      stroke: 'currentColor',
      strokeWidth: 1.4,
    }),
    h('path', {
      d: 'M5.4 12.6c1.25-2.8 2.5-4.3 3.6-4 1 .25.55 3 1.7 3.25.9.2 1.7-.8 2.45-1.75',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  );
}

/**
 * Keep an editor render failure inside this tab instead of blanking the slot.
 */
class CanvasBoundary extends React.Component {
  /**
   * @param {object} props - the translator and the canvas child.
   */
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  /**
   * @param {unknown} error - the render error.
   * @returns {{ error: unknown }} the captured error.
   */
  static getDerivedStateFromError(error) {
    return { error };
  }

  /** @returns {import('react').ReactElement} the canvas or a local failure notice. */
  render() {
    if (this.state.error !== null) {
      const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
      return h(
        'div',
        { className: 'dsh-tldraw-placeholder', 'data-dsh-tldraw-error': true },
        h('h2', null, this.props.t('renderFailed')),
        h('pre', { className: 'dsh-tldraw-error' }, message),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-tldraw-button',
            onClick: this.props.onRetry,
          },
          this.props.t('retry'),
        ),
      );
    }
    return this.props.children;
  }
}

/**
 * Render the persistent tldraw v1 canvas for one Session.
 *
 * @param {object} props - slot props, the locale translator, and the theme hook.
 * @returns {import('react').ReactElement} the tab body.
 */
function TldrawTab(props) {
  const { sessionId, t, useColorScheme } = props;
  const colorScheme = useColorScheme();

  const [load, setLoad] = React.useState({ status: 'loading' });
  const [reloadToken, setReloadToken] = React.useState(0);
  const [save, setSave] = React.useState({ state: 'idle', at: 0, path: '', error: '' });

  const appRef = React.useRef(null);
  const timerRef = React.useRef(0);
  const queueRef = React.useRef(Promise.resolve());
  const mountedRef = React.useRef(true);
  const readyRef = React.useRef(false);
  const dirtyRef = React.useRef(false);
  const currentRef = React.useRef({ path: '' });

  currentRef.current.path = load.status === 'ready' ? (load.relativePath ?? '') : '';

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== 0) {
        window.clearTimeout(timerRef.current);
        timerRef.current = 0;
      }
      if (!dirtyRef.current) return;
      const app = appRef.current;
      if (app === null) return;
      try {
        void putCanvas(sessionId, app.document, { keepalive: true }).catch(() => {});
      } catch {
        /* the page is going away; a failed best-effort save is not actionable */
      }
    };
  }, [sessionId]);

  React.useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    dirtyRef.current = false;
    readyRef.current = false;
    appRef.current = null;
    setSave({ state: 'idle', at: 0, path: '', error: '' });
    setLoad({ status: 'loading' });
    fetchCanvas(sessionId, controller.signal)
      .then((body) => {
        if (cancelled) return;
        let document;
        let migrated = false;
        let skipped = 0;
        if (isV1Document(body.snapshot)) {
          document = body.snapshot;
        } else if (isV5Snapshot(body.snapshot)) {
          const converted = convertLegacySnapshot(body.snapshot, TldrawApp.version ?? 15.5);
          document = converted.document;
          migrated = converted.converted > 0 || converted.skipped > 0;
          skipped = converted.skipped;
        } else {
          document = createBlankDocument();
        }
        setLoad({
          status: 'ready',
          document,
          relativePath: typeof body.relativePath === 'string' ? body.relativePath : '',
          updatedAt: typeof body.updatedAt === 'number' ? body.updatedAt : null,
          migrated,
          skipped,
        });
      })
      .catch((error) => {
        if (cancelled || error?.name === 'AbortError') return;
        setLoad({
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sessionId, reloadToken]);

  const saveDocument = React.useCallback(
    (document, options = {}) => {
      const targetSession = sessionId;
      setSave((previous) => ({ ...previous, state: 'saving', error: '' }));
      const run = async () => {
        const result = await putCanvas(targetSession, document, options);
        if (!mountedRef.current) return;
        dirtyRef.current = false;
        setSave({
          state: 'saved',
          at: typeof result.updatedAt === 'number' ? result.updatedAt : Date.now(),
          path: typeof result.relativePath === 'string' ? result.relativePath : currentRef.current.path,
          error: '',
        });
      };
      queueRef.current = queueRef.current.then(run, run).catch((error) => {
        if (!mountedRef.current) return;
        setSave((previous) => ({
          ...previous,
          state: 'error',
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    },
    [sessionId],
  );

  const scheduleSave = React.useCallback(() => {
    if (timerRef.current !== 0) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = 0;
      const app = appRef.current;
      if (app === null) return;
      try {
        saveDocument(app.document);
      } catch (error) {
        setSave((previous) => ({
          ...previous,
          state: 'error',
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }, 700);
  }, [saveDocument]);

  const onMount = React.useCallback((app) => {
    appRef.current = app;
    readyRef.current = true;
  }, []);

  const onPersist = React.useCallback(
    (app) => {
      appRef.current = app;
      if (!readyRef.current) return;
      dirtyRef.current = true;
      setSave((previous) =>
        previous.state === 'saving' ? previous : { ...previous, state: 'dirty', error: '' },
      );
      scheduleSave();
    },
    [scheduleSave],
  );

  const status =
    save.state === 'saved'
      ? `${t('saved')} ${formatTime(save.at)}`
      : save.state === 'saving'
        ? t('saving')
        : save.state === 'dirty'
          ? t('dirty')
          : save.state === 'error'
            ? t('saveFailed')
            : t('autosave');

  const relativePath = load.status === 'ready' ? (load.relativePath ?? '') : '';

  return h(
    'div',
    { className: 'dsh-tldraw', 'data-dsh-tldraw': sessionId },
    h('style', { key: 'plugin-styles' }, CSS),
    h(
      'div',
      { className: 'dsh-tldraw-bar' },
      h('span', {
        className: 'dsh-tldraw-dot',
        'data-state': save.state,
        'aria-hidden': 'true',
      }),
      h('span', { className: 'dsh-tldraw-label' }, status),
      load.status === 'ready' && load.migrated
        ? h(
            'span',
            {
              className: 'dsh-tldraw-note',
              title: load.skipped > 0 ? `${t('migratedTitle')} · ${t('skipped')}` : t('migratedTitle'),
            },
            t('migrated'),
          )
        : null,
      h('span', { className: 'dsh-tldraw-spacer' }),
      relativePath === ''
        ? null
        : h(
            'span',
            { className: 'dsh-tldraw-path', title: `${t('pathLabel')}: ${relativePath}` },
            relativePath,
          ),
    ),
    h(
      'div',
      { className: 'dsh-tldraw-canvas' },
      load.status === 'loading'
        ? h(
            'div',
            { className: 'dsh-tldraw-placeholder' },
            h('div', { className: 'dsh-tldraw-spinner', 'aria-hidden': 'true' }),
            h('p', null, t('loading')),
          )
        : load.status === 'error'
          ? h(
              'div',
              { className: 'dsh-tldraw-placeholder' },
              h('h2', null, t('loadFailed')),
              h('p', null, t('errorDetail')),
              h('pre', { className: 'dsh-tldraw-error' }, load.error),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-tldraw-button',
                  onClick: () => setReloadToken((value) => value + 1),
                },
                t('retry'),
              ),
            )
          : h(
              CanvasBoundary,
              {
                key: `${sessionId}:${String(reloadToken)}`,
                t,
                onRetry: () => setReloadToken((value) => value + 1),
              },
              h(Tldraw, {
                key: `${sessionId}:${String(reloadToken)}`,
                document: load.document,
                onMount,
                onPersist,
                autofocus: false,
                darkMode: colorScheme === 'dark',
                showMultiplayerMenu: false,
              }),
            ),
    ),
  );
}

/**
 * Register the right-sidebar tab type, its guide card, and its body.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - client plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tldraw: dictionaries');
  const t = ctx.locale.bind(NS);

  /**
   * A reactive theme reader shared with the tab body.
   *
   * @returns {'light' | 'dark'} the host's current color scheme.
   */
  const subscribeTheme = (listener) => ctx.on('theme/change', listener);
  const readColorScheme = () => ctx.theme.getTheme().active.colorScheme;
  const useColorScheme = () => React.useSyncExternalStore(subscribeTheme, readColorScheme);

  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        priority: 'extension',
        title: () => t('tab'),
        guide: [
          {
            id: 'canvas',
            order: 40,
            title: () => t('guideTitle'),
            description: () => t('guideDescription'),
            icon: TldrawGuideIcon,
          },
        ],
      }),
    'tldraw: sidebar tab type',
  );

  ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register(
      {
        name: 'sidebar.right.pane.tab',
        key: ID,
        locale: NS,
        inject: () => ({ useColorScheme }),
      },
      TldrawTab,
    ),
  );
}

export const inject = ['slots', 'locale', 'sidebarRightTabs', 'theme'];
