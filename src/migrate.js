/**
 * Conversion helpers between the tldraw 5 snapshot kept by the first release
 * of this plugin and the MIT-licensed tldraw v1 document format.
 *
 * Only freehand `draw` shapes are converted; the old canvas in this workspace
 * contains those exclusively. Unsupported shapes are reported to the caller so
 * the UI can explain the partial migration instead of silently dropping them.
 */

const V1_COLORS = new Set([
  'white',
  'lightGray',
  'gray',
  'black',
  'green',
  'cyan',
  'blue',
  'indigo',
  'violet',
  'red',
  'orange',
  'yellow',
]);

const V1_SIZES = { s: 'small', m: 'medium', l: 'large', xl: 'large' };
const V1_DASHES = { draw: 'draw', solid: 'solid', dashed: 'dashed', dotted: 'dotted' };

/**
 * Whether a snapshot is already a tldraw v1 document.
 *
 * @param {unknown} value - a stored snapshot.
 * @returns {boolean} true for a v1 document.
 */
export function isV1Document(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.pages === 'object' &&
    value.pages !== null &&
    typeof value.pageStates === 'object' &&
    value.pageStates !== null
  );
}

/**
 * Whether a snapshot is the tldraw 5 format written by the first plugin release.
 *
 * @param {unknown} value - a stored snapshot.
 * @returns {boolean} true for a v5 editor snapshot.
 */
export function isV5Snapshot(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.document === 'object' &&
    value.document !== null &&
    typeof value.document.store === 'object' &&
    value.document.store !== null
  );
}

/**
 * Decode a base64 string in either the browser or Node.
 *
 * @param {string} value - base64 text.
 * @returns {Uint8Array} decoded bytes.
 */
function decodeBase64(value) {
  if (typeof atob === 'function') {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/**
 * Read a little-endian float16 without requiring `DataView.getFloat16`.
 *
 * @param {DataView} view - source bytes.
 * @param {number} offset - byte offset.
 * @returns {number} the decoded value.
 */
function readFloat16(view, offset) {
  if (typeof view.getFloat16 === 'function') return view.getFloat16(offset, true);
  const bits = view.getUint16(offset, true);
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/**
 * Decode one tldraw 5 draw segment path into local points.
 *
 * @param {{ path?: string, dim?: number }} segment - a stored draw segment.
 * @returns {number[][]} `[x, y]` points in the shape's local space.
 */
export function decodeDrawPath(segment) {
  if (typeof segment?.path !== 'string' || segment.path === '') return [];
  const bytes = decodeBase64(segment.path);
  if (bytes.length < 8) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const points = [];
  let x = view.getFloat32(0, true);
  let y = view.getFloat32(4, true);
  points.push([x, y]);
  if (segment.dim === 2) {
    for (let offset = 8; offset + 4 <= bytes.length; offset += 4) {
      x += readFloat16(view, offset);
      y += readFloat16(view, offset + 2);
      points.push([x, y]);
    }
    return points;
  }
  if (bytes.length < 12) return points;
  let z = view.getFloat32(8, true);
  for (let offset = 12; offset + 6 <= bytes.length; offset += 6) {
    x += readFloat16(view, offset);
    y += readFloat16(view, offset + 2);
    z += readFloat16(view, offset + 4);
    points.push([x, y]);
  }
  return points;
}

/**
 * Convert one tldraw 5 draw shape into a tldraw v1 draw shape.
 *
 * @param {Record<string, any>} shape - the v5 shape record.
 * @param {number} index - child index in the v1 page.
 * @returns {Record<string, any> | null} the converted shape, or null.
 */
function convertDrawShape(shape, index) {
  const segments = Array.isArray(shape?.props?.segments) ? shape.props.segments : [];
  const points = segments.flatMap((segment) => decodeDrawPath(segment));
  if (points.length < 2) return null;
  const color = V1_COLORS.has(shape.props.color) ? shape.props.color : 'black';
  const size = V1_SIZES[shape.props.size] ?? 'medium';
  const dash = V1_DASHES[shape.props.dash] ?? 'draw';
  return {
    id: `shape-${index}`,
    type: 'draw',
    name: 'Draw',
    parentId: 'page',
    childIndex: index,
    point: [Number(shape.x) || 0, Number(shape.y) || 0],
    rotation: Number(shape.rotation) || 0,
    style: {
      color,
      size,
      dash,
      isFilled: typeof shape.props.fill === 'string' && shape.props.fill !== 'none',
      scale: 1,
    },
    points,
    isComplete: true,
  };
}

/**
 * Convert a tldraw 5 snapshot into a v1 document.
 *
 * @param {unknown} snapshot - the stored v5 snapshot.
 * @param {number} version - `TldrawApp.version` of the installed v1 build.
 * @returns {{ document: Record<string, any>, converted: number, skipped: number }} the migration result.
 */
export function convertLegacySnapshot(snapshot, version) {
  const store = snapshot?.document?.store ?? {};
  const records = Object.values(store);
  const page = records.find((record) => record?.type === 'page') ?? { id: 'page', name: 'Page 1' };
  const shapes = {};
  let index = 1;
  let converted = 0;
  let skipped = 0;
  for (const record of records) {
    if (record?.type === 'draw' && typeof record.id === 'string' && record.id.startsWith('shape:')) {
      const shape = convertDrawShape(record, index);
      if (shape === null) {
        skipped += 1;
        continue;
      }
      shapes[shape.id] = shape;
      index += 1;
      converted += 1;
    } else if (typeof record?.id === 'string' && record.id.startsWith('shape:')) {
      skipped += 1;
    }
  }
  const document = {
    id: 'doc',
    name: typeof page.name === 'string' ? page.name : 'Canvas',
    version,
    pages: {
      page: {
        id: 'page',
        name: 'Page 1',
        childIndex: 1,
        shapes,
        bindings: {},
      },
    },
    pageStates: {
      page: {
        id: 'page',
        selectedIds: [],
        camera: { point: [0, 0], zoom: 1 },
      },
    },
    assets: {},
  };
  return { document, converted, skipped };
}
