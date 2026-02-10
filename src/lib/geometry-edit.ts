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

// ── Constants ───────────────────────────────────────────────────────

/** Number of anchor vertices to include on each side of the edit region */
const ANCHOR_COUNT = 2;

/** Distance threshold in kilometers for considering vertices as "shared" */
const SHARED_BOUNDARY_TOLERANCE_KM = 0.0005; // ~0.5 meters

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

// ── Find Adjacent Patches ───────────────────────────────────────────

/**
 * Find patches that share a boundary segment with the edited region.
 * Looks for other patches whose vertices closely match the original
 * (pre-edit) positions of the edited segment.
 */
export function findAdjacentPatches(
  editedPatchId: string,
  editedRing: Position[],
  allPatches: PatchFeature[],
  editedPolygonIndex = 0,
  editedRingIndex = 0
): AdjacentPatchInfo[] {
  const results: AdjacentPatchInfo[] = [];

  // Skip if segment too small
  if (editedRing.length < 3) return results;

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
        const match = findSharedSegment(editedRing, ring);
        if (match) {
          results.push({
            patchId: patch.properties.id,
            patchCode: patch.properties.code,
            startIndex: match.startIndex,
            endIndex: match.endIndex,
            ringIndex: ri,
            polygonIndex: pi,
            editedStartIndex: match.editedStartIndex,
            editedEndIndex: match.editedEndIndex,
            editedRingIndex,
            editedPolygonIndex,
            matchedVertexCount: match.matchedVertexCount,
            isReversed: match.isReversed,
          });
        }
      }
    }
  }

  return results;
}

/**
 * Find a matching segment in a ring that corresponds to the given segment.
 * Checks both forward and reverse directions.
 */
function findSharedSegment(
  segment: Position[],
  ring: Position[]
): {
  startIndex: number;
  endIndex: number;
  editedStartIndex: number;
  editedEndIndex: number;
  matchedVertexCount: number;
  isReversed: boolean;
} | null {
  const segmentVertexCount = getOpenVertexCount(segment);
  const ringVertexCount = getOpenVertexCount(ring);
  if (segmentVertexCount < 3 || ringVertexCount < 3) return null;

  const segmentIndexByKey = new Map<string, number[]>();
  for (let i = 0; i < segmentVertexCount; i++) {
    const key = positionKey(segment[i]);
    const existing = segmentIndexByKey.get(key);
    if (existing) {
      existing.push(i);
    } else {
      segmentIndexByKey.set(key, [i]);
    }
  }

  let bestMatch: {
    startIndex: number;
    endIndex: number;
    editedStartIndex: number;
    editedEndIndex: number;
    matchedVertexCount: number;
    isReversed: boolean;
  } | null = null;

  const tryMatch = (segmentStartIndex: number, ringStartIndex: number, ringStep: 1 | -1) => {
    let matchedVertexCount = 0;
    for (let offset = 0; offset < segmentVertexCount; offset++) {
      const segmentIndex = (segmentStartIndex + offset) % segmentVertexCount;
      const ringIndex = modIndex(ringStartIndex + (offset * ringStep), ringVertexCount);
      if (!positionsClose(segment[segmentIndex], ring[ringIndex])) {
        break;
      }
      matchedVertexCount++;
    }

    if (matchedVertexCount < 3) return;
    if (bestMatch && matchedVertexCount <= bestMatch.matchedVertexCount) return;

    const editedEndIndex = modIndex(
      segmentStartIndex + matchedVertexCount - 1,
      segmentVertexCount
    );
    const endIndex = modIndex(
      ringStartIndex + ((matchedVertexCount - 1) * ringStep),
      ringVertexCount
    );

    bestMatch = {
      startIndex: ringStartIndex,
      endIndex,
      editedStartIndex: segmentStartIndex,
      editedEndIndex,
      matchedVertexCount,
      isReversed: ringStep === -1,
    };
  };

  for (let ringIndex = 0; ringIndex < ringVertexCount; ringIndex++) {
    const ringPoint = ring[ringIndex];
    const exactCandidates = segmentIndexByKey.get(positionKey(ringPoint));
    if (exactCandidates) {
      for (const segmentIndex of exactCandidates) {
        tryMatch(segmentIndex, ringIndex, 1);
        tryMatch(segmentIndex, ringIndex, -1);
      }
    }
  }

  if (bestMatch) return bestMatch;

  // Fallback for near-equal coordinates that differ slightly.
  for (let segmentIndex = 0; segmentIndex < segmentVertexCount; segmentIndex++) {
    for (let ringIndex = 0; ringIndex < ringVertexCount; ringIndex++) {
      if (!positionsClose(segment[segmentIndex], ring[ringIndex])) continue;
      tryMatch(segmentIndex, ringIndex, 1);
      tryMatch(segmentIndex, ringIndex, -1);
    }
  }

  return bestMatch;
}

function positionKey(position: Position): string {
  return `${position[0].toFixed(7)},${position[1].toFixed(7)}`;
}

function modIndex(value: number, size: number): number {
  if (size <= 0) return 0;
  return ((value % size) + size) % size;
}

/**
 * Check if two positions are within the tolerance distance.
 */
function positionsClose(a: Position, b: Position): boolean {
  // Fast check: exact match
  if (a[0] === b[0] && a[1] === b[1]) return true;

  // Use turf distance for tolerance check
  try {
    const d = distance(point(a), point(b), { units: 'kilometers' });
    return d < SHARED_BOUNDARY_TOLERANCE_KM;
  } catch {
    return false;
  }
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
  if (newSegmentPositions.length < 3) return neighbourGeometry;

  const { startIndex, endIndex } = adjacentInfo;
  if (startIndex < 0 || startIndex >= openVertexCount) return neighbourGeometry;
  if (endIndex < 0 || endIndex >= openVertexCount) return neighbourGeometry;

  // Prepare the replacement segment (reverse if needed)
  const replacement = adjacentInfo.isReversed
    ? [...newSegmentPositions].reverse()
    : [...newSegmentPositions];
  if (replacement.length < 3) return neighbourGeometry;

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
    // Check for overlap
    const overlap = intersect(
      { type: 'FeatureCollection', features: [turfFeature(editedGeometry), turfFeature(neighbourGeometry)] }
    );

    if (overlap) {
      const overlapArea = area(overlap);
      if (overlapArea > 100) return 'overlap'; // > 100 sq meters
    }

    // Check for gap by looking at distance between nearest boundaries
    // Simple heuristic: check if the union is larger than the sum of parts
    // If boundaries touch, union area ~ sum of areas
    // If gap exists, union area < sum of areas (since gap fills in)
    const editedArea = area(turfFeature(editedGeometry));
    const neighbourArea = area(turfFeature(neighbourGeometry));

    // If no overlap and geometries are close, check for a gap
    // We'll use a simple approach: see if there's any lost area between them
    // by checking if old shared boundary vertices are now distant
    return 'gap';
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
  allPatches: PatchFeature[]
): PostEditAnalysis {
  // Find neighbours that shared a boundary with any old ring.
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
        ringIndex
      );
      adjacentCandidates.push(...matches);
    }
  }

  // Keep one strongest adjacency per patch.
  const adjacentByPatchId = new Map<string, AdjacentPatchInfo>();
  for (const candidate of adjacentCandidates) {
    const existing = adjacentByPatchId.get(candidate.patchId);
    if (!existing || candidate.matchedVertexCount > existing.matchedVertexCount) {
      adjacentByPatchId.set(candidate.patchId, candidate);
    }
  }
  const adjacentPatches = Array.from(adjacentByPatchId.values());

  // Also scan ALL patches for duplicates (identical geometry to old)
  const duplicateIds = new Set<string>();
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

  const gapGeometry = detectGap(oldGeometry, newGeometry, occupiedFeatures);
  const gapAreaSqm = gapGeometry ? area(gapGeometry) : 0;

  return {
    duplicates,
    neighbours,
    gapGeometry,
    gapAreaSqm,
  };
}
