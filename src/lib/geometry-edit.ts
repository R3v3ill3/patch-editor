import {
  booleanPointInPolygon,
  distance,
  point,
  difference,
  intersect,
  area,
  feature as turfFeature,
} from '@turf/turf';
import type { Position, Polygon, MultiPolygon, Feature } from 'geojson';
import type { PatchFeature } from '@/types';

// ── Types ───────────────────────────────────────────────────────────

export interface EditRegionInfo {
  /** The sub-ring of vertices to edit (includes anchor vertices at each end) */
  editablePositions: Position[];
  /** Index of the first extracted vertex in the original ring */
  startIndex: number;
  /** Index of the last extracted vertex in the original ring */
  endIndex: number;
  /** Which ring of the polygon (0 = outer ring) */
  ringIndex: number;
  /** Which polygon of the MultiPolygon */
  polygonIndex: number;
  /** How many anchor vertices at the start (not draggable) */
  anchorCountStart: number;
  /** How many anchor vertices at the end (not draggable) */
  anchorCountEnd: number;
  /** The original positions before editing (for adjacency detection) */
  originalPositions: Position[];
}

export interface AdjacentPatchInfo {
  patchId: string;
  patchCode: string;
  /** Indices of shared segment in the neighbour's geometry */
  startIndex: number;
  endIndex: number;
  ringIndex: number;
  polygonIndex: number;
  /** Indices of shared segment in the edited patch ring */
  editedStartIndex: number;
  editedEndIndex: number;
  editedRingIndex: number;
  editedPolygonIndex: number;
  /** Number of consecutively matched vertices */
  matchedVertexCount: number;
  /** Whether the shared segment runs in reverse direction */
  isReversed: boolean;
}

export type SnapQuality = 'good' | 'poor';

export interface BoundaryProposal {
  patchId: string;
  patchCode: string;
  relationship: 'gap' | 'overlap' | 'aligned';
  adjacentInfo: AdjacentPatchInfo;
  originalGeometry: MultiPolygon;
  proposedGeometry: MultiPolygon;
  /** The original shared segment on the neighbor */
  originalSegment: Position[];
  /** The proposed shared segment on the edited boundary */
  proposedSegment: Position[];
  /** The new segment that will replace the old */
  changedSegment: Position[];
  /** Where new segment connects to unchanged boundary */
  connectionPoints: {
    start: Position;
    end: Position;
  };
  /** Quality metric based on connection angle/distance */
  snapQuality: SnapQuality;
}

// ── Constants ───────────────────────────────────────────────────────

/** Number of anchor vertices to include on each side of the edit region */
const ANCHOR_COUNT = 2;

/**
 * Tolerance for geometric shared boundary detection (degrees²).
 * sqrt(4e-8) ≈ 0.0002° ≈ 22m at mid-latitudes, generous enough
 * to detect shared boundaries even after simplification.
 */
const GEOMETRIC_TOLERANCE_DEG_SQ = 4e-8;

/** Padding for bounding-box overlap pre-filter (degrees, ~110m) */
const BBOX_PAD_DEG = 0.001;

/** Minimum contiguous shared vertices to qualify as a shared boundary segment */
const MIN_SHARED_VERTICES = 3;

function getOpenVertexCount(ring: Position[]): number {
  if (ring.length === 0) return 0;
  const first = ring[0];
  const last = ring[ring.length - 1];
  const isClosed = ring.length > 1 && first[0] === last[0] && first[1] === last[1];
  return isClosed ? ring.length - 1 : ring.length;
}

function ensureClosedRing(ring: Position[]): Position[] {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, [...first]];
}

function getRingBBox(ring: Position[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const pos of ring) {
    minX = Math.min(minX, pos[0]);
    minY = Math.min(minY, pos[1]);
    maxX = Math.max(maxX, pos[0]);
    maxY = Math.max(maxY, pos[1]);
  }

  return [minX, minY, maxX, maxY];
}

function bboxesOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number],
  pad = 0
): boolean {
  return !(
    a[2] + pad < b[0] - pad ||
    a[0] - pad > b[2] + pad ||
    a[3] + pad < b[1] - pad ||
    a[1] - pad > b[3] + pad
  );
}

// ── Geometric Helpers ───────────────────────────────────────────────

/**
 * Fast Euclidean distance² from a point to the nearest edge of a ring
 * (in degrees²), together with the segment index of the nearest edge.
 * O(n) per call. Used for shared boundary detection.
 */
function pointToRingDistDegSqWithIndex(
  px: number, py: number,
  ring: Position[], openCount: number
): { distSq: number; segIndex: number } {
  let bestDistSq = Infinity;
  let bestSegIndex = 0;
  for (let i = 0; i < openCount; i++) {
    const j = (i + 1) % openCount;
    const ax = ring[i][0], ay = ring[i][1];
    const bx = ring[j][0], by = ring[j][1];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let dSq: number;
    if (lenSq < 1e-20) {
      const ex = px - ax, ey = py - ay;
      dSq = ex * ex + ey * ey;
    } else {
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
      const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
      dSq = ex * ex + ey * ey;
    }
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestSegIndex = i;
    }
  }
  return { distSq: bestDistSq, segIndex: bestSegIndex };
}

/**
 * Index of the nearest vertex in a ring (Euclidean in degree-space).
 */
function findNearestVertexIndex(
  px: number, py: number,
  ring: Position[], openCount: number
): number {
  let bestIdx = 0;
  let bestDSq = Infinity;
  for (let i = 0; i < openCount; i++) {
    const dx = ring[i][0] - px, dy = ring[i][1] - py;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDSq) { bestDSq = dSq; bestIdx = i; }
  }
  return bestIdx;
}

// ── Extract Edit Region ─────────────────────────────────────────────

/**
 * Extract vertices from a patch geometry that fall inside a lasso polygon.
 * Includes anchor vertices on each side for context.
 */
export function extractEditRegion(
  patchGeometry: MultiPolygon,
  lassoPolygon: Polygon
): EditRegionInfo | null {
  // Search each polygon and ring for vertices inside the lasso
  for (let pi = 0; pi < patchGeometry.coordinates.length; pi++) {
    const polygon = patchGeometry.coordinates[pi];
    for (let ri = 0; ri < polygon.length; ri++) {
      const ring = polygon[ri];
      // Skip the closing vertex (same as first)
      const vertexCount = ring.length > 0 && 
        ring[0][0] === ring[ring.length - 1][0] && 
        ring[0][1] === ring[ring.length - 1][1]
        ? ring.length - 1
        : ring.length;

      // Find which vertices are inside the lasso
      const insideMask: boolean[] = [];
      for (let i = 0; i < vertexCount; i++) {
        const pt = point(ring[i]);
        insideMask.push(booleanPointInPolygon(pt, lassoPolygon));
      }

      // Find the first and last consecutive run of inside vertices
      let firstInside = -1;
      let lastInside = -1;
      for (let i = 0; i < vertexCount; i++) {
        if (insideMask[i]) {
          if (firstInside === -1) firstInside = i;
          lastInside = i;
        }
      }

      if (firstInside === -1) continue; // No vertices in this ring inside lasso

      // Expand to include anchor vertices on each side
      const startIndex = Math.max(0, firstInside - ANCHOR_COUNT);
      const endIndex = Math.min(vertexCount - 1, lastInside + ANCHOR_COUNT);

      // Extract the positions
      const editablePositions: Position[] = [];
      for (let i = startIndex; i <= endIndex; i++) {
        editablePositions.push([...ring[i]]);
      }

      // Calculate anchor counts (vertices outside the lasso included for context)
      const anchorCountStart = firstInside - startIndex;
      const anchorCountEnd = endIndex - lastInside;

      if (editablePositions.length < 3) continue; // Need at least 3 points

      return {
        editablePositions,
        startIndex,
        endIndex,
        ringIndex: ri,
        polygonIndex: pi,
        anchorCountStart,
        anchorCountEnd,
        originalPositions: editablePositions.map(p => [...p]),
      };
    }
  }

  return null;
}

// ── Splice Edited Region ────────────────────────────────────────────

/**
 * Replace a section of the original geometry with edited vertices.
 * The edited positions replace everything between startIndex and endIndex
 * in the original ring. The first and last positions of the edited region
 * serve as connection points to the unchanged parts of the boundary.
 */
export function spliceEditedRegion(
  originalGeometry: MultiPolygon,
  editedPositions: Position[],
  regionInfo: EditRegionInfo
): MultiPolygon {
  const { startIndex, endIndex, ringIndex, polygonIndex } = regionInfo;

  // Deep clone the geometry
  const result: MultiPolygon = JSON.parse(JSON.stringify(originalGeometry));
  const ring = result.coordinates[polygonIndex][ringIndex];

  // Remove the closing vertex for manipulation
  const isClosed = ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const openRing = isClosed ? ring.slice(0, -1) : [...ring];

  // Replace the segment from startIndex to endIndex with the edited positions
  const before = openRing.slice(0, startIndex);
  const after = openRing.slice(endIndex + 1);
  const newRing = [...before, ...editedPositions, ...after];

  // Re-close the ring
  if (newRing.length > 0) {
    const first = newRing[0];
    const last = newRing[newRing.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      newRing.push([...first]);
    }
  }

  result.coordinates[polygonIndex][ringIndex] = newRing;
  return result;
}

// ── Edited Vertex Range Detection ───────────────────────────────────

/**
 * Compare a pre-edit ring to a post-edit ring and return the contiguous
 * range of vertex indices that were actually moved by the user.
 *
 * When both rings have the same vertex count the comparison is
 * index-by-index (exact match for unmodified vertices).  When counts
 * differ (the user added / deleted vertices in terra-draw) the function
 * falls back to a geometric distance check.
 *
 * Returns `null` if no vertices were edited.
 */
function findEditedVertexRange(
  preEditRing: Position[], preEditOpenCount: number,
  postEditRing: Position[], postEditOpenCount: number,
): { start: number; end: number } | null {
  // Very tight threshold – only truly moved vertices register.
  // Unmodified vertices should be at the exact same position.
  const THRESHOLD_DEG_SQ = 1e-14; // ~0.001 m

  if (preEditOpenCount === postEditOpenCount) {
    // Same vertex count – direct index-by-index comparison
    let editStart = -1;
    let editEnd = -1;
    for (let i = 0; i < postEditOpenCount; i++) {
      const dx = preEditRing[i][0] - postEditRing[i][0];
      const dy = preEditRing[i][1] - postEditRing[i][1];
      if (dx * dx + dy * dy > THRESHOLD_DEG_SQ) {
        if (editStart === -1) editStart = i;
        editEnd = i;
      }
    }
    return editStart === -1 ? null : { start: editStart, end: editEnd };
  }

  // Different vertex counts – use geometric distance to the pre-edit ring
  let editStart = -1;
  let editEnd = -1;
  for (let i = 0; i < postEditOpenCount; i++) {
    const { distSq } = pointToRingDistDegSqWithIndex(
      postEditRing[i][0], postEditRing[i][1],
      preEditRing, preEditOpenCount,
    );
    if (distSq > THRESHOLD_DEG_SQ) {
      if (editStart === -1) editStart = i;
      editEnd = i;
    }
  }
  return editStart === -1 ? null : { start: editStart, end: editEnd };
}

// ── Geometric Shared Boundary Detection ─────────────────────────────

interface SharedBoundarySegment {
  /** Start index in ring A (the edited ring) */
  aStartIndex: number;
  /** End index in ring A */
  aEndIndex: number;
  /** Start index in ring B (the neighbour ring) */
  bStartIndex: number;
  /** End index in ring B */
  bEndIndex: number;
  /** Whether B's boundary runs in the opposite direction to A's */
  isReversed: boolean;
  /** Number of B vertices in the shared zone */
  sharedVertexCount: number;
}

/**
 * Find shared boundary segments between two rings using geometric proximity.
 *
 * For each vertex in ringB, computes the distance² to the nearest edge of
 * ringA. Vertices within GEOMETRIC_TOLERANCE_DEG_SQ are marked "shared".
 * Contiguous runs of shared vertices form segments. For each segment the
 * corresponding index range in ringA and the winding direction are determined.
 *
 * This is robust to differing vertex counts and post-simplification vertex
 * shifts, unlike the previous vertex-by-vertex matching approach.
 */
function findSharedBoundaryGeometric(
  ringA: Position[], aOpenCount: number,
  ringB: Position[], bOpenCount: number,
): SharedBoundarySegment[] {
  if (aOpenCount < 3 || bOpenCount < 3) return [];

  // Phase 1 – mark B vertices that are within tolerance of A's boundary
  const bSharedMask: boolean[] = new Array(bOpenCount).fill(false);
  const bProjSegIndex: number[] = new Array(bOpenCount).fill(0);

  for (let i = 0; i < bOpenCount; i++) {
    const { distSq, segIndex } = pointToRingDistDegSqWithIndex(
      ringB[i][0], ringB[i][1], ringA, aOpenCount,
    );
    bSharedMask[i] = distSq < GEOMETRIC_TOLERANCE_DEG_SQ;
    bProjSegIndex[i] = segIndex;
  }

  // Phase 2 – group contiguous shared B vertices into raw segments
  const rawSegments: { bStart: number; bEnd: number }[] = [];
  let currentStart = -1;
  for (let i = 0; i < bOpenCount; i++) {
    if (bSharedMask[i]) {
      if (currentStart === -1) currentStart = i;
    } else if (currentStart !== -1) {
      rawSegments.push({ bStart: currentStart, bEnd: i - 1 });
      currentStart = -1;
    }
  }
  if (currentStart !== -1) {
    rawSegments.push({ bStart: currentStart, bEnd: bOpenCount - 1 });
  }

  // Handle wrap-around: merge first and last segments if they connect
  // through vertex 0.  We represent this as bStart > bEnd.
  if (rawSegments.length >= 2) {
    const first = rawSegments[0];
    const last = rawSegments[rawSegments.length - 1];
    if (first.bStart === 0 && last.bEnd === bOpenCount - 1) {
      rawSegments[rawSegments.length - 1] = {
        bStart: last.bStart,
        bEnd: first.bEnd,
      };
      rawSegments.shift();
    }
  }

  // Phase 3 – for each segment determine A-range and winding direction
  const results: SharedBoundarySegment[] = [];

  for (const raw of rawSegments) {
    // Count shared vertices (handle wrap-around)
    let sharedCount: number;
    if (raw.bEnd >= raw.bStart) {
      sharedCount = raw.bEnd - raw.bStart + 1;
    } else {
      sharedCount = (bOpenCount - raw.bStart) + (raw.bEnd + 1);
    }
    if (sharedCount < MIN_SHARED_VERTICES) continue;

    // Nearest A vertex for the two B endpoints
    const aStartIdx = findNearestVertexIndex(
      ringB[raw.bStart][0], ringB[raw.bStart][1], ringA, aOpenCount,
    );
    const aEndIdx = findNearestVertexIndex(
      ringB[raw.bEnd][0], ringB[raw.bEnd][1], ringA, aOpenCount,
    );
    if (aStartIdx === aEndIdx) continue; // degenerate

    // Collect all B indices for this segment (ordered)
    const bIndices: number[] = [];
    if (raw.bEnd >= raw.bStart) {
      for (let i = raw.bStart; i <= raw.bEnd; i++) bIndices.push(i);
    } else {
      for (let i = raw.bStart; i < bOpenCount; i++) bIndices.push(i);
      for (let i = 0; i <= raw.bEnd; i++) bIndices.push(i);
    }

    // Determine winding by sampling A-segment-indices along the B walk.
    // If A indices generally increase → same winding (forward).
    // If A indices generally decrease → reversed.
    const sampleStep = Math.max(1, Math.floor(bIndices.length / 20));
    let forwardCount = 0, reverseCount = 0;
    for (let s = 0; s + sampleStep < bIndices.length; s += sampleStep) {
      const curr = bProjSegIndex[bIndices[s]];
      const next = bProjSegIndex[bIndices[s + sampleStep]];
      const fwd = ((next - curr) % aOpenCount + aOpenCount) % aOpenCount;
      const rev = ((curr - next) % aOpenCount + aOpenCount) % aOpenCount;
      if (fwd < rev) forwardCount++;
      else if (rev < fwd) reverseCount++;
    }

    const isReversed = reverseCount > forwardCount;

    results.push({
      aStartIndex: aStartIdx,
      aEndIndex: aEndIdx,
      bStartIndex: raw.bStart,
      bEndIndex: raw.bEnd,
      isReversed,
      sharedVertexCount: sharedCount,
    });
  }

  return results;
}

/**
 * Find patches that share a boundary segment with the given ring using
 * geometric proximity detection.  Unlike vertex-by-vertex matching this
 * works correctly even when vertex counts differ (e.g. after simplification).
 */
export function findAdjacentPatches(
  editedPatchId: string,
  editedRing: Position[],
  allPatches: PatchFeature[],
  editedPolygonIndex = 0,
  editedRingIndex = 0
): AdjacentPatchInfo[] {
  const results: AdjacentPatchInfo[] = [];
  const editedOpenCount = getOpenVertexCount(editedRing);
  if (editedOpenCount < 3) return results;

  const editedBBox = getRingBBox(editedRing);

  for (const patch of allPatches) {
    if (patch.properties.id === editedPatchId) continue;
    if (!patch.geometry) continue;

    const geom = patch.geometry.type === 'MultiPolygon'
      ? patch.geometry as MultiPolygon
      : { type: 'MultiPolygon' as const, coordinates: [(patch.geometry as Polygon).coordinates] };

    for (let pi = 0; pi < geom.coordinates.length; pi++) {
      const polygon = geom.coordinates[pi];
      for (let ri = 0; ri < polygon.length; ri++) {
        const ring = polygon[ri];
        const ringOpenCount = getOpenVertexCount(ring);
        if (ringOpenCount < 3) continue;

        if (!bboxesOverlap(editedBBox, getRingBBox(ring), BBOX_PAD_DEG)) {
          continue;
        }

        const segments = findSharedBoundaryGeometric(
          editedRing, editedOpenCount,
          ring, ringOpenCount,
        );

        for (const seg of segments) {
          results.push({
            patchId: patch.properties.id,
            patchCode: patch.properties.code,
            startIndex: seg.bStartIndex,
            endIndex: seg.bEndIndex,
            ringIndex: ri,
            polygonIndex: pi,
            editedStartIndex: seg.aStartIndex,
            editedEndIndex: seg.aEndIndex,
            editedRingIndex,
            editedPolygonIndex,
            matchedVertexCount: seg.sharedVertexCount,
            isReversed: seg.isReversed,
          });
        }
      }
    }
  }

  return results;
}

// ── Sync Adjacent Boundary ──────────────────────────────────────────

/**
 * Update a neighbouring patch's geometry to match the newly edited boundary.
 * The shared segment in the neighbour is replaced with the new positions,
 * reversed if the shared boundary runs in opposite winding order.
 */
export function syncAdjacentBoundary(
  neighbourGeometry: MultiPolygon,
  newSegmentPositions: Position[],
  adjacentInfo: AdjacentPatchInfo
): MultiPolygon {
  const result: MultiPolygon = JSON.parse(JSON.stringify(neighbourGeometry));
  const polygon = result.coordinates[adjacentInfo.polygonIndex];
  if (!polygon) return neighbourGeometry;
  const ring = polygon[adjacentInfo.ringIndex];
  if (!ring || ring.length < 4) return neighbourGeometry;

  const openVertexCount = getOpenVertexCount(ring);
  if (openVertexCount < 3) return neighbourGeometry;
  if (newSegmentPositions.length < 2) return neighbourGeometry;

  const { startIndex, endIndex } = adjacentInfo;
  if (startIndex < 0 || startIndex >= openVertexCount) return neighbourGeometry;
  if (endIndex < 0 || endIndex >= openVertexCount) return neighbourGeometry;

  // Prepare the replacement segment (reverse if needed)
  const replacement = adjacentInfo.isReversed
    ? [...newSegmentPositions].reverse()
    : [...newSegmentPositions];
  if (replacement.length < 2) return neighbourGeometry;

  const openRing = ring.slice(0, openVertexCount);

  let newOpenRing: Position[];
  if (endIndex >= startIndex) {
    const before = openRing.slice(0, startIndex);
    const after = openRing.slice(endIndex + 1);
    newOpenRing = [...before, ...replacement, ...after];
  } else {
    // Wrap-around replacement: replace [start..end-of-ring] and [0..end].
    const rotated = [...openRing.slice(startIndex), ...openRing.slice(0, startIndex)];
    const replacedCount = (openVertexCount - startIndex) + endIndex + 1;
    const after = rotated.slice(replacedCount);
    newOpenRing = [...replacement, ...after];
  }

  if (newOpenRing.length < 3) return neighbourGeometry;
  result.coordinates[adjacentInfo.polygonIndex][adjacentInfo.ringIndex] = ensureClosedRing(newOpenRing);

  return result;
}

export function extractSegmentFromRing(
  ring: Position[],
  startIndex: number,
  endIndex: number
): Position[] {
  const vertexCount = getOpenVertexCount(ring);
  if (vertexCount < 3) return [];
  if (startIndex < 0 || startIndex >= vertexCount) return [];
  if (endIndex < 0 || endIndex >= vertexCount) return [];
  const openRing = ring.slice(0, vertexCount);

  if (endIndex >= startIndex) {
    return openRing.slice(startIndex, endIndex + 1).map(position => [...position]);
  }

  return [
    ...openRing.slice(startIndex).map(position => [...position]),
    ...openRing.slice(0, endIndex + 1).map(position => [...position]),
  ];
}

// ── Build Editable Polygon ──────────────────────────────────────────

/**
 * Build a simple Polygon from the extracted edit region positions,
 * suitable for loading into terra-draw.
 * Creates an open polyline-like polygon by connecting start to end.
 */
export function buildEditablePolygon(positions: Position[]): Polygon {
  // Close the ring if needed
  const ring = [...positions];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([...first]);
  }

  return {
    type: 'Polygon',
    coordinates: [ring],
  };
}

/**
 * Build an open polyline from positions for terra-draw editing.
 * Since terra-draw works with polygons, we create a very thin polygon
 * from the line by offsetting slightly.
 * 
 * Actually, for region editing, we should just let the user edit
 * the positions as a polygon section. We'll load them as individual
 * points that can be dragged, rather than as a polygon.
 */
export function getEditableVertexCount(regionInfo: EditRegionInfo): number {
  return regionInfo.editablePositions.length - regionInfo.anchorCountStart - regionInfo.anchorCountEnd;
}

// ── Post-Edit: Gap Detection ────────────────────────────────────────

/**
 * Detect unallocated space (gap) created when a patch boundary was moved inward.
 * Computes: area that was in the old geometry but NOT in the new geometry,
 * minus any area already covered by neighbouring patches.
 *
 * Returns the gap polygon if significant (> 100 sq meters), or null.
 */
export function detectGap(
  oldGeometry: MultiPolygon,
  newGeometry: MultiPolygon,
  occupiedPatches: PatchFeature[]
): Feature<Polygon | MultiPolygon> | null {
  try {
    // Compute the area that was lost: old minus new
    const lost = difference(
      { type: 'FeatureCollection', features: [turfFeature(oldGeometry), turfFeature(newGeometry)] }
    );

    if (!lost) return null;

    // Subtract any area covered by existing patches.
    // Using all occupied patches (not just detected neighbours) prevents
    // accidental inclusion of adjacent/overlapping geometry in the gap result.
    let gap: Feature<Polygon | MultiPolygon> | null = lost as Feature<Polygon | MultiPolygon>;

    for (const patch of occupiedPatches) {
      if (!patch.geometry || !gap) continue;
      try {
        const subtracted = difference(
          { type: 'FeatureCollection', features: [gap, patch as Feature<Polygon | MultiPolygon>] }
        );
        gap = subtracted as Feature<Polygon | MultiPolygon> | null;
      } catch {
        // Skip invalid geometry
      }
    }

    if (!gap) return null;

    // Remove any residual polygons that still overlap occupied patches.
    // This is a defensive cleanup for edge cases with imperfect neighbour detection.
    const polygonCoordinates =
      gap.geometry.type === 'Polygon'
        ? [gap.geometry.coordinates]
        : gap.geometry.type === 'MultiPolygon'
          ? gap.geometry.coordinates
          : [];

    const cleanCoordinates = polygonCoordinates.filter(coords => {
      const candidate: Feature<Polygon> = {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: coords },
      };

      if (area(candidate) < 100) return false;

      for (const patch of occupiedPatches) {
        if (!patch.geometry) continue;
        try {
          const overlap = intersect({
            type: 'FeatureCollection',
            features: [candidate, patch as Feature<Polygon | MultiPolygon>],
          });
          if (overlap && area(overlap) > 100) {
            return false;
          }
        } catch {
          // Ignore invalid overlaps and keep checking others.
        }
      }

      return true;
    });

    if (cleanCoordinates.length === 0) return null;

    if (cleanCoordinates.length === 1) {
      return {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: cleanCoordinates[0] },
      };
    }

    return {
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPolygon', coordinates: cleanCoordinates },
    };
  } catch (err) {
    console.warn('Error detecting gap:', err);
    return null;
  }
}

/**
 * Classify the relationship between an edited patch and a neighbour.
 * - 'gap': there is unallocated space between them
 * - 'overlap': they overlap
 * - 'aligned': boundaries are close/touching with no significant gap or overlap
 */
export function classifyNeighbourRelationship(
  editedGeometry: MultiPolygon,
  neighbourGeometry: MultiPolygon
): 'gap' | 'overlap' | 'aligned' {
  try {
    const overlap = intersect(
      { type: 'FeatureCollection', features: [turfFeature(editedGeometry), turfFeature(neighbourGeometry)] }
    );

    if (overlap) {
      const overlapArea = area(overlap);
      if (overlapArea > 100) return 'overlap'; // > 100 sq meters
      // Tiny overlap = boundaries are touching → aligned
      return 'aligned';
    }

    // No overlap at all.  Since we only reach here for patches already
    // identified as neighbours by geometric proximity detection, the
    // boundaries are within ~22 m of each other → treat as aligned.
    return 'aligned';
  } catch {
    return 'aligned';
  }
}

export interface NeighbourInfo {
  patchId: string;
  patchCode: string;
  relationship: 'gap' | 'overlap' | 'aligned';
  isDuplicate: boolean;
  adjacentInfo: AdjacentPatchInfo;
}

export interface PostEditAnalysis {
  duplicates: NeighbourInfo[];
  neighbours: NeighbourInfo[];
  gapGeometry: Feature<Polygon | MultiPolygon> | null;
  gapAreaSqm: number;
}

function countGeometryVertices(geometry: MultiPolygon): number {
  return geometry.coordinates.reduce((polygonAcc, polygon) => {
    return polygonAcc + polygon.reduce((ringAcc, ring) => ringAcc + getOpenVertexCount(ring), 0);
  }, 0);
}

/**
 * Check if two geometries are duplicates (>95% mutual overlap).
 */
function isDuplicateGeometry(geomA: MultiPolygon, geomB: MultiPolygon): boolean {
  try {
    const areaA = area(turfFeature(geomA));
    const areaB = area(turfFeature(geomB));

    if (areaA === 0 || areaB === 0) return false;

    const overlap = intersect(
      { type: 'FeatureCollection', features: [turfFeature(geomA), turfFeature(geomB)] }
    );

    if (!overlap) return false;

    const overlapArea = area(overlap);
    const smallerArea = Math.min(areaA, areaB);

    // If overlap covers > 95% of the smaller patch, it's a duplicate
    return (overlapArea / smallerArea) > 0.95;
  } catch {
    return false;
  }
}

/**
 * Analyse the result of a boundary edit: find affected neighbours,
 * detect duplicates, and detect gaps.
 */
export function analysePostEdit(
  editedPatchId: string,
  oldGeometry: MultiPolygon,
  newGeometry: MultiPolygon,
  allPatches: PatchFeature[],
  preEditSimplifiedGeometry?: MultiPolygon | null,
): PostEditAnalysis {
  const analysisStart = performance.now();
  const newVertexCount = countGeometryVertices(newGeometry);
  console.log('[ANALYSE-POST-EDIT] start', {
    newVertexCount,
    patchCount: allPatches.length,
  });

  // Detect neighbours using the OLD geometry.  The old geometry's
  // boundaries still align with the neighbours (which haven't changed).
  // Using newGeometry would fail when the edited boundary has moved away
  // from a neighbour by more than the geometric tolerance (~22 m).
  const adjacencyStart = performance.now();
  const adjacentCandidates: AdjacentPatchInfo[] = [];
  for (let polygonIndex = 0; polygonIndex < oldGeometry.coordinates.length; polygonIndex++) {
    const polygon = oldGeometry.coordinates[polygonIndex];
    for (let ringIndex = 0; ringIndex < polygon.length; ringIndex++) {
      const ring = polygon[ringIndex];
      const matches = findAdjacentPatches(
        editedPatchId,
        ring,
        allPatches,
        polygonIndex,
        ringIndex,
      );
      adjacentCandidates.push(...matches);
    }
  }

  // The editedStartIndex / editedEndIndex values now reference the OLD
  // ring.  Remap them to the NEW ring so that generateBoundaryProposals()
  // extracts the correct (moved) boundary section.
  for (const candidate of adjacentCandidates) {
    const oldRing = oldGeometry.coordinates[candidate.editedPolygonIndex]?.[candidate.editedRingIndex];
    const newRing = newGeometry.coordinates[candidate.editedPolygonIndex]?.[candidate.editedRingIndex];
    if (!oldRing || !newRing) continue;
    const newOpenCount = getOpenVertexCount(newRing);
    if (newOpenCount < 3) continue;

    const oldStart = oldRing[candidate.editedStartIndex];
    const oldEnd = oldRing[candidate.editedEndIndex];
    if (!oldStart || !oldEnd) continue;

    candidate.editedStartIndex = findNearestVertexIndex(
      oldStart[0], oldStart[1], newRing, newOpenCount,
    );
    candidate.editedEndIndex = findNearestVertexIndex(
      oldEnd[0], oldEnd[1], newRing, newOpenCount,
    );
  }

  // ── Narrow shared boundary to only the user-edited section ────────
  //
  // When a patch is simplified before refining, the shared boundary
  // detection (above) picks up the ENTIRE shared edge between the
  // original edited ring and each neighbour.  Transferring that entire
  // simplified boundary would replace detailed neighbour vertices with
  // far fewer simplified vertices, creating visible straight lines.
  //
  // If `preEditSimplifiedGeometry` is available (i.e. the user refined
  // the simplified boundary), we compare it to `newGeometry` to find
  // exactly which vertices were moved.  We then narrow each candidate's
  // editedStartIndex/editedEndIndex (and the corresponding neighbour
  // startIndex/endIndex) to only the portion that was actually edited,
  // plus a small anchor buffer.
  //
  // IMPORTANT: this step is purely an optimisation.  If narrowing cannot
  // determine the edit range or the intersection is empty, we KEEP the
  // candidate with the full shared range so that neighbour sync still
  // works (falling back to the pre-narrowing behaviour).
  if (preEditSimplifiedGeometry) {
    const EDIT_BUFFER = 3; // anchor vertices on each side of the edit
    let narrowedCount = 0;
    let fallbackCount = 0;

    for (const candidate of adjacentCandidates) {
      const preEditRing =
        preEditSimplifiedGeometry.coordinates[candidate.editedPolygonIndex]?.[candidate.editedRingIndex];
      const postEditRing =
        newGeometry.coordinates[candidate.editedPolygonIndex]?.[candidate.editedRingIndex];
      if (!preEditRing || !postEditRing) {
        fallbackCount++;
        continue; // keep candidate as-is
      }

      const preEditOpenCount = getOpenVertexCount(preEditRing);
      const postEditOpenCount = getOpenVertexCount(postEditRing);
      if (preEditOpenCount < 3 || postEditOpenCount < 3) {
        fallbackCount++;
        continue; // keep candidate as-is
      }

      const editedRange = findEditedVertexRange(
        preEditRing, preEditOpenCount,
        postEditRing, postEditOpenCount,
      );

      if (!editedRange) {
        // Cannot determine which vertices changed – keep with full range.
        console.log('[ANALYSE-POST-EDIT] narrowing: no editedRange detected, keeping full range', {
          patchId: candidate.patchId,
          preEditOpenCount,
          postEditOpenCount,
        });
        fallbackCount++;
        continue; // keep candidate as-is
      }

      // Buffered edit zone on the post-edit ring
      const buffStart = Math.max(0, editedRange.start - EDIT_BUFFER);
      const buffEnd = Math.min(postEditOpenCount - 1, editedRange.end + EDIT_BUFFER);

      // Intersect the shared boundary range with the buffered edit zone.
      // Both ranges are on the post-edit ring (editedStartIndex /
      // editedEndIndex were already remapped above).
      const sharedStart = candidate.editedStartIndex;
      const sharedEnd = candidate.editedEndIndex;

      // Simple non-wrapping intersection
      const intStart = Math.max(buffStart, Math.min(sharedStart, sharedEnd));
      const intEnd = Math.min(buffEnd, Math.max(sharedStart, sharedEnd));

      if (intStart > intEnd) {
        // The buffered edit zone doesn't overlap the shared boundary.
        // Keep with full range to be safe (the detection said they're
        // neighbours, so let the transfer proceed).
        console.log('[ANALYSE-POST-EDIT] narrowing: no intersection, keeping full range', {
          patchId: candidate.patchId,
          editedRange,
          buffStart, buffEnd,
          sharedStart, sharedEnd,
        });
        fallbackCount++;
        continue; // keep candidate as-is
      }

      // Successfully narrowed – update indices
      console.log('[ANALYSE-POST-EDIT] narrowing: success', {
        patchId: candidate.patchId,
        originalShared: [sharedStart, sharedEnd],
        narrowedEdited: [intStart, intEnd],
        editedRange,
      });

      candidate.editedStartIndex = intStart;
      candidate.editedEndIndex = intEnd;

      // Re-compute the corresponding neighbour indices by projecting the
      // narrowed edited range endpoints onto the neighbour's ring.
      const neighbourPatch = allPatches.find(
        f => f.properties.id === candidate.patchId,
      );
      if (neighbourPatch?.geometry) {
        const nGeom = neighbourPatch.geometry.type === 'MultiPolygon'
          ? neighbourPatch.geometry as MultiPolygon
          : { type: 'MultiPolygon' as const, coordinates: [(neighbourPatch.geometry as Polygon).coordinates] };
        const neighbourRing =
          nGeom.coordinates[candidate.polygonIndex]?.[candidate.ringIndex];
        if (neighbourRing) {
          const nOpenCount = getOpenVertexCount(neighbourRing);
          if (nOpenCount >= 3) {
            candidate.startIndex = findNearestVertexIndex(
              postEditRing[intStart][0], postEditRing[intStart][1],
              neighbourRing, nOpenCount,
            );
            candidate.endIndex = findNearestVertexIndex(
              postEditRing[intEnd][0], postEditRing[intEnd][1],
              neighbourRing, nOpenCount,
            );
          }
        }
      }

      narrowedCount++;
    }

    console.log('[ANALYSE-POST-EDIT] narrowing complete', {
      narrowedCount,
      fallbackCount,
      totalCandidates: adjacentCandidates.length,
    });
  }

  console.log('[ANALYSE-POST-EDIT] adjacency complete', {
    elapsedMs: Math.round(performance.now() - adjacencyStart),
    candidateCount: adjacentCandidates.length,
  });

  // Keep one strongest adjacency per patch.
  const adjacentByPatchId = new Map<string, AdjacentPatchInfo>();
  for (const candidate of adjacentCandidates) {
    const existing = adjacentByPatchId.get(candidate.patchId);
    if (!existing || candidate.matchedVertexCount > existing.matchedVertexCount) {
      adjacentByPatchId.set(candidate.patchId, candidate);
    }
  }
  const adjacentPatches = Array.from(adjacentByPatchId.values());

  // Scan ALL patches for duplicates (>95% mutual overlap with old geometry)
  const duplicateIds = new Set<string>();
  const duplicateStart = performance.now();
  for (const patch of allPatches) {
    if (patch.properties.id === editedPatchId) continue;
    if (!patch.geometry) continue;

    const patchGeom = patch.geometry.type === 'MultiPolygon'
      ? patch.geometry as MultiPolygon
      : { type: 'MultiPolygon' as const, coordinates: [(patch.geometry as Polygon).coordinates] };

    if (isDuplicateGeometry(oldGeometry, patchGeom)) {
      duplicateIds.add(patch.properties.id);
    }
  }
  console.log('[ANALYSE-POST-EDIT] duplicate scan complete', {
    elapsedMs: Math.round(performance.now() - duplicateStart),
    duplicateCount: duplicateIds.size,
  });

  const allNeighbours: NeighbourInfo[] = adjacentPatches.map(adj => {
    const neighbour = allPatches.find(p => p.properties.id === adj.patchId);
    if (!neighbour) return null;

    const neighbourGeom = neighbour.geometry.type === 'MultiPolygon'
      ? neighbour.geometry as MultiPolygon
      : { type: 'MultiPolygon' as const, coordinates: [(neighbour.geometry as Polygon).coordinates] };

    const isDupe = duplicateIds.has(adj.patchId);
    const relationship = isDupe ? 'overlap' as const : classifyNeighbourRelationship(newGeometry, neighbourGeom);

    return {
      patchId: adj.patchId,
      patchCode: adj.patchCode,
      relationship,
      isDuplicate: isDupe,
      adjacentInfo: adj,
    };
  }).filter((n): n is NonNullable<typeof n> => n !== null);

  // Also add duplicates that weren't found via boundary adjacency
  for (const patch of allPatches) {
    if (patch.properties.id === editedPatchId) continue;
    if (!duplicateIds.has(patch.properties.id)) continue;
    if (allNeighbours.some(n => n.patchId === patch.properties.id)) continue;

    // This duplicate wasn't in the adjacency list -- add it
    allNeighbours.push({
      patchId: patch.properties.id,
      patchCode: patch.properties.code,
      relationship: 'overlap',
      isDuplicate: true,
      adjacentInfo: {
        patchId: patch.properties.id,
        patchCode: patch.properties.code,
        startIndex: 0,
        endIndex: 0,
        ringIndex: 0,
        polygonIndex: 0,
        editedStartIndex: 0,
        editedEndIndex: 0,
        editedRingIndex: 0,
        editedPolygonIndex: 0,
        matchedVertexCount: 0,
        isReversed: false,
      },
    });
  }

  // Split into duplicates and true neighbours
  const duplicates = allNeighbours.filter(n => n.isDuplicate);
  const neighbours = allNeighbours.filter(n => !n.isDuplicate);

  // Detect gap against all occupied patches except the edited patch.
  // This ensures the created gap never includes any existing neighbour geometry.
  const occupiedFeatures = allPatches.filter(
    p => p.properties.id !== editedPatchId && !!p.geometry
  );

  let gapGeometry: Feature<Polygon | MultiPolygon> | null = null;
  let gapAreaSqm = 0;
  const gapStart = performance.now();
  gapGeometry = detectGap(oldGeometry, newGeometry, occupiedFeatures);
  gapAreaSqm = gapGeometry ? area(gapGeometry) : 0;
  console.log('[ANALYSE-POST-EDIT] gap detection complete', {
    elapsedMs: Math.round(performance.now() - gapStart),
    hasGap: !!gapGeometry,
    gapAreaSqm: Math.round(gapAreaSqm),
  });
  console.log('[ANALYSE-POST-EDIT] complete', {
    elapsedMs: Math.round(performance.now() - analysisStart),
    neighbours: neighbours.length,
    duplicates: duplicates.length,
  });

  return {
    duplicates,
    neighbours,
    gapGeometry,
    gapAreaSqm,
  };
}

// ── Improved Snapping Algorithm ─────────────────────────────────────

/**
 * Calculate the angle between three points in degrees.
 * Returns the interior angle at point B when connecting A-B-C.
 */
function calculateAngle(a: Position, b: Position, c: Position): number {
  const ba = [a[0] - b[0], a[1] - b[1]];
  const bc = [c[0] - b[0], c[1] - b[1]];
  
  const dotProduct = ba[0] * bc[0] + ba[1] * bc[1];
  const magnitudeBA = Math.sqrt(ba[0] * ba[0] + ba[1] * ba[1]);
  const magnitudeBC = Math.sqrt(bc[0] * bc[0] + bc[1] * bc[1]);
  
  if (magnitudeBA === 0 || magnitudeBC === 0) return 180;
  
  const cosAngle = dotProduct / (magnitudeBA * magnitudeBC);
  const angleRad = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
  return (angleRad * 180) / Math.PI;
}

/**
 * Assess the quality of a boundary connection based on angle and distance.
 */
function assessConnectionQuality(
  beforePoint: Position | null,
  startPoint: Position,
  endPoint: Position,
  afterPoint: Position | null
): SnapQuality {
  // Check start connection if we have a before point
  if (beforePoint) {
    const startAngle = calculateAngle(beforePoint, startPoint, 
      startPoint[0] === endPoint[0] && startPoint[1] === endPoint[1] && afterPoint
        ? afterPoint 
        : endPoint
    );
    const startDist = distance(point(beforePoint), point(startPoint), { units: 'kilometers' });
    
    // Sharp angle (< 30°) or large gap (> 5 meters) = poor quality
    if (startAngle < 30 || startDist > 0.005) {
      return 'poor';
    }
  }
  
  // Check end connection if we have an after point
  if (afterPoint) {
    const endAngle = calculateAngle(
      endPoint[0] === startPoint[0] && endPoint[1] === startPoint[1] && beforePoint
        ? beforePoint
        : startPoint,
      endPoint,
      afterPoint
    );
    const endDist = distance(point(endPoint), point(afterPoint), { units: 'kilometers' });
    
    // Sharp angle (< 30°) or large gap (> 5 meters) = poor quality
    if (endAngle < 30 || endDist > 0.005) {
      return 'poor';
    }
  }
  
  return 'good';
}

/**
 * Find the nearest point on a line segment to a target point.
 * If the perpendicular projection falls outside the segment, returns the nearest endpoint.
 */
function projectToNearestPoint(
  targetPoint: Position,
  segmentStart: Position,
  segmentEnd: Position
): Position {
  const dx = segmentEnd[0] - segmentStart[0];
  const dy = segmentEnd[1] - segmentStart[1];
  
  if (dx === 0 && dy === 0) {
    // Degenerate segment - just return the start point
    return [...segmentStart];
  }
  
  // Calculate the parameter t for the projection
  const t = ((targetPoint[0] - segmentStart[0]) * dx + (targetPoint[1] - segmentStart[1]) * dy) /
            (dx * dx + dy * dy);
  
  // Clamp t to [0, 1] to stay within the segment
  const tClamped = Math.max(0, Math.min(1, t));
  
  return [
    segmentStart[0] + tClamped * dx,
    segmentStart[1] + tClamped * dy
  ];
}

/**
 * Improved boundary syncing that uses projection to avoid long straight lines.
 * Returns the updated geometry and a quality assessment.
 */
export function syncAdjacentBoundaryImproved(
  neighbourGeometry: MultiPolygon,
  newSegmentPositions: Position[],
  adjacentInfo: AdjacentPatchInfo
): { geometry: MultiPolygon; quality: SnapQuality; changedSegment: Position[]; connectionPoints: { start: Position; end: Position } } {
  const result: MultiPolygon = JSON.parse(JSON.stringify(neighbourGeometry));
  const polygon = result.coordinates[adjacentInfo.polygonIndex];
  if (!polygon) {
    return {
      geometry: neighbourGeometry,
      quality: 'poor',
      changedSegment: [],
      connectionPoints: { start: [0, 0], end: [0, 0] }
    };
  }
  
  const ring = polygon[adjacentInfo.ringIndex];
  if (!ring || ring.length < 4) {
    return {
      geometry: neighbourGeometry,
      quality: 'poor',
      changedSegment: [],
      connectionPoints: { start: [0, 0], end: [0, 0] }
    };
  }

  const openVertexCount = getOpenVertexCount(ring);
  if (openVertexCount < 3) {
    return {
      geometry: neighbourGeometry,
      quality: 'poor',
      changedSegment: [],
      connectionPoints: { start: [0, 0], end: [0, 0] }
    };
  }
  if (newSegmentPositions.length < 2) {
    return {
      geometry: neighbourGeometry,
      quality: 'poor',
      changedSegment: [],
      connectionPoints: { start: [0, 0], end: [0, 0] }
    };
  }

  const { startIndex, endIndex } = adjacentInfo;
  if (startIndex < 0 || startIndex >= openVertexCount) {
    return {
      geometry: neighbourGeometry,
      quality: 'poor',
      changedSegment: [],
      connectionPoints: { start: [0, 0], end: [0, 0] }
    };
  }
  if (endIndex < 0 || endIndex >= openVertexCount) {
    return {
      geometry: neighbourGeometry,
      quality: 'poor',
      changedSegment: [],
      connectionPoints: { start: [0, 0], end: [0, 0] }
    };
  }

  // Prepare the replacement segment (reverse if needed)
  const replacement = adjacentInfo.isReversed
    ? [...newSegmentPositions].reverse()
    : [...newSegmentPositions];
  if (replacement.length < 2) {
    return {
      geometry: neighbourGeometry,
      quality: 'poor',
      changedSegment: [],
      connectionPoints: { start: [0, 0], end: [0, 0] }
    };
  }

  const openRing = ring.slice(0, openVertexCount);

  let newOpenRing: Position[];
  let beforePoint: Position | null = null;
  let afterPoint: Position | null = null;

  if (endIndex >= startIndex) {
    const before = openRing.slice(0, startIndex);
    const after = openRing.slice(endIndex + 1);
    
    beforePoint = before.length > 0 ? before[before.length - 1] : null;
    afterPoint = after.length > 0 ? after[0] : null;
    
    newOpenRing = [...before, ...replacement, ...after];
  } else {
    // Wrap-around replacement
    const rotated = [...openRing.slice(startIndex), ...openRing.slice(0, startIndex)];
    const replacedCount = (openVertexCount - startIndex) + endIndex + 1;
    const after = rotated.slice(replacedCount);
    
    // For wrap-around, the before point is at the end of 'after', and after point is at start of 'after'
    beforePoint = openRing[startIndex - 1] || openRing[openVertexCount - 1];
    afterPoint = after.length > 0 ? after[0] : null;
    
    newOpenRing = [...replacement, ...after];
  }

  if (newOpenRing.length < 3) {
    return {
      geometry: neighbourGeometry,
      quality: 'poor',
      changedSegment: [],
      connectionPoints: { start: [0, 0], end: [0, 0] }
    };
  }

  // Assess connection quality
  const quality = assessConnectionQuality(
    beforePoint,
    replacement[0],
    replacement[replacement.length - 1],
    afterPoint
  );

  result.coordinates[adjacentInfo.polygonIndex][adjacentInfo.ringIndex] = ensureClosedRing(newOpenRing);

  return {
    geometry: result,
    quality,
    changedSegment: [...replacement],
    connectionPoints: {
      start: [...replacement[0]],
      end: [...replacement[replacement.length - 1]]
    }
  };
}

/**
 * Sync a neighbour's boundary by **projecting** each of its shared-section
 * vertices onto the nearest point on the edited boundary polyline.
 *
 * Unlike `syncAdjacentBoundary` / `syncAdjacentBoundaryImproved` which
 * **splice** (replace N vertices with M), this approach preserves the
 * neighbour's vertex density.  That avoids the long straight-line artefacts
 * that occur when a simplified boundary (few vertices) replaces a detailed
 * one (many vertices).
 */
export function syncBoundaryByProjection(
  neighbourGeometry: MultiPolygon,
  editedPolyline: Position[],
  adjacentInfo: AdjacentPatchInfo,
): {
  geometry: MultiPolygon;
  quality: SnapQuality;
  changedSegment: Position[];
  connectionPoints: { start: Position; end: Position };
} {
  const poor = {
    geometry: neighbourGeometry,
    quality: 'poor' as SnapQuality,
    changedSegment: [] as Position[],
    connectionPoints: { start: [0, 0] as Position, end: [0, 0] as Position },
  };

  if (editedPolyline.length < 2) return poor;

  const result: MultiPolygon = JSON.parse(JSON.stringify(neighbourGeometry));
  const ring = result.coordinates[adjacentInfo.polygonIndex]?.[adjacentInfo.ringIndex];
  if (!ring || ring.length < 4) return poor;

  const openCount = getOpenVertexCount(ring);
  if (openCount < 3) return poor;

  const { startIndex, endIndex, isReversed } = adjacentInfo;
  if (startIndex < 0 || startIndex >= openCount) return poor;
  if (endIndex < 0 || endIndex >= openCount) return poor;

  // The polyline to project onto – reverse it if the winding directions
  // are opposite so that the nearest-point search stays geometrically
  // correct (it's direction-agnostic, but this keeps changedSegment
  // oriented consistently with the neighbour's ring).
  const polyline = isReversed
    ? [...editedPolyline].reverse()
    : [...editedPolyline];

  // Collect the indices of the shared section (handles wrap-around)
  const indices: number[] = [];
  if (endIndex >= startIndex) {
    for (let i = startIndex; i <= endIndex; i++) indices.push(i);
  } else {
    for (let i = startIndex; i < openCount; i++) indices.push(i);
    for (let i = 0; i <= endIndex; i++) indices.push(i);
  }

  // Project each shared vertex onto the nearest edge of the polyline
  const changedSegment: Position[] = [];
  for (const idx of indices) {
    const vertex = ring[idx];
    let bestDistSq = Infinity;
    let bestPoint: Position = [...vertex];

    for (let j = 0; j < polyline.length - 1; j++) {
      const projected = projectToNearestPoint(vertex, polyline[j], polyline[j + 1]);
      const dx = projected[0] - vertex[0];
      const dy = projected[1] - vertex[1];
      const dSq = dx * dx + dy * dy;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestPoint = projected;
      }
    }

    ring[idx] = bestPoint;
    changedSegment.push([...bestPoint]);
  }

  // Re-close the ring
  ring[ring.length - 1] = [...ring[0]];

  // Assess connection quality at the splice boundaries
  const beforePoint =
    startIndex > 0
      ? ring[startIndex - 1]
      : ring[openCount - 1];
  const afterIdx = (endIndex + 1) % openCount;
  const afterPoint = ring[afterIdx];
  const quality = assessConnectionQuality(
    beforePoint,
    changedSegment[0],
    changedSegment[changedSegment.length - 1],
    afterPoint,
  );

  return {
    geometry: result,
    quality,
    changedSegment,
    connectionPoints: {
      start: [...changedSegment[0]],
      end: [...changedSegment[changedSegment.length - 1]],
    },
  };
}

/**
 * Compute the projected point on a ring edge and return both the point
 * and its squared distance from the query point.  O(openCount) per call.
 */
function nearestPointOnRingProjected(
  px: number, py: number,
  ring: Position[], openCount: number,
): { distSq: number; point: Position; segIndex: number } {
  let bestDistSq = Infinity;
  let bestPoint: Position = [px, py];
  let bestSegIndex = 0;

  for (let i = 0; i < openCount; i++) {
    const j = (i + 1) % openCount;
    const ax = ring[i][0], ay = ring[i][1];
    const bx = ring[j][0], by = ring[j][1];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    let projX: number, projY: number;
    if (lenSq < 1e-20) {
      projX = ax; projY = ay;
    } else {
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
      projX = ax + t * dx;
      projY = ay + t * dy;
    }

    const ex = px - projX, ey = py - projY;
    const dSq = ex * ex + ey * ey;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestPoint = [projX, projY];
      bestSegIndex = i;
    }
  }

  return { distSq: bestDistSq, point: bestPoint, segIndex: bestSegIndex };
}

/**
 * Sync a neighbour's boundary using a **displacement** approach.
 *
 * For each vertex in the neighbour's ring:
 *   1. Find the nearest point on the OLD (pre-edit) ring of the edited patch.
 *   2. If within tolerance → the vertex is on the shared boundary.
 *   3. Find the nearest point on the NEW (post-edit) ring to that old-ring
 *      projection point.
 *   4. Displacement = (new projection) − (old projection).
 *   5. Move the neighbour vertex by that displacement.
 *
 * This is robust to vertex-count mismatches between old (full-detail) and
 * new (simplified) rings, because it uses geometric proximity rather than
 * index correspondence.  It naturally leaves unedited vertices untouched
 * (displacement ≈ 0) and moves only the vertices near the actual edit.
 */
export function syncBoundaryByDisplacement(
  neighbourGeometry: MultiPolygon,
  oldEditedRing: Position[],
  newEditedRing: Position[],
  polygonIndex: number,
  ringIndex: number,
): {
  geometry: MultiPolygon;
  quality: SnapQuality;
  changedSegment: Position[];
  connectionPoints: { start: Position; end: Position };
  displacedCount: number;
} {
  const empty = {
    geometry: neighbourGeometry,
    quality: 'poor' as SnapQuality,
    changedSegment: [] as Position[],
    connectionPoints: { start: [0, 0] as Position, end: [0, 0] as Position },
    displacedCount: 0,
  };

  const result: MultiPolygon = JSON.parse(JSON.stringify(neighbourGeometry));
  const ring = result.coordinates[polygonIndex]?.[ringIndex];
  if (!ring || ring.length < 4) return empty;

  const openCount = getOpenVertexCount(ring);
  const oldOpenCount = getOpenVertexCount(oldEditedRing);
  const newOpenCount = getOpenVertexCount(newEditedRing);
  if (oldOpenCount < 3 || newOpenCount < 3) return empty;

  // Proximity threshold: ~22 m at mid-latitudes (same as shared boundary detection)
  const PROXIMITY_SQ = GEOMETRIC_TOLERANCE_DEG_SQ;

  // Safety: reject displacements larger than ~35 km (0.316°).
  // This is generous enough for any real-world boundary edit while still
  // catching completely wrong cross-patch projections.
  const MAX_DISP_SQ = 0.1;

  // Minimum displacement to bother applying (~0.001 m)
  const MIN_DISP_SQ = 1e-14;

  // Pre-compute bounding box of the old ring for fast filtering
  const oldBBox = getRingBBox(oldEditedRing);
  const pad = Math.sqrt(PROXIMITY_SQ) + 0.0001;

  const changedSegment: Position[] = [];
  let displacedCount = 0;
  let firstChangedIdx = -1;
  let lastChangedIdx = -1;

  for (let idx = 0; idx < openCount; idx++) {
    const vx = ring[idx][0], vy = ring[idx][1];

    // Quick bbox check: skip vertices clearly outside the old ring's extent
    if (
      vx < oldBBox[0] - pad || vx > oldBBox[2] + pad ||
      vy < oldBBox[1] - pad || vy > oldBBox[3] + pad
    ) continue;

    // Step 1: nearest point on the OLD edited ring
    const { distSq: oldDistSq, point: pOld } = nearestPointOnRingProjected(
      vx, vy, oldEditedRing, oldOpenCount,
    );
    if (oldDistSq > PROXIMITY_SQ) continue;

    // Step 2: nearest point on the NEW edited ring to pOld
    const { point: pNew } = nearestPointOnRingProjected(
      pOld[0], pOld[1], newEditedRing, newOpenCount,
    );

    // Step 3: compute displacement
    const dx = pNew[0] - pOld[0];
    const dy = pNew[1] - pOld[1];
    const dispSq = dx * dx + dy * dy;

    if (dispSq > MAX_DISP_SQ) continue;  // safety
    if (dispSq < MIN_DISP_SQ) continue;  // no meaningful change

    // Step 4: apply displacement
    ring[idx] = [vx + dx, vy + dy];
    changedSegment.push([...ring[idx]]);
    displacedCount++;

    if (firstChangedIdx === -1) firstChangedIdx = idx;
    lastChangedIdx = idx;
  }

  // Re-close the ring
  ring[ring.length - 1] = [...ring[0]];

  if (displacedCount === 0) return empty;

  // Connection points: the first and last displaced vertices
  const connStart: Position = [...ring[firstChangedIdx]];
  const connEnd: Position = [...ring[lastChangedIdx]];

  return {
    geometry: result,
    quality: 'good',
    changedSegment,
    connectionPoints: { start: connStart, end: connEnd },
    displacedCount,
  };
}

/**
 * Detect all neighboring patches that share boundaries with a given patch.
 * This is a convenience wrapper around findAdjacentPatches that scans all rings
 * and deduplicates to the strongest match per neighbor.
 * Used for pre-edit neighbor detection (before the user simplifies/edits).
 */
export function detectNeighbors(
  patchId: string,
  geometry: MultiPolygon,
  allPatches: PatchFeature[]
): AdjacentPatchInfo[] {
  const candidates: AdjacentPatchInfo[] = [];
  for (let pi = 0; pi < geometry.coordinates.length; pi++) {
    const polygon = geometry.coordinates[pi];
    for (let ri = 0; ri < polygon.length; ri++) {
      const ring = polygon[ri];
      const matches = findAdjacentPatches(patchId, ring, allPatches, pi, ri);
      candidates.push(...matches);
    }
  }

  // Keep strongest match per patch
  const byPatchId = new Map<string, AdjacentPatchInfo>();
  for (const c of candidates) {
    const existing = byPatchId.get(c.patchId);
    if (!existing || c.matchedVertexCount > existing.matchedVertexCount) {
      byPatchId.set(c.patchId, c);
    }
  }
  return Array.from(byPatchId.values());
}

/**
 * Generate boundary proposals for all neighbouring patches.
 *
 * Uses a **displacement** approach: for each neighbour vertex that sits on
 * the shared boundary (detected via proximity to the OLD edited ring), we
 * compute how much the boundary moved (old → new) and shift the vertex by
 * the same amount.  This is robust to simplification-induced vertex-count
 * mismatches and avoids both the splice artefact (straight lines from few
 * vertices replacing many) and the projection artefact (vertices jumping
 * to the wrong side of the edited ring).
 *
 * When `oldEditedGeometry` is not provided, falls back to the projection
 * approach using the edited ring's indices.
 */
export function generateBoundaryProposals(
  analysis: PostEditAnalysis,
  editedGeometry: MultiPolygon,
  allPatches: PatchFeature[],
  oldEditedGeometry?: MultiPolygon,
): BoundaryProposal[] {
  const proposals: BoundaryProposal[] = [];

  for (const neighbour of analysis.neighbours) {
    const neighbourPatch = allPatches.find(f => f.properties.id === neighbour.patchId);
    if (!neighbourPatch || !neighbourPatch.geometry) continue;

    const neighbourGeom = neighbourPatch.geometry.type === 'MultiPolygon'
      ? neighbourPatch.geometry as MultiPolygon
      : {
          type: 'MultiPolygon' as const,
          coordinates: [neighbourPatch.geometry.coordinates],
        };

    const adjacentInfo = neighbour.adjacentInfo;

    // --- neighbour's original shared segment (for display) ---
    const neighbourRing =
      neighbourGeom.coordinates[adjacentInfo.polygonIndex]?.[adjacentInfo.ringIndex];
    if (!neighbourRing) continue;

    const originalSegment = extractSegmentFromRing(
      neighbourRing,
      adjacentInfo.startIndex,
      adjacentInfo.endIndex,
    );
    if (originalSegment.length < 2) continue;

    // --- Displacement approach (preferred) ---
    if (oldEditedGeometry) {
      const oldRing =
        oldEditedGeometry.coordinates[adjacentInfo.editedPolygonIndex]?.[adjacentInfo.editedRingIndex];
      const newRing =
        editedGeometry.coordinates[adjacentInfo.editedPolygonIndex]?.[adjacentInfo.editedRingIndex];

      if (oldRing && newRing) {
        const {
          geometry: proposedGeometry,
          quality,
          changedSegment,
          connectionPoints,
          displacedCount,
        } = syncBoundaryByDisplacement(
          neighbourGeom,
          oldRing,
          newRing,
          adjacentInfo.polygonIndex,
          adjacentInfo.ringIndex,
        );

        if (displacedCount > 0) {
          proposals.push({
            patchId: neighbour.patchId,
            patchCode: neighbour.patchCode,
            relationship: neighbour.relationship,
            adjacentInfo,
            originalGeometry: neighbourGeom,
            proposedGeometry,
            originalSegment,
            proposedSegment: changedSegment,
            changedSegment,
            connectionPoints,
            snapQuality: quality,
          });
          continue;
        }
        // displacedCount === 0 → fall through to projection fallback
      }
    }

    // --- Fallback: projection approach ---
    const editedRing =
      editedGeometry.coordinates[adjacentInfo.editedPolygonIndex]?.[adjacentInfo.editedRingIndex];
    if (!editedRing) continue;

    const replacementSegment = extractSegmentFromRing(
      editedRing,
      adjacentInfo.editedStartIndex,
      adjacentInfo.editedEndIndex,
    );
    if (replacementSegment.length < 2) continue;

    const { geometry: proposedGeometry, quality, changedSegment, connectionPoints } =
      syncBoundaryByProjection(neighbourGeom, replacementSegment, adjacentInfo);

    const finalSegment = changedSegment.length > 0 ? changedSegment : replacementSegment;

    proposals.push({
      patchId: neighbour.patchId,
      patchCode: neighbour.patchCode,
      relationship: neighbour.relationship,
      adjacentInfo,
      originalGeometry: neighbourGeom,
      proposedGeometry,
      originalSegment,
      proposedSegment: finalSegment,
      changedSegment: finalSegment,
      connectionPoints,
      snapQuality: quality,
    });
  }

  return proposals;
}
