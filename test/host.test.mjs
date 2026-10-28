import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { apply } from '../index.js';

const SESSION = 'session-test-0001';
const OTHER_SESSION = 'session-test-0002';

function makeHarness(cwd, options = {}) {
  const live = options.live !== false;
  const withWebApp = options.withWebApp !== false;
  let handler;
  let registeredTool;
  const provided = {};
  const attachments = options.withAttachments === false ? undefined : {
    saveImage: async (input) => ({
      attachmentId: 'attachment-1',
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 10,
      height: 20,
      name: input.name,
    }),
  };
  const disposers = [];
  const ctx = {
    sessions: {
      get: (id) => (live && id === SESSION ? { id, header: { cwd } } : undefined),
    },
    get: (name) => {
      if (name === 'workingDirectory') return { get: () => cwd };
      if (name === 'sessionPersistence') {
        return {
          stat: async (id) =>
            id === SESSION ? { header: { cwd } } : undefined,
        };
      }
      if (name === 'webApp' && withWebApp) {
        return { getAdvertisedUrl: () => 'http://127.0.0.1:52128' };
      }
      if (name === 'attachments') return attachments;
      return undefined;
    },
    webServer: {
      register: (route) => {
        handler = route.handler;
        const dispose = () => {
          handler = undefined;
        };
        disposers.push(dispose);
        return dispose;
      },
    },
    tools: {
      register: (definition) => {
        registeredTool = definition;
        const dispose = () => {
          registeredTool = undefined;
        };
        disposers.push(dispose);
        return dispose;
      },
    },
    inject: (dependencies, callback) => {
      if (dependencies.includes('tools')) callback(ctx);
      return () => {};
    },
    provide: (name, value) => {
      provided[name] = value;
      const dispose = () => {
        delete provided[name];
      };
      disposers.push(dispose);
      return dispose;
    },
    effect: (callback) => {
      const dispose = callback();
      disposers.push(dispose);
      return dispose;
    },
  };
  apply(ctx);
  assert.equal(typeof handler, 'function');
  return {
    call: (method, url, body) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
      req.method = method;
      req.url = url;
      const response = {
        statusCode: 0,
        headers: {},
        body: '',
        setHeader(name, value) {
          this.headers[name.toLowerCase()] = value;
        },
        end(chunk) {
          this.body += chunk ?? '';
        },
      };
      return Promise.resolve(handler(req, response)).then(() => response);
    },
    service: provided.tldrawCanvas,
    tool: registeredTool,
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose?.();
    },
  };
}

async function readJson(response) {
  assert.match(response.headers['content-type'], /application\/json/);
  return JSON.parse(response.body);
}

test('serves a fresh canvas, saves a snapshot, and reads it back', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-tldraw-host-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const harness = makeHarness(cwd);
  t.after(harness.dispose);

  const fresh = await harness.call('GET', `/api/tldraw?sessionId=${SESSION}`);
  assert.equal(fresh.statusCode, 200);
  const freshBody = await readJson(fresh);
  assert.equal(freshBody.ok, true);
  assert.equal(freshBody.snapshot, null);
  assert.equal(freshBody.relativePath, `.dsh/tldraw/${SESSION}.json`);
  assert.equal(freshBody.webUrl, 'http://127.0.0.1:52128');

  const snapshot = { document: { store: { 'shape:a': { id: 'shape:a' } } }, session: { version: 1 } };
  const saved = await harness.call(
    'PUT',
    `/api/tldraw?sessionId=${SESSION}`,
    JSON.stringify({ sessionId: SESSION, snapshot }),
  );
  assert.equal(saved.statusCode, 200);
  const savedBody = await readJson(saved);
  assert.equal(savedBody.ok, true);
  assert.equal(typeof savedBody.updatedAt, 'number');

  const file = path.join(cwd, '.dsh', 'tldraw', `${SESSION}.json`);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.version, 1);
  assert.equal(stored.sessionId, SESSION);
  assert.deepEqual(stored.snapshot, snapshot);

  const loaded = await harness.call('GET', `/api/tldraw?sessionId=${SESSION}`);
  const loadedBody = await readJson(loaded);
  assert.equal(loaded.statusCode, 200);
  assert.deepEqual(loadedBody.snapshot, snapshot);
  assert.equal(loadedBody.updatedAt, savedBody.updatedAt);

  const entries = await readdir(path.join(cwd, '.dsh', 'tldraw'));
  assert.deepEqual(entries, [`${SESSION}.json`]);
});

test('exposes a reusable read service and the tldraw_read_canvas tool', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-tldraw-host-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const harness = makeHarness(cwd);
  t.after(harness.dispose);

  const document = {
    id: 'doc',
    name: 'Page 1',
    version: 15.5,
    pages: {
      page: {
        id: 'page',
        name: 'Page 1',
        childIndex: 1,
        shapes: {
          'shape-1': {
            id: 'shape-1',
            type: 'draw',
            name: 'Draw',
            parentId: 'page',
            childIndex: 1,
            point: [10, 20],
            rotation: 0,
            style: { color: 'black', size: 'medium', dash: 'draw', isFilled: false, scale: 1 },
            points: [[0, 0], [5, 5], [10, 10]],
            isComplete: true,
          },
        },
        bindings: {},
      },
    },
    pageStates: {
      page: { id: 'page', selectedIds: [], camera: { point: [0, 0], zoom: 1 } },
    },
    assets: {},
  };
  const saved = await harness.call(
    'PUT',
    `/api/tldraw?sessionId=${SESSION}`,
    JSON.stringify({ sessionId: SESSION, snapshot: document }),
  );
  assert.equal(saved.statusCode, 200);

  assert.equal(typeof harness.service?.inspect, 'function');
  const inspection = await harness.service.inspect(SESSION);
  assert.equal(inspection.format, 'tldraw-v1');
  assert.equal(inspection.shapeCount, 1);
  assert.equal(inspection.strokeCount, 1);
  assert.equal(inspection.pointCount, 3);
  assert.equal(inspection.bounds.x, 10);
  assert.equal(inspection.bounds.y, 20);

  const rendered = await harness.service.render(SESSION);
  assert.equal(rendered.png.width > 0, true);
  assert.equal(rendered.png.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  assert.equal(harness.tool?.name, 'tldraw_read_canvas');
  const result = await harness.tool.execute({ session_id: SESSION }, { agent: { id: SESSION } });
  assert.equal(result.shape_count, 1);
  assert.match(result.summary, /strokes=1/);
  assert.equal(result.image.mediaType, 'image/png');
  const blocks = harness.tool.output.render({}, result);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[1].type, 'image');
  assert.equal(blocks[1].attachment.attachmentId, 'attachment-1');
});

test('falls back to the persisted header for a session that is not live', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-tldraw-host-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const harness = makeHarness(cwd, { live: false });
  t.after(harness.dispose);
  const snapshot = { document: { store: {} }, session: { version: 1 } };

  const saved = await harness.call(
    'PUT',
    `/api/tldraw?sessionId=${SESSION}`,
    JSON.stringify({ sessionId: SESSION, snapshot }),
  );
  assert.equal(saved.statusCode, 200);
  const loaded = await harness.call('GET', `/api/tldraw?sessionId=${SESSION}`);
  assert.equal(loaded.statusCode, 200);
  assert.deepEqual((await readJson(loaded)).snapshot, snapshot);
});

test('still maps the canvas path when the browser URL is unavailable', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-tldraw-host-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const harness = makeHarness(cwd, { withWebApp: false });
  t.after(harness.dispose);

  const response = await harness.call('GET', `/api/tldraw?sessionId=${SESSION}`);
  assert.equal(response.statusCode, 200);
  assert.equal((await readJson(response)).webUrl, null);
});

test('backs up a legacy v5 drawing when the first v1 document is saved', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-tldraw-host-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const harness = makeHarness(cwd);
  t.after(harness.dispose);

  const directory = path.join(cwd, '.dsh', 'tldraw');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${SESSION}.json`);
  const legacy = { version: 1, sessionId: SESSION, updatedAt: 1, snapshot: { document: { store: {} } } };
  await writeFile(file, JSON.stringify(legacy), 'utf8');

  const document = {
    id: 'doc',
    name: 'Page 1',
    version: 15.5,
    pages: { page: { id: 'page', name: 'Page 1', childIndex: 1, shapes: {}, bindings: {} } },
    pageStates: { page: { id: 'page', selectedIds: [], camera: { point: [0, 0], zoom: 1 } } },
    assets: {},
  };
  const saved = await harness.call(
    'PUT',
    `/api/tldraw?sessionId=${SESSION}`,
    JSON.stringify({ sessionId: SESSION, snapshot: document }),
  );
  assert.equal(saved.statusCode, 200);

  const backup = JSON.parse(await readFile(path.join(directory, `${SESSION}.v5.json`), 'utf8'));
  assert.deepEqual(backup.snapshot, legacy.snapshot);
  const current = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(current.format, 'tldraw-v1');
  assert.deepEqual(current.snapshot, document);
});

test('accepts the sessionId from a PUT body and rejects a mismatch', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-tldraw-host-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const harness = makeHarness(cwd);
  t.after(harness.dispose);
  const snapshot = { document: { store: {} }, session: { version: 1 } };

  const fromBody = await harness.call(
    'PUT',
    '/api/tldraw',
    JSON.stringify({ sessionId: SESSION, snapshot }),
  );
  assert.equal(fromBody.statusCode, 200);

  const mismatch = await harness.call(
    'PUT',
    `/api/tldraw?sessionId=${SESSION}`,
    JSON.stringify({ sessionId: OTHER_SESSION, snapshot }),
  );
  assert.equal(mismatch.statusCode, 400);
});

test('rejects invalid ids, unknown sessions, missing directories, and bad payloads', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-tldraw-host-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const harness = makeHarness(cwd);
  t.after(harness.dispose);

  for (const id of ['../escape', '', 'a/b', 'x'.repeat(200)]) {
    const response = await harness.call('GET', `/api/tldraw?sessionId=${encodeURIComponent(id)}`);
    assert.equal(response.statusCode, 400, id);
  }

  const unknown = await harness.call('GET', `/api/tldraw?sessionId=${OTHER_SESSION}`);
  assert.equal(unknown.statusCode, 404);

  const missingDirectory = makeHarness('/definitely/not/a/real/dsh/directory');
  t.after(missingDirectory.dispose);
  const missing = await missingDirectory.call('GET', `/api/tldraw?sessionId=${SESSION}`);
  assert.equal(missing.statusCode, 409);

  const invalidJson = await harness.call(
    'PUT',
    `/api/tldraw?sessionId=${SESSION}`,
    '{not json',
  );
  assert.equal(invalidJson.statusCode, 400);

  const invalidShape = await harness.call(
    'PUT',
    `/api/tldraw?sessionId=${SESSION}`,
    JSON.stringify({ sessionId: SESSION, snapshot: null }),
  );
  assert.equal(invalidShape.statusCode, 400);

  const wrongMethod = await harness.call('POST', `/api/tldraw?sessionId=${SESSION}`);
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.allow, 'GET, PUT');
});

test('reports an unreadable canvas file instead of silently starting over', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-tldraw-host-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const harness = makeHarness(cwd);
  t.after(harness.dispose);

  const directory = path.join(cwd, '.dsh', 'tldraw');
  await writeFile(path.join(directory, `${SESSION}.json`), '{broken', 'utf8').catch(async (error) => {
    if (error.code !== 'ENOENT') throw error;
    const { mkdir } = await import('node:fs/promises');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${SESSION}.json`), '{broken', 'utf8');
  });

  const response = await harness.call('GET', `/api/tldraw?sessionId=${SESSION}`);
  assert.equal(response.statusCode, 500);
  const body = await readJson(response);
  assert.equal(body.ok, false);
});

test('concurrent saves leave one complete JSON document and no temporary files', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-tldraw-host-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const harness = makeHarness(cwd);
  t.after(harness.dispose);

  const snapshots = Array.from({ length: 8 }, (_, index) => ({
    document: { store: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`s${i}`, { index }])) },
    session: { version: 1 },
  }));
  const responses = await Promise.all(
    snapshots.map((snapshot) =>
      harness.call('PUT', `/api/tldraw?sessionId=${SESSION}`, JSON.stringify({ sessionId: SESSION, snapshot })),
    ),
  );
  assert.ok(responses.every((response) => response.statusCode === 200));

  const directory = path.join(cwd, '.dsh', 'tldraw');
  const entries = await readdir(directory);
  assert.deepEqual(entries, [`${SESSION}.json`]);
  const stored = JSON.parse(await readFile(path.join(directory, entries[0]), 'utf8'));
  assert.equal(stored.snapshot.session.version, 1);
  assert.equal(Object.keys(stored.snapshot.document.store).length, 50);
});

test('rejects an oversized JSON body with 413', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-tldraw-host-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const harness = makeHarness(cwd);
  t.after(harness.dispose);

  const oversized = `\{"sessionId":"${SESSION}","snapshot":\{"padding":"${'x'.repeat(65 * 1024 * 1024)}"\}\}`;
  const response = await harness.call('PUT', `/api/tldraw?sessionId=${SESSION}`, oversized);
  assert.equal(response.statusCode, 413);
  assert.equal((await readJson(response)).ok, false);
});
