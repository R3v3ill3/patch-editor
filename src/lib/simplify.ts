import {
  simplify as turfSimplify,
  area as turfArea,
  pointToLineDistance,
  point,
  lineString,
  feature as turfFeature,
} from '@turf/turf';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';

// ── Simplify a patch geometry ───────────────────────────────────────

/**
 * Apply Ramer-Douglas-Peucker simplification to a MultiPolygon.
 * @param geometry The original MultiPolygon
 * @param tolerance Simplification tolerance in degrees (~0.00001 = ~1m)
 */
export function simplifyPatch(geometry: MultiPolygon, tolerance: number): MultiPolygon {
  const feat: Feature<MultiPolygon> = {
    type: 'Feature',
    geometry,
    properties: {},
  };

  const simplified = turfSimplify(feat, {
    tolerance,
    highQuality: true,
  }) as Feature<MultiPolygon>;

  return simplified.geometry;
}

// ── Compute comparison stats ────────────────────────────────────────

export interface SimplifyStats {
  originalVertexCount: number;
  simplifiedVertexCount: number;
  reductionPercent: number;
  maxDeviationMeters: number;
  areaChangePercent: number;
}

/**
 * Count total vertices across all rings of a MultiPolygon.
 */
function countVertices(geom: MultiPolygon): number {
  let count = 0;
  for (const polygon of geom.coordinates) {
    for (const ring of polygon) {
      // Subtract 1 for closing vertex if ring is closed
      const len = ring.length;
      if (len > 1 && ring[0][0] === ring[len - 1][0] && ring[0][1] === ring[len - 1][1]) {
        count += len - 1;
      } else {
        count += len;
      }
    }
  }
  return count;
}

/**
 * Compute stats comparing original to simplified geometry.
 */
export function computeSimplifyStats(
  original: MultiPolygon,
  simplified: MultiPolygon
): SimplifyStats {
  const originalVertexCount = countVertices(original);
  const simplifiedVertexCount = countVertices(simplified);
  const reductionPercent = originalVertexCount > 0
    ? ((originalVertexCount - simplifiedVertexCount) / originalVertexCount) * 100
    : 0;

  // Area change
  const origArea = turfArea(turfFeature(original));
  const simpArea = turfArea(turfFeature(simplified));
  const areaChangePercent = origArea > 0
    ? ((simpArea - origArea) / origArea) * 100
    : 0;

  // Max deviation: sample original vertices and find max distance to simplified edges
  const maxDeviationMeters = computeMaxDeviation(original, simplified);

  return {
    originalVertexCount,
    simplifiedVertexCount,
    reductionPercent,
    maxDeviationMeters,
    areaChangePercent,
  };
}

/**
 * Compute the maximum distance (in meters) between any original vertex
 * and the nearest edge of the simplified geometry.
 * Samples up to 500 original vertices for performance.
 */
function computeMaxDeviation(original: MultiPolygon, simplified: MultiPolygon): number {
  // Collect all original vertices
  const origVertices: Position[] = [];
  for (const polygon of original.coordinates) {
    for (const ring of polygon) {
      for (const pos of ring) {
        origVertices.push(pos);
      }
    }
  }

  // Collect simplified edges as line segments
  const simplifiedEdges: Position[][] = [];
  for (const polygon of simplified.coordinates) {
    for (const ring of polygon) {
      if (ring.length >= 2) {
        simplifiedEdges.push(ring);
      }
    }
  }

  if (simplifiedEdges.length === 0 || origVertices.length === 0) return 0;

  // Sample original vertices (max 500 for performance)
  const step = Math.max(1, Math.floor(origVertices.length / 500));
  let maxDev = 0;

  for (let i = 0; i < origVertices.length; i += step) {
    const pt = point(origVertices[i]);
    let minDist = Infinity;

    for (const edge of simplifiedEdges) {
      try {
        const line = lineString(edge);
        const dist = pointToLineDistance(pt, line, { units: 'meters' });
        if (dist < minDist) minDist = dist;
      } catch {
        // Skip invalid edges
      }
    }

    if (minDist < Infinity && minDist > maxDev) {
      maxDev = minDist;
    }
  }

  return maxDev;
}

// ── Vertex manipulation ─────────────────────────────────────────────

/**
 * Merge multiple vertices (by index) into their centroid.
 * Returns a new positions array with the merged result.
 */
export function mergeVertices(positions: Position[], indices: number[]): Position[] {
  if (indices.length < 2) return positions;

  const sorted = [...indices].sort((a, b) => a - b);

  // Compute centroid of selected vertices
  let sumLng = 0, sumLat = 0;
  for (const idx of sorted) {
    sumLng += positions[idx][0];
    sumLat += positions[idx][1];
  }
  const centroid: Position = [sumLng / sorted.length, sumLat / sorted.length];

  // Build new array: replace first index with centroid, remove the rest
  const removeSet = new Set(sorted.slice(1));
  const result: Position[] = [];
  for (let i = 0; i < positions.length; i++) {
    if (removeSet.has(i)) continue;
    if (i === sorted[0]) {
      result.push(centroid);
    } else {
      result.push(positions[i]);
    }
  }

  return result;
}

/**
 * Insert a new vertex after the given index.
 * Returns a new positions array with the inserted point.
 */
export function insertVertex(
  positions: Position[],
  afterIndex: number,
  position: Position
): Position[] {
  const result = [...positions];
  result.splice(afterIndex + 1, 0, position);
  return result;
}

// ── Suggested default tolerance ─────────────────────────────────────

/**
 * Find a tolerance that reduces vertex count to approximately the target.
 * Uses binary search over the tolerance range.
 */
export function findToleranceForTarget(
  geometry: MultiPolygon,
  targetVertices: number
): number {
  let lo = 0.0000001;
  let hi = 0.01;
  let bestTolerance = 0.0001;

  for (let i = 0; i < 20; i++) {
    const mid = Math.sqrt(lo * hi); // geometric midpoint (log scale)
    const simplified = simplifyPatch(geometry, mid);
    const count = countVertices(simplified);

    if (count > targetVertices) {
      lo = mid;
    } else {
      hi = mid;
      bestTolerance = mid;
    }

    // Close enough
    if (Math.abs(count - targetVertices) < targetVertices * 0.1) {
      bestTolerance = mid;
      break;
    }
  }

  return bestTolerance;
}
