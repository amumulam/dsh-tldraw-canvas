import assert from 'node:assert/strict';
import test from 'node:test';
import {
  convertLegacySnapshot,
  decodeDrawPath,
  isV1Document,
  isV5Snapshot,
} from '../src/migrate.js';

function encode2DPath(points) {
  const buffer = Buffer.alloc(8 + (points.length - 1) * 4);
  buffer.writeFloatLE(points[0][0], 0);
  buffer.writeFloatLE(points[0][1], 4);
  let offset = 8;
  for (let index = 1; index < points.length; index += 1) {
    buffer.writeUInt16LE(Float16Bits(points[index][0] - points[index - 1][0]), offset);
    buffer.writeUInt16LE(Float16Bits(points[index][1] - points[index - 1][1]), offset + 2);
    offset += 4;
  }
  return buffer.toString('base64');
}

function Float16Bits(value) {
  if (value === 0) return 0;
  const sign = value < 0 ? 0x8000 : 0;
  const magnitude = Math.abs(value);
  const exponent = Math.floor(Math.log2(magnitude));
  const biased = exponent + 15;
  const fraction = Math.round((magnitude / 2 ** exponent - 1) * 1024);
  return sign | (biased << 10) | (fraction & 0x3ff);
}

test('decodes a 2D delta-encoded draw segment', () => {
  const path = encode2DPath([
    [0, 0],
    [1, 2],
    [3, 4],
  ]);
  assert.deepEqual(decodeDrawPath({ path, dim: 2 }), [
    [0, 0],
    [1, 2],
    [3, 4],
  ]);
});

test('recognizes v1 documents and v5 snapshots', () => {
  const v1 = { pages: { page: {} }, pageStates: { page: {} } };
  assert.equal(isV1Document(v1), true);
  assert.equal(isV5Snapshot(v1), false);
  const v5 = { document: { store: {} } };
  assert.equal(isV5Snapshot(v5), true);
  assert.equal(isV1Document(v5), false);
  assert.equal(isV1Document(null), false);
  assert.equal(isV5Snapshot({}), false);
});

test('converts freehand draw shapes and reports unsupported shapes', () => {
  const store = {
    'page:page': { id: 'page:page', type: 'page', name: 'Page 1' },
    'shape:a': {
      id: 'shape:a',
      type: 'draw',
      x: 10,
      y: 20,
      rotation: 0,
      props: {
        segments: [{ type: 'free', dim: 2, path: encode2DPath([[0, 0], [1, 2], [3, 4]]) }],
        color: 'black',
        size: 'm',
        dash: 'draw',
        fill: 'none',
      },
    },
    'shape:b': {
      id: 'shape:b',
      type: 'geo',
      x: 0,
      y: 0,
      props: {},
    },
  };
  const result = convertLegacySnapshot({ document: { store } }, 15.5);
  assert.equal(result.converted, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.document.version, 15.5);
  assert.deepEqual(result.document.pages.page.shapes['shape-1'].point, [10, 20]);
  assert.deepEqual(result.document.pages.page.shapes['shape-1'].points, [
    [0, 0],
    [1, 2],
    [3, 4],
  ]);
  assert.deepEqual(result.document.pages.page.shapes['shape-1'].style, {
    color: 'black',
    size: 'medium',
    dash: 'draw',
    isFilled: false,
    scale: 1,
  });
});

test('maps unknown style values to safe defaults', () => {
  const path = encode2DPath([[0, 0], [1, 2]]);
  const store = {
    'shape:a': {
      id: 'shape:a',
      type: 'draw',
      x: 0,
      y: 0,
      props: { segments: [{ path, dim: 2 }], color: 'lime', size: 'huge', dash: 'zigzag', fill: 'pattern' },
    },
  };
  const shape = convertLegacySnapshot({ document: { store } }, 15.5).document.pages.page.shapes['shape-1'];
  assert.equal(shape.style.color, 'black');
  assert.equal(shape.style.size, 'medium');
  assert.equal(shape.style.dash, 'draw');
  assert.equal(shape.style.isFilled, true);
});
