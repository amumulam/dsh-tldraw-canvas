import { deflateSync } from 'node:zlib';
import { convertLegacySnapshot, isV1Document, isV5Snapshot } from './migrate.js';

/** v1 palette used by the simple preview renderer. */
const COLORS = {
  white: '#f7f7f7',
  lightGray: '#d9d9d9',
  gray: '#9a9a9a',
  black: '#1f1f1f',
  green: '#3f9b48',
  cyan: '#1495a8',
  blue: '#3178c6',
  indigo: '#4d5dc7',
  violet: '#8b5cf6',
  red: '#d64545',
  orange: '#e07a24',
  yellow: '#d1a51d',
};

/** Stroke widths for v1's three size names, in canvas units. */
const WIDTHS = { small: 2, medium: 3.5, large: 5 };

/**
 * Normalize either supported storage format into one read-only view.
 *
 * @param {unknown} snapshot - a v1 document or a legacy v5 snapshot.
 * @returns {{
 *   format: 'tldraw-v1' | 'tldraw-v5' | null,
 *   pageCount: number,
 *   shapeCount: number,
 *   strokeCount: number,
 *   textCount: number,
 *   otherCount: number,
 *   pointCount: number,
 *   bounds: { x: number, y: number, width: number, height: number } | null,
 *   shapes: Array<Record<string, any>>,
 *   strokes: Array<{ points: number[][], color: string, width: number }>,
 *   migrated: boolean,
 *   skipped: number,
 * }} the normalized drawing description.
 */
export function analyzeCanvas(snapshot) {
  let document;
  let format = null;
  let migrated = false;
  let skipped = 0;
  if (isV1Document(snapshot)) {
    document = snapshot;
    format = 'tldraw-v1';
  } else if (isV5Snapshot(snapshot)) {
    const converted = convertLegacySnapshot(snapshot, 15.5);
    document = converted.document;
    format = 'tldraw-v5';
    migrated = converted.converted > 0;
    skipped = converted.skipped;
  } else {
    return {
      format: null,
      pageCount: 0,
      shapeCount: 0,
      strokeCount: 0,
      textCount: 0,
      otherCount: 0,
      pointCount: 0,
      bounds: null,
      shapes: [],
      strokes: [],
      migrated: false,
      skipped: 0,
    };
  }

  const shapes = [];
  const strokes = [];
  let textCount = 0;
  let otherCount = 0;
  let pointCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const pages = document.pages ?? {};
  for (const [pageId, page] of Object.entries(pages)) {
    for (const [shapeId, shape] of Object.entries(page?.shapes ?? {})) {
      const point = Array.isArray(shape.point) ? shape.point : [0, 0];
      const baseX = Number(point[0]) || 0;
      const baseY = Number(point[1]) || 0;
      if (shape.type === 'draw' && Array.isArray(shape.points) && shape.points.length > 0) {
        const points = shape.points.map((entry) => [
          baseX + (Number(entry?.[0]) || 0),
          baseY + (Number(entry?.[1]) || 0),
        ]);
        let sx = Infinity;
        let sy = Infinity;
        let ex = -Infinity;
        let ey = -Infinity;
        for (const [x, y] of points) {
          if (x < sx) sx = x;
          if (y < sy) sy = y;
          if (x > ex) ex = x;
          if (y > ey) ey = y;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
        const color = COLORS[shape.style?.color] ?? COLORS.black;
        const width = WIDTHS[shape.style?.size] ?? WIDTHS.medium;
        strokes.push({ points, color, width });
        pointCount += points.length;
        shapes.push({
          id: shapeId,
          pageId,
          type: 'draw',
          color: shape.style?.color ?? 'black',
          size: shape.style?.size ?? 'medium',
          points: points.length,
          bounds: { x: sx, y: sy, width: ex - sx, height: ey - sy },
        });
      } else if (shape.type === 'text' && typeof shape.text === 'string') {
        textCount += 1;
        shapes.push({
          id: shapeId,
          pageId,
          type: 'text',
          color: shape.style?.color ?? 'black',
          size: shape.style?.size ?? 'medium',
          text: shape.text,
          bounds: { x: baseX, y: baseY, width: 0, height: 0 },
        });
        if (baseX < minX) minX = baseX;
        if (baseY < minY) minY = baseY;
        if (baseX > maxX) maxX = baseX;
        if (baseY > maxY) maxY = baseY;
      } else {
        otherCount += 1;
        shapes.push({
          id: shapeId,
          pageId,
          type: typeof shape.type === 'string' ? shape.type : 'unknown',
        });
      }
    }
  }

  return {
    format,
    pageCount: Object.keys(pages).length,
    shapeCount: shapes.length,
    strokeCount: strokes.length,
    textCount,
    otherCount,
    pointCount,
    bounds:
      minX === Infinity
        ? null
        : { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    shapes,
    strokes,
    migrated,
    skipped,
  };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

/**
 * @param {Buffer} buffer - chunk payload.
 * @returns {number} CRC32.
 */
function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/**
 * @param {string} type - four-character chunk type.
 * @param {Buffer} data - chunk payload.
 * @returns {Buffer} one PNG chunk.
 */
function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

/**
 * @param {Uint8Array} pixels - RGBA raster.
 * @param {number} width - raster width.
 * @param {number} height - raster height.
 * @returns {Buffer} an encoded PNG.
 */
function encodePng(pixels, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Render a normalized drawing to a white-background PNG.
 *
 * @param {ReturnType<typeof analyzeCanvas>} analysis - normalized drawing.
 * @param {{ maxSize?: number, padding?: number }} [options] - preview bounds.
 * @returns {{ data: Buffer, width: number, height: number } | null} the PNG, or null when there is no geometry.
 */
export function renderCanvasPng(analysis, options = {}) {
  const strokes = analysis.strokes ?? [];
  if (strokes.length === 0) return null;
  const padding = options.padding ?? 24;
  const maxSize = options.maxSize ?? 1200;
  const bounds = analysis.bounds ?? { x: 0, y: 0, width: 1, height: 1 };
  const contentWidth = Math.max(1, bounds.width);
  const contentHeight = Math.max(1, bounds.height);
  const scale = Math.min(
    3,
    maxSize / (contentWidth + padding * 2),
    maxSize / (contentHeight + padding * 2),
  );
  const width = Math.max(1, Math.ceil((contentWidth + padding * 2) * scale));
  const height = Math.max(1, Math.ceil((contentHeight + padding * 2) * scale));
  const pixels = new Uint8Array(width * height * 4);
  pixels.fill(255);
  const radiusBase = 1;

  const plot = (cx, cy, radius, color) => {
    const r = Math.max(radiusBase, Math.round(radius));
    const minX = Math.max(0, Math.floor(cx - r));
    const maxX = Math.min(width - 1, Math.ceil(cx + r));
    const minY = Math.max(0, Math.floor(cy - r));
    const maxY = Math.min(height - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        const offset = (y * width + x) * 4;
        pixels[offset] = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
        pixels[offset + 3] = 255;
      }
    }
  };

  for (const stroke of strokes) {
    const rgb = /^#([0-9a-f]{6})$/i.exec(stroke.color);
    const color = rgb
      ? [parseInt(rgb[1].slice(0, 2), 16), parseInt(rgb[1].slice(2, 4), 16), parseInt(rgb[1].slice(4, 6), 16)]
      : [31, 31, 31];
    const radius = Math.max(radiusBase, (stroke.width * scale) / 2);
    const points = stroke.points;
    if (points.length === 1) {
      const x = (points[0][0] - bounds.x + padding) * scale;
      const y = (points[0][1] - bounds.y + padding) * scale;
      plot(x, y, radius, color);
      continue;
    }
    for (let index = 1; index < points.length; index += 1) {
      const [x0, y0] = points[index - 1];
      const [x1, y1] = points[index];
      const sx = (x0 - bounds.x + padding) * scale;
      const sy = (y0 - bounds.y + padding) * scale;
      const ex = (x1 - bounds.x + padding) * scale;
      const ey = (y1 - bounds.y + padding) * scale;
      const distance = Math.hypot(ex - sx, ey - sy);
      const steps = Math.max(1, Math.ceil(distance * 2));
      for (let step = 0; step <= steps; step += 1) {
        const ratio = step / steps;
        plot(sx + (ex - sx) * ratio, sy + (ey - sy) * ratio, radius, color);
      }
    }
  }

  return { data: encodePng(pixels, width, height), width, height };
}
