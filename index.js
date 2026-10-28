import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { analyzeCanvas, renderCanvasPng } from './src/canvas-model.js';

/** Only ordinary Session ids may name a canvas file. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A canvas can embed images, so leave generous room while still bounding memory. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** One endpoint for both reading and saving the canvas of an exact Session. */
const ROUTE = '/api/tldraw';
/** Per-Session canvases live inside the Session's own working directory. */
const DIRECTORY = path.join('.dsh', 'tldraw');

/** A failure with an HTTP status for the route and a readable tool message. */
class CanvasError extends Error {
  /**
   * @param {number} status - HTTP status.
   * @param {string} message - user-facing reason.
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Resolve the Session's project directory. A Workspace is a named directory
 * plus a Session grouping, not an artifact bucket, and DSH records a
 * Session's project origin in its immutable `SessionHeader.cwd`. The effective
 * working directory may move later through `working_directory`; the canvas
 * deliberately stays anchored to the project origin so a `cd` cannot split one
 * Session's drawings across directories, and archived Sessions read the same
 * place as live ones.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} sessionId - the Session named by the browser.
 * @returns {Promise<string | undefined>} an absolute directory, or undefined.
 */
async function resolveCwd(ctx, sessionId) {
  const session = ctx.sessions.get(sessionId);
  if (session !== undefined) {
    if (typeof session.header.cwd === 'string' && session.header.cwd !== '') {
      return session.header.cwd;
    }
    const workingDirectory = ctx.get('workingDirectory');
    return workingDirectory?.get(session);
  }
  const persistence = ctx.get('sessionPersistence');
  if (persistence === undefined) return undefined;
  const snapshot = await persistence.stat(sessionId);
  return snapshot?.header.cwd;
}

/**
 * Write one JSON response without allowing caches to serve a stale canvas.
 *
 * @param {import('node:http').ServerResponse} res - the response to finish.
 * @param {number} status - HTTP status code.
 * @param {unknown} value - JSON-serialisable body.
 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', String(Buffer.byteLength(body)));
  res.end(body);
}

/**
 * Read a bounded JSON request body.
 *
 * @param {import('node:http').IncomingMessage} req - request carrying JSON.
 * @returns {Promise<unknown>} the parsed body.
 */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new CanvasError(413, '画布数据超过 64 MB 上限');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CanvasError(400, '请求内容不是合法的 JSON');
  }
}

/**
 * One storage view shared by the HTTP route, the `tldrawCanvas` service, and
 * the `tldraw_read_canvas` tool.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
function createCanvasStore(ctx) {
  /**
   * Resolve one Session's directory and canvas file.
   *
   * @param {string} sessionId - the Session to locate.
   * @returns {Promise<{ cwd: string, directory: string, file: string, relativePath: string }>} resolved paths.
   */
  async function locate(sessionId) {
    const cwd = await resolveCwd(ctx, sessionId);
    if (cwd === undefined) throw new CanvasError(404, '这个 Session 没有可用的工作目录');
    const info = await stat(cwd).catch(() => undefined);
    if (info?.isDirectory() !== true) throw new CanvasError(409, '这个 Session 的工作目录不存在');
    const directory = path.join(cwd, DIRECTORY);
    const file = path.join(directory, `${sessionId}.json`);
    return {
      cwd,
      directory,
      file,
      relativePath: path.relative(cwd, file).split(path.sep).join('/'),
    };
  }

  /**
   * Read one stored canvas.
   *
   * @param {string} sessionId - the Session to read.
   * @returns {Promise<{ snapshot: unknown, relativePath: string, updatedAt: number | null, format: string | null }>} stored state.
   */
  async function read(sessionId) {
    const paths = await locate(sessionId);
    let content;
    try {
      content = await readFile(paths.file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          snapshot: null,
          relativePath: paths.relativePath,
          updatedAt: null,
          format: null,
        };
      }
      throw error;
    }
    let record;
    try {
      record = JSON.parse(content);
    } catch {
      throw new CanvasError(500, `画布文件无法解析：${paths.relativePath}`);
    }
    return {
      snapshot: record?.snapshot ?? null,
      relativePath: paths.relativePath,
      updatedAt: typeof record?.updatedAt === 'number' ? record.updatedAt : null,
      format: typeof record?.format === 'string' ? record.format : null,
    };
  }

  /**
   * Atomically replace one stored canvas.
   *
   * @param {string} sessionId - the Session to write.
   * @param {unknown} snapshot - v1 document or legacy v5 snapshot.
   * @returns {Promise<{ relativePath: string, updatedAt: number }>} write receipt.
   */
  async function write(sessionId, snapshot) {
    const paths = await locate(sessionId);
    const updatedAt = Date.now();
    const isV1 = snapshot.pages !== undefined && snapshot.pageStates !== undefined;
    const text = JSON.stringify({
      version: 1,
      sessionId,
      updatedAt,
      format: isV1 ? 'tldraw-v1' : 'tldraw-v5',
      snapshot,
    });
    await mkdir(paths.directory, { recursive: true });
    if (isV1) {
      // Keep the first plugin release's v5 drawing beside the v1 document.
      try {
        const existing = JSON.parse(await readFile(paths.file, 'utf8'));
        if (existing?.snapshot?.document?.store !== undefined) {
          await copyFile(paths.file, path.join(paths.directory, `${sessionId}.v5.json`));
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    const temporary = `${paths.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text, 'utf8');
      await rename(temporary, paths.file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return { relativePath: paths.relativePath, updatedAt };
  }

  return { locate, read, write };
}

/**
 * Build the read-only capability shared by plugins and the agent tool.
 *
 * @param {ReturnType<typeof createCanvasStore>} store - storage view.
 * @returns {{ inspect(sessionId: string): Promise<Record<string, any>>, render(sessionId: string, options?: object): Promise<Record<string, any>> }} the service.
 */
function createCanvasService(store) {
  /**
   * @param {string} sessionId - the Session to inspect.
   * @returns {Promise<Record<string, any>>} normalized drawing description.
   */
  async function inspect(sessionId) {
    const record = await store.read(sessionId);
    const analysis = analyzeCanvas(record.snapshot);
    return {
      sessionId,
      path: record.relativePath,
      updatedAt: record.updatedAt,
      ...analysis,
    };
  }

  /**
   * @param {string} sessionId - the Session to render.
   * @param {{ maxSize?: number, padding?: number }} [options] - preview bounds.
   * @returns {Promise<{ analysis: Record<string, any>, png: { data: Buffer, width: number, height: number } | null }>} analysis and PNG.
   */
  async function render(sessionId, options = {}) {
    const analysis = await inspect(sessionId);
    return { analysis, png: renderCanvasPng(analysis, options) };
  }

  return { inspect, render };
}

/**
 * Format the compact text part of the read tool.
 *
 * @param {Record<string, any>} analysis - service inspection result.
 * @param {boolean} hasImage - whether a preview was attached.
 * @returns {string} the model-facing summary.
 */
function formatSummary(analysis, hasImage) {
  if (analysis.format === null) {
    return `No tldraw canvas has been saved for Session ${analysis.sessionId} yet.`;
  }
  const bounds = analysis.bounds;
  const where = bounds
    ? `bounds x=${bounds.x.toFixed(1)} y=${bounds.y.toFixed(1)} w=${bounds.width.toFixed(1)} h=${bounds.height.toFixed(1)}`
    : 'empty bounds';
  const lines = [
    `Session ${analysis.sessionId} canvas: ${analysis.path}`,
    `format=${analysis.format}; pages=${analysis.pageCount}; shapes=${analysis.shapeCount}; strokes=${analysis.strokeCount}; text=${analysis.textCount}; other=${analysis.otherCount}; points=${analysis.pointCount}; ${where}.`,
  ];
  if (analysis.migrated) {
    lines.push(
      `Migrated from the legacy tldraw v5 format${analysis.skipped > 0 ? `; ${analysis.skipped} unsupported shape(s) were skipped` : ''}.`,
    );
  }
  const listed = analysis.shapes.slice(0, 40);
  for (const shape of listed) {
    if (shape.type === 'draw') {
      lines.push(
        `- draw ${shape.id} on ${shape.pageId}: ${shape.points} point(s), ${shape.color}/${shape.size}, x=${shape.bounds.x.toFixed(1)} y=${shape.bounds.y.toFixed(1)} w=${shape.bounds.width.toFixed(1)} h=${shape.bounds.height.toFixed(1)}`,
      );
    } else if (shape.type === 'text') {
      lines.push(`- text ${shape.id} on ${shape.pageId}: ${JSON.stringify(shape.text)}`);
    } else {
      lines.push(`- ${shape.type} ${shape.id} on ${shape.pageId}: not drawn by this preview`);
    }
  }
  if (analysis.shapes.length > listed.length) {
    lines.push(`- … ${analysis.shapes.length - listed.length} more shape(s)`);
  }
  if (hasImage) lines.push('A PNG preview is attached.');
  return lines.join('\n');
}

/**
 * Build the raw agent tool definition. The tool is intentionally read-only and
 * calls the same `tldrawCanvas` service that other Host plugins can consume.
 *
 * @param {{ inspect(sessionId: string): Promise<Record<string, any>>, render(sessionId: string, options?: object): Promise<Record<string, any>> }} canvasService - read service.
 * @param {() => any} getAttachments - lazy attachment service lookup.
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition} the tool definition.
 */
function createReadTool(canvasService, getAttachments) {
  const imageSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      attachmentId: { type: 'string' },
      mediaType: { type: 'string' },
      bytes: { type: 'integer' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      name: { type: 'string' },
    },
  };
  const shapeSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      pageId: { type: 'string' },
      type: { type: 'string' },
      color: { type: 'string' },
      size: { type: 'string' },
      points: { type: 'integer' },
      text: { type: 'string' },
      bounds: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
      },
    },
  };
  return {
    name: 'tldraw_read_canvas',
    description:
      'Read the tldraw canvas saved for a Session and return a structured shape summary plus an optional PNG preview. Use this instead of parsing .dsh/tldraw JSON files by hand. Defaults to the calling Session.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id; omit to read the calling Session.',
        },
        include_preview: {
          type: 'boolean',
          description: 'Render a PNG preview for visual inspection (default true).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string' },
          session_id: { type: 'string' },
          path: { type: 'string' },
          format: { type: 'string' },
          shape_count: { type: 'integer' },
          stroke_count: { type: 'integer' },
          text_count: { type: 'integer' },
          point_count: { type: 'integer' },
          bounds: {
            type: 'object',
            additionalProperties: false,
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
          },
          shapes: { type: 'array', items: shapeSchema },
          image: imageSchema,
        },
      },
      render(_args, value) {
        const blocks = [{ type: 'text', text: value.summary }];
        if (value.image !== undefined) {
          blocks.push({ type: 'image', attachment: value.image });
        }
        return blocks;
      },
      presentationMeta(_args, value) {
        return { path: value.path, sessionId: value.session_id };
      },
    },
    isConcurrencySafe: () => true,
    presentCall(args) {
      return {
        card: 'generic',
        title: `Read tldraw canvas${args.session_id ? ` ${args.session_id}` : ''}`,
        kind: 'read',
      };
    },
    async execute(args, exec) {
      const sessionId = (args.session_id ?? exec.agent?.id ?? '').trim();
      if (sessionId === '') {
        throw new Error('tldraw_read_canvas requires a Session; pass session_id or call it from a Session.');
      }
      const inspection = await canvasService.inspect(sessionId);
      let image;
      if (args.include_preview !== false) {
        const rendered = renderCanvasPng(inspection);
        const attachments = getAttachments();
        if (rendered !== null && attachments !== undefined) {
          const ref = await attachments.saveImage({
            data: rendered.data,
            mediaType: 'image/png',
            name: `${sessionId}-tldraw.png`,
          });
          image = {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name === undefined ? {} : { name: ref.name }),
          };
        }
      }
      const summary = formatSummary(inspection, image !== undefined);
      return {
        summary,
        session_id: inspection.sessionId,
        path: inspection.path,
        format: inspection.format ?? 'none',
        shape_count: inspection.shapeCount,
        stroke_count: inspection.strokeCount,
        text_count: inspection.textCount,
        point_count: inspection.pointCount,
        bounds: inspection.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
        shapes: inspection.shapes.map((shape) => ({
          id: shape.id,
          pageId: shape.pageId,
          type: shape.type,
          ...(shape.color === undefined ? {} : { color: shape.color }),
          ...(shape.size === undefined ? {} : { size: shape.size }),
          ...(shape.points === undefined ? {} : { points: shape.points }),
          ...(shape.text === undefined ? {} : { text: shape.text }),
          ...(shape.bounds === undefined ? {} : { bounds: shape.bounds }),
        })),
        ...(image === undefined ? {} : { image }),
      };
    },
  };
}

/**
 * Host half: the canvas route, the reusable `tldrawCanvas` read service, and
 * the `tldraw_read_canvas` agent tool.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  const store = createCanvasStore(ctx);
  const canvasService = createCanvasService(store);

  ctx.effect(
    () => ctx.provide('tldrawCanvas', canvasService),
    'tldraw: read service',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        async handler(req, res) {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            let sessionId = url.searchParams.get('sessionId') ?? '';
            const body = req.method === 'PUT' ? await readJson(req) : undefined;
            if (sessionId === '' && body !== null && typeof body === 'object' && typeof body.sessionId === 'string') {
              sessionId = body.sessionId;
            }
            if (!SESSION_ID.test(sessionId)) throw new CanvasError(400, '缺少或非法的 sessionId');

            if (req.method === 'GET') {
              const result = await store.read(sessionId);
              const webApp = ctx.get('webApp');
              let webUrl = null;
              try {
                webUrl = webApp?.getAdvertisedUrl() ?? null;
              } catch {
                webUrl = null;
              }
              sendJson(res, 200, {
                ok: true,
                snapshot: result.snapshot,
                relativePath: result.relativePath,
                updatedAt: result.updatedAt,
                format: result.format,
                webUrl,
              });
              return;
            }

            if (req.method !== 'PUT') {
              res.setHeader('allow', 'GET, PUT');
              throw new CanvasError(405, '只支持 GET 和 PUT');
            }

            if (
              body === null ||
              typeof body !== 'object' ||
              body.sessionId !== sessionId ||
              body.snapshot === null ||
              typeof body.snapshot !== 'object' ||
              Array.isArray(body.snapshot)
            ) {
              throw new CanvasError(400, '请求缺少合法的画布快照');
            }

            const result = await store.write(sessionId, body.snapshot);
            sendJson(res, 200, { ok: true, ...result });
          } catch (error) {
            const status = typeof error?.status === 'number' ? error.status : 500;
            sendJson(res, status, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
    'tldraw: canvas persistence route',
  );

  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(
      () => toolsCtx.tools.register(createReadTool(canvasService, () => ctx.get('attachments'))),
      'tldraw: read canvas tool',
    );
  });
}

export const inject = ['sessions', 'webServer'];
