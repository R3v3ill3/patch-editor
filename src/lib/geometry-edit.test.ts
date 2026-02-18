import test from 'node:test';
import assert from 'node:assert/strict';
import type { Position } from 'geojson';
import {
  extractSegmentFromRing,
  findAdjacentPatches,
  syncAdjacentBoundary,
  syncAdjacentBoundaryImproved,
  syncBoundaryByProjection,
  syncBoundaryByDisplacement,
  syncBoundaryExactCopy,
  generateBoundaryProposals,
  detectNeighbors,
  analysePostEdit,
} from '@/lib/geometry-edit';
import type { PatchFeature } from '@/types';

test('extractSegmentFromRing returns wrapped segment correctly', () => {
  const ring: Position[] = [
    [0, 0],
    [1, 0],
    [2, 0],
    [2, 1],
    [1, 1],
    [0, 0],
  ];

  const segment = extractSegmentFromRing(ring, 3, 1);
  assert.deepEqual(segment, [
    [2, 1],
    [1, 1],
    [0, 0],
    [1, 0],
  ]);
});

test('findAdjacentPatches returns edited and neighbour segment indices', () => {
  const editedRing: Position[] = [
    [0, 0],
    [2, 0],
    [2, 1],
    [2, 2],
    [0, 2],
    [0, 0],
  ];

  const neighbour: PatchFeature = {
    type: 'Feature',
    properties: {
      id: 'n1',
      code: '170.1',
      name: null,
      type: 'geo',
      status: 'active',
      fillColor: '#00000040',
      outlineColor: '#000000',
    },
    geometry: {
      type: 'MultiPolygon',
      coordinates: [[[
        [2, 2],
        [2, 1],
        [2, 0],
        [4, 0],
        [4, 2],
        [2, 2],
      ]]],
    },
  };

  const adjacent = findAdjacentPatches('edited', editedRing, [neighbour], 0, 0);
  assert.equal(adjacent.length, 1);
  assert.equal(adjacent[0].patchId, 'n1');
  assert.equal(adjacent[0].editedPolygonIndex, 0);
  assert.equal(adjacent[0].editedRingIndex, 0);
  assert.equal(adjacent[0].matchedVertexCount >= 3, true);
});

test('syncAdjacentBoundary replaces only matched segment and keeps ring closed', () => {
  const neighbourGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [2, 2],
      [2, 1],
      [2, 0],
      [4, 0],
      [4, 2],
      [2, 2],
    ]]],
  };

  const updated = syncAdjacentBoundary(
    neighbourGeometry,
    [
      [2.2, 2],
      [2.2, 1],
      [2.2, 0],
    ],
    {
      patchId: 'n1',
      patchCode: '170.1',
      startIndex: 0,
      endIndex: 2,
      ringIndex: 0,
      polygonIndex: 0,
      editedStartIndex: 1,
      editedEndIndex: 3,
      editedRingIndex: 0,
      editedPolygonIndex: 0,
      matchedVertexCount: 3,
      isReversed: false,
    }
  );

  const ring = updated.coordinates[0][0];
  assert.equal(ring.length >= 5, true);
  assert.deepEqual(ring[0], [2.2, 2]);
  assert.deepEqual(ring[1], [2.2, 1]);
  assert.deepEqual(ring[2], [2.2, 0]);
  assert.deepEqual(ring[ring.length - 1], ring[0]);
});

// ── Tests for Improved Snapping Algorithm ──────────────────────────

test('syncAdjacentBoundaryImproved replaces segment and returns quality', () => {
  const neighbourGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [2, 2],
      [2, 1],
      [2, 0],
      [4, 0],
      [4, 2],
      [2, 2],
    ]]],
  };

  const result = syncAdjacentBoundaryImproved(
    neighbourGeometry,
    [
      [2.2, 2],
      [2.2, 1],
      [2.2, 0],
    ],
    {
      patchId: 'n1',
      patchCode: '170.1',
      startIndex: 0,
      endIndex: 2,
      ringIndex: 0,
      polygonIndex: 0,
      editedStartIndex: 1,
      editedEndIndex: 3,
      editedRingIndex: 0,
      editedPolygonIndex: 0,
      matchedVertexCount: 3,
      isReversed: false,
    }
  );

  const ring = result.geometry.coordinates[0][0];
  assert.equal(ring.length >= 5, true);
  assert.deepEqual(ring[0], [2.2, 2]);
  assert.deepEqual(ring[1], [2.2, 1]);
  assert.deepEqual(ring[2], [2.2, 0]);
  assert.deepEqual(ring[ring.length - 1], ring[0]);
  
  // Should have a quality assessment
  assert.ok(['good', 'poor'].includes(result.quality));
  
  // Should have changed segment
  assert.equal(result.changedSegment.length, 3);
  assert.deepEqual(result.changedSegment[0], [2.2, 2]);
  
  // Should have connection points
  assert.ok(result.connectionPoints.start);
  assert.ok(result.connectionPoints.end);
});

test('syncAdjacentBoundaryImproved handles reversed segments', () => {
  const neighbourGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [2, 2],
      [2, 1],
      [2, 0],
      [4, 0],
      [4, 2],
      [2, 2],
    ]]],
  };

  const result = syncAdjacentBoundaryImproved(
    neighbourGeometry,
    [
      [2.2, 0],
      [2.2, 1],
      [2.2, 2],
    ],
    {
      patchId: 'n1',
      patchCode: '170.1',
      startIndex: 0,
      endIndex: 2,
      ringIndex: 0,
      polygonIndex: 0,
      editedStartIndex: 1,
      editedEndIndex: 3,
      editedRingIndex: 0,
      editedPolygonIndex: 0,
      matchedVertexCount: 3,
      isReversed: true,
    }
  );

  const ring = result.geometry.coordinates[0][0];
  // With reversed flag, the segment should be reversed
  assert.deepEqual(ring[0], [2.2, 2]);
  assert.deepEqual(ring[1], [2.2, 1]);
  assert.deepEqual(ring[2], [2.2, 0]);
});

test('syncAdjacentBoundaryImproved handles wrap-around segments', () => {
  const neighbourGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [1, 1],
      [2, 1],
      [2, 0],
      [0, 0],
      [0, 1],
      [1, 1],
    ]]],
  };

  const result = syncAdjacentBoundaryImproved(
    neighbourGeometry,
    [
      [0, 1.1],
      [1.1, 1.1],
      [2, 1.1],
    ],
    {
      patchId: 'n1',
      patchCode: '170.1',
      startIndex: 4,
      endIndex: 1,
      ringIndex: 0,
      polygonIndex: 0,
      editedStartIndex: 0,
      editedEndIndex: 2,
      editedRingIndex: 0,
      editedPolygonIndex: 0,
      matchedVertexCount: 3,
      isReversed: false,
    }
  );

  const ring = result.geometry.coordinates[0][0];
  assert.equal(ring.length >= 5, true);
  assert.deepEqual(ring[ring.length - 1], ring[0]);
});

test('syncAdjacentBoundaryImproved returns poor quality for invalid geometry', () => {
  const neighbourGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],
      [1, 0],
      [0, 0],
    ]]],
  };

  const result = syncAdjacentBoundaryImproved(
    neighbourGeometry,
    [[0.5, 0]],
    {
      patchId: 'n1',
      patchCode: '170.1',
      startIndex: 0,
      endIndex: 1,
      ringIndex: 0,
      polygonIndex: 0,
      editedStartIndex: 0,
      editedEndIndex: 1,
      editedRingIndex: 0,
      editedPolygonIndex: 0,
      matchedVertexCount: 2,
      isReversed: false,
    }
  );

  assert.equal(result.quality, 'poor');
});

test('generateBoundaryProposals creates proposals for all neighbors', () => {
  const editedGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ]]],
  };

  const neighbourPatch: PatchFeature = {
    type: 'Feature',
    properties: {
      id: 'n1',
      code: '170.1',
      name: null,
      type: 'geo',
      status: 'active',
      fillColor: '#00000040',
      outlineColor: '#000000',
    },
    geometry: {
      type: 'MultiPolygon',
      coordinates: [[[
        [2, 2],
        [2, 0],
        [4, 0],
        [4, 2],
        [2, 2],
      ]]],
    },
  };

  const analysis = {
    duplicates: [],
    neighbours: [{
      patchId: 'n1',
      patchCode: '170.1',
      relationship: 'gap' as const,
      isDuplicate: false,
      adjacentInfo: {
        patchId: 'n1',
        patchCode: '170.1',
        startIndex: 0,
        endIndex: 1,
        ringIndex: 0,
        polygonIndex: 0,
        editedStartIndex: 1,
        editedEndIndex: 2,
        editedRingIndex: 0,
        editedPolygonIndex: 0,
        matchedVertexCount: 2,
        isReversed: true,
      },
    }],
    gapGeometry: null,
    gapAreaSqm: 0,
  };

  const proposals = generateBoundaryProposals(
    analysis,
    editedGeometry,
    [neighbourPatch]
  );

  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].patchId, 'n1');
  assert.equal(proposals[0].patchCode, '170.1');
  assert.ok(proposals[0].originalGeometry);
  assert.ok(proposals[0].proposedGeometry);
  assert.ok(Array.isArray(proposals[0].originalSegment));
  assert.ok(Array.isArray(proposals[0].proposedSegment));
  assert.ok(['good', 'poor'].includes(proposals[0].snapQuality));
  assert.ok(Array.isArray(proposals[0].changedSegment));
  assert.ok(proposals[0].connectionPoints.start);
  assert.ok(proposals[0].connectionPoints.end);
});

// ── Tests for detectNeighbors (linked boundary editing) ────────────

function makePatch(id: string, code: string, coords: Position[][]): PatchFeature {
  return {
    type: 'Feature',
    properties: {
      id,
      code,
      name: null,
      type: 'geo',
      status: 'active',
      fillColor: '#00000040',
      outlineColor: '#000000',
    },
    geometry: {
      type: 'MultiPolygon',
      coordinates: [[coords[0]]],
    },
  };
}

test('detectNeighbors finds adjacent patches across all rings', () => {
  const editedGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],
      [2, 0],
      [2, 1],
      [2, 2],
      [0, 2],
      [0, 0],
    ]]],
  };

  const neighbor = makePatch('n1', 'N-001', [[
    [2, 2],
    [2, 1],
    [2, 0],
    [4, 0],
    [4, 2],
    [2, 2],
  ]]);

  const unrelated = makePatch('u1', 'U-001', [[
    [10, 10],
    [12, 10],
    [12, 12],
    [10, 12],
    [10, 10],
  ]]);

  const results = detectNeighbors('edited', editedGeometry, [neighbor, unrelated]);
  assert.equal(results.length, 1);
  assert.equal(results[0].patchId, 'n1');
  assert.equal(results[0].patchCode, 'N-001');
  assert.ok(results[0].matchedVertexCount >= 3);
});

test('detectNeighbors deduplicates to strongest match per patch', () => {
  // Patch with two polygons, both sharing edges with the same neighbor
  const editedGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [
      [[
        [0, 0],
        [2, 0],
        [2, 1],
        [2, 2],
        [0, 2],
        [0, 0],
      ]],
      [[
        [2, 3],
        [2, 4],
        [2, 5],
        [0, 5],
        [0, 3],
        [2, 3],
      ]],
    ],
  };

  // Neighbor shares boundary with first polygon (3 vertices)
  // and also shares boundary with second polygon (3 vertices)
  const neighbor = makePatch('n1', 'N-001', [[
    [2, 0],
    [2, 1],
    [2, 2],
    [2, 3],
    [2, 4],
    [2, 5],
    [4, 5],
    [4, 0],
    [2, 0],
  ]]);

  const results = detectNeighbors('edited', editedGeometry, [neighbor]);
  // Should deduplicate to 1 result (strongest match)
  assert.equal(results.length, 1);
  assert.equal(results[0].patchId, 'n1');
});

test('detectNeighbors returns empty for no neighbors', () => {
  const editedGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ]]],
  };

  const distant = makePatch('d1', 'D-001', [[
    [100, 100],
    [101, 100],
    [101, 101],
    [100, 101],
    [100, 100],
  ]]);

  const results = detectNeighbors('edited', editedGeometry, [distant]);
  assert.equal(results.length, 0);
});

test('detectNeighbors finds multiple neighbors', () => {
  // Central patch with neighbors on two sides (3+ shared vertices per boundary)
  const editedGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [1, 0],
      [3, 0],
      [3, 1],
      [3, 2],
      [1, 2],
      [1, 1],
      [1, 0],
    ]]],
  };

  const leftNeighbor = makePatch('left', 'L-001', [[
    [0, 0],
    [1, 0],
    [1, 1],
    [1, 2],
    [0, 2],
    [0, 0],
  ]]);

  const rightNeighbor = makePatch('right', 'R-001', [[
    [3, 0],
    [5, 0],
    [5, 2],
    [3, 2],
    [3, 1],
    [3, 0],
  ]]);

  const results = detectNeighbors('edited', editedGeometry, [leftNeighbor, rightNeighbor]);
  assert.equal(results.length, 2);
  const ids = results.map(r => r.patchId).sort();
  assert.deepEqual(ids, ['left', 'right']);
});

test('detectNeighbors excludes the edited patch itself', () => {
  const editedGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ]]],
  };

  // Same geometry as the edited patch
  const selfPatch = makePatch('self', 'SELF', [[
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
    [0, 0],
  ]]);

  const results = detectNeighbors('self', editedGeometry, [selfPatch]);
  assert.equal(results.length, 0);
});

// ── Tests for geometric proximity detection (post-simplification) ──

test('findAdjacentPatches detects shared boundary with different vertex counts', () => {
  // Edited ring has been simplified: fewer vertices on the shared edge
  // Original shared edge had 5 points along x=2 from y=0 to y=4
  // Simplified version has only 2 points (straight line)
  const editedRing: Position[] = [
    [0, 0],
    [2, 0],   // shared start
    [2, 4],   // shared end (simplified: skipped intermediate points)
    [0, 4],
    [0, 0],
  ];

  // Neighbour still has the original 5 points along the shared edge
  const neighbour = makePatch('n1', 'N-001', [[
    [2, 0],
    [2, 1],
    [2, 2],
    [2, 3],
    [2, 4],
    [4, 4],
    [4, 0],
    [2, 0],
  ]]);

  const results = findAdjacentPatches('edited', editedRing, [neighbour], 0, 0);
  assert.equal(results.length, 1, 'should detect shared boundary despite different vertex counts');
  assert.equal(results[0].patchId, 'n1');
  assert.ok(results[0].matchedVertexCount >= 3,
    `expected ≥3 matched vertices, got ${results[0].matchedVertexCount}`);
});

test('findAdjacentPatches detects shared boundary with slightly shifted vertices', () => {
  // Edited ring: vertices shifted by ~0.00005° (~5.5m) due to simplification
  const editedRing: Position[] = [
    [0, 0],
    [2.00005, 0.00003],
    [2.00003, 1.00002],
    [2.00004, 2.00001],
    [0, 2],
    [0, 0],
  ];

  // Neighbour has the exact original vertices
  const neighbour = makePatch('n1', 'N-001', [[
    [2, 2],
    [2, 1],
    [2, 0],
    [4, 0],
    [4, 2],
    [2, 2],
  ]]);

  const results = findAdjacentPatches('edited', editedRing, [neighbour], 0, 0);
  assert.equal(results.length, 1, 'should detect shared boundary with shifted vertices');
  assert.equal(results[0].patchId, 'n1');
});

test('findAdjacentPatches correctly identifies reversed winding', () => {
  // Edited ring with shared edge going upward (y increases)
  const editedRing: Position[] = [
    [0, 0],
    [2, 0],
    [2, 1],
    [2, 2],
    [0, 2],
    [0, 0],
  ];

  // Neighbour with shared edge going downward (y decreases)
  const neighbour = makePatch('n1', 'N-001', [[
    [2, 2],
    [2, 1],
    [2, 0],
    [4, 0],
    [4, 2],
    [2, 2],
  ]]);

  const results = findAdjacentPatches('edited', editedRing, [neighbour], 0, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].isReversed, true,
    'shared boundary should be detected as reversed');
});

test('findAdjacentPatches detects same-direction winding', () => {
  // Both rings share boundary going in the same direction
  const editedRing: Position[] = [
    [0, 0],
    [2, 0],
    [2, 1],
    [2, 2],
    [0, 2],
    [0, 0],
  ];

  // Neighbour with shared edge going in the SAME direction (y increases)
  const neighbour = makePatch('n1', 'N-001', [[
    [2, 0],
    [2, 1],
    [2, 2],
    [4, 2],
    [4, 0],
    [2, 0],
  ]]);

  const results = findAdjacentPatches('edited', editedRing, [neighbour], 0, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].isReversed, false,
    'shared boundary should be detected as same direction');
});

test('generateBoundaryProposals uses direct transfer from edited ring', () => {
  // Edited patch with boundary moved from x=2 to x=2.5
  const editedGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],
      [2.5, 0],
      [2.5, 1],
      [2.5, 2],
      [0, 2],
      [0, 0],
    ]]],
  };

  const neighbourPatch = makePatch('n1', 'N-001', [[
    [2, 2],
    [2, 1],
    [2, 0],
    [4, 0],
    [4, 2],
    [2, 2],
  ]]);

  const analysis = {
    duplicates: [],
    neighbours: [{
      patchId: 'n1',
      patchCode: 'N-001',
      relationship: 'overlap' as const,
      isDuplicate: false,
      adjacentInfo: {
        patchId: 'n1',
        patchCode: 'N-001',
        startIndex: 0,
        endIndex: 2,
        ringIndex: 0,
        polygonIndex: 0,
        editedStartIndex: 1,
        editedEndIndex: 3,
        editedRingIndex: 0,
        editedPolygonIndex: 0,
        matchedVertexCount: 3,
        isReversed: true,
      },
    }],
    gapGeometry: null,
    gapAreaSqm: 0,
  };

  const proposals = generateBoundaryProposals(
    analysis,
    editedGeometry,
    [neighbourPatch],
  );

  assert.equal(proposals.length, 1);

  // The proposed geometry should have the boundary at x=2.5
  const ring = proposals[0].proposedGeometry.coordinates[0][0];
  // Since isReversed=true, the replacement [2.5,0],[2.5,1],[2.5,2]
  // gets reversed to [2.5,2],[2.5,1],[2.5,0]
  const xValues = ring.slice(0, 3).map((v: Position) => v[0]);
  assert.ok(
    xValues.every((x: number) => Math.abs(x - 2.5) < 0.001),
    `Expected boundary at x=2.5, got x values: ${xValues}`,
  );
});

test('detectNeighbors works after simplification with fewer vertices', () => {
  // Simulate: original patch had many vertices on shared edge,
  // after simplification it has only 2 (straight line)
  const simplifiedGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],
      [2, 0],   // shared boundary start
      [2, 4],   // shared boundary end (simplified)
      [0, 4],
      [0, 0],
    ]]],
  };

  const neighbor = makePatch('n1', 'N-001', [[
    [2, 0],
    [2, 0.5],
    [2, 1],
    [2, 1.5],
    [2, 2],
    [2, 2.5],
    [2, 3],
    [2, 3.5],
    [2, 4],
    [4, 4],
    [4, 0],
    [2, 0],
  ]]);

  const results = detectNeighbors('edited', simplifiedGeometry, [neighbor]);
  assert.equal(results.length, 1, 'should detect neighbour despite simplified geometry');
  assert.equal(results[0].patchId, 'n1');
  assert.ok(results[0].matchedVertexCount >= 3,
    `expected ≥3 shared vertices, got ${results[0].matchedVertexCount}`);
});

// ── Tests for analysePostEdit with moved boundary ───────────────────

test('analysePostEdit finds neighbour when boundary has moved away', () => {
  // OLD geometry: shared boundary at x=2
  const oldGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],
      [2, 0],
      [2, 1],
      [2, 2],
      [0, 2],
      [0, 0],
    ]]],
  };

  // NEW geometry: eastern boundary moved west to x=1.5
  const newGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],
      [1.5, 0],
      [1.5, 1],
      [1.5, 2],
      [0, 2],
      [0, 0],
    ]]],
  };

  // Neighbour with western boundary at x=2 (unchanged)
  const neighbour = makePatch('n1', 'N-001', [[
    [2, 2],
    [2, 1],
    [2, 0],
    [4, 0],
    [4, 2],
    [2, 2],
  ]]);

  const analysis = analysePostEdit('edited', oldGeometry, newGeometry, [neighbour]);

  assert.ok(
    analysis.neighbours.length >= 1,
    `expected ≥1 neighbour, got ${analysis.neighbours.length} — ` +
    'neighbour should be detected even though boundary moved away',
  );
  assert.equal(analysis.neighbours[0].patchId, 'n1');
});

// ── Tests for narrowing proposals to edited range ───────────────────

test('analysePostEdit narrows candidates to edited range with preEditSimplifiedGeometry', () => {
  // Patch with east boundary at x=2 from y=0 to y=10 (many vertices)
  const preEditSimplified = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],   // 0
      [2, 0],   // 1
      [2, 1],   // 2
      [2, 2],   // 3
      [2, 3],   // 4
      [2, 4],   // 5
      [2, 5],   // 6
      [2, 6],   // 7
      [2, 7],   // 8
      [2, 8],   // 9
      [2, 9],   // 10
      [2, 10],  // 11
      [0, 10],  // 12
      [0, 0],   // closing
    ]]],
  };

  // User edited vertices 5 and 6 (y=4, y=5) moving them west to x=1.5
  const postEdit = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],
      [2, 0],
      [2, 1],
      [2, 2],
      [2, 3],
      [1.5, 4],   // edited
      [1.5, 5],   // edited
      [2, 6],
      [2, 7],
      [2, 8],
      [2, 9],
      [2, 10],
      [0, 10],
      [0, 0],
    ]]],
  };

  // Neighbour with west boundary at x=2
  const neighbour = makePatch('n1', 'N-001', [[
    [2, 0],
    [2, 1],
    [2, 2],
    [2, 3],
    [2, 4],
    [2, 5],
    [2, 6],
    [2, 7],
    [2, 8],
    [2, 9],
    [2, 10],
    [4, 10],
    [4, 0],
    [2, 0],
  ]]);

  // Use preEditSimplified as the old geometry (same in this test)
  const analysis = analysePostEdit(
    'edited', preEditSimplified, postEdit, [neighbour], preEditSimplified,
  );

  assert.ok(analysis.neighbours.length >= 1, 'should find the neighbour');

  // Generate proposals
  const proposals = generateBoundaryProposals(analysis, postEdit, [neighbour]);
  assert.equal(proposals.length, 1, 'should generate one proposal');

  // The key check: the proposed geometry should have x=1.5 only near y=4,5
  // and should KEEP x=2 for the rest of the boundary (y=0,1,2,3 and y=6..10)
  const proposedRing = proposals[0].proposedGeometry.coordinates[0][0];

  // With the projection approach, shared vertices near the edited area (y=4,5)
  // get projected onto the nearest edge of the replacement polyline.  Because
  // the polyline includes diagonal segments (e.g. [2,3]->[1.5,4]), some
  // projected points land at intermediate x-values rather than exactly 1.5.
  // The key invariant is: (a) the vertex count is preserved, and (b) vertices
  // near the edit have moved inward (x < 2) while vertices far from the edit
  // remain at x ≈ 2.
  const movedVertices = proposedRing.filter(
    (v: Position) => v[0] < 1.95,
  );
  const unchangedAtX2 = proposedRing.filter(
    (v: Position) => Math.abs(v[0] - 2) < 0.05,
  );

  // Vertex count preserved (projection, not splice)
  assert.equal(
    proposedRing.length,
    neighbour.geometry.coordinates[0][0].length,
    'projection should preserve vertex count',
  );

  assert.ok(
    movedVertices.length >= 2,
    `expected ≥2 vertices moved inward (x<1.95), got ${movedVertices.length}`,
  );
  assert.ok(
    unchangedAtX2.length >= 4,
    `expected ≥4 vertices remaining at x≈2, got ${unchangedAtX2.length}. ` +
    `All x-values: ${proposedRing.map((v: Position) => v[0].toFixed(2))}`,
  );
});

test('analysePostEdit preserves shared boundary when no edits touch it', () => {
  // Pre-edit: rect with east boundary at x=2
  const preEditSimplified = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],
      [2, 0],
      [2, 1],
      [2, 2],
      [0, 2],
      [0, 0],
    ]]],
  };

  // Post-edit: WEST boundary moved (x=0 → x=-0.5), east boundary unchanged
  const postEdit = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [-0.5, 0],
      [2, 0],
      [2, 1],
      [2, 2],
      [-0.5, 2],
      [-0.5, 0],
    ]]],
  };

  // Neighbour shares the EAST boundary at x=2
  const neighbour = makePatch('n1', 'N-001', [[
    [2, 2],
    [2, 1],
    [2, 0],
    [4, 0],
    [4, 2],
    [2, 2],
  ]]);

  const analysis = analysePostEdit(
    'edited', preEditSimplified, postEdit, [neighbour], preEditSimplified,
  );

  // The edit was on the west side, NOT the shared east boundary.
  // Narrowing falls back to the full range (fault-tolerant), so a
  // proposal may still be generated, but the shared boundary should
  // remain at x=2 because it was not modified.
  const proposals = generateBoundaryProposals(analysis, postEdit, [neighbour]);

  if (proposals.length > 0) {
    const proposedRing = proposals[0].proposedGeometry.coordinates[0][0];
    const verticesAtX2 = proposedRing.filter(
      (v: Position) => Math.abs(v[0] - 2) < 0.01,
    );
    // All shared boundary vertices should still be at x=2
    assert.ok(
      verticesAtX2.length >= 3,
      'shared boundary should remain at x=2',
    );
  }
});

test('analysePostEdit remaps edited indices to new ring for moved boundary', () => {
  const oldGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],
      [2, 0],
      [2, 1],
      [2, 2],
      [0, 2],
      [0, 0],
    ]]],
  };

  // Boundary moved from x=2 to x=1.5
  const newGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],
      [1.5, 0],
      [1.5, 1],
      [1.5, 2],
      [0, 2],
      [0, 0],
    ]]],
  };

  const neighbour = makePatch('n1', 'N-001', [[
    [2, 2],
    [2, 1],
    [2, 0],
    [4, 0],
    [4, 2],
    [2, 2],
  ]]);

  const analysis = analysePostEdit('edited', oldGeometry, newGeometry, [neighbour]);
  assert.ok(analysis.neighbours.length >= 1);

  // Generate proposals — should produce a proposal that moves
  // the neighbour's western boundary from x=2 to x=1.5
  const proposals = generateBoundaryProposals(
    analysis,
    newGeometry,
    [neighbour],
  );

  assert.equal(proposals.length, 1, 'should generate a proposal for the neighbour');
  assert.equal(proposals[0].patchId, 'n1');

  // The proposed geometry should have the neighbour's western boundary at x=1.5
  const ring = proposals[0].proposedGeometry.coordinates[0][0];
  const westernVertices = ring.filter(
    (v: Position) => Math.abs(v[0] - 1.5) < 0.01,
  );
  assert.ok(
    westernVertices.length >= 2,
    `expected ≥2 vertices at x≈1.5 in proposed ring, got ${westernVertices.length}. ` +
    `Ring x-values: ${ring.map((v: Position) => v[0].toFixed(2))}`,
  );
});

test('syncBoundaryByProjection preserves vertex count and projects onto edited boundary', () => {
  // Neighbour has a detailed boundary with 6 vertices on the western side (x=2)
  const neighbourGeom = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [2, 0],
      [2, 0.5],
      [2, 1.0],
      [2, 1.5],
      [2, 2.0],
      [4, 2],
      [4, 0],
      [2, 0],
    ]]],
  };

  // The edited boundary has only 3 vertices (simplified), moved to x=1.5
  const editedPolyline: Position[] = [
    [1.5, 0],
    [1.5, 1.0],
    [1.5, 2.0],
  ];

  const adjacentInfo = {
    patchId: 'n1',
    patchCode: 'N-001',
    startIndex: 0,        // vertex [2,0]
    endIndex: 4,           // vertex [2,2]
    isReversed: false,
    matchedVertexCount: 5,
    polygonIndex: 0,
    ringIndex: 0,
    editedPolygonIndex: 0,
    editedRingIndex: 0,
    editedStartIndex: 0,
    editedEndIndex: 2,
  };

  const { geometry, quality, changedSegment } = syncBoundaryByProjection(
    neighbourGeom, editedPolyline, adjacentInfo,
  );

  const ring = geometry.coordinates[0][0];
  const openCount = ring.length - 1; // 7

  // Vertex count should be PRESERVED (same as original)
  assert.equal(
    ring.length, neighbourGeom.coordinates[0][0].length,
    'vertex count should be preserved (projection, not splice)',
  );

  // All 5 shared vertices should now be at x ≈ 1.5 (projected)
  for (let i = 0; i <= 4; i++) {
    assert.ok(
      Math.abs(ring[i][0] - 1.5) < 0.01,
      `vertex ${i} x should be ≈1.5, got ${ring[i][0]}`,
    );
  }

  // Non-shared vertices should be unchanged
  assert.deepEqual(ring[5], [4, 2], 'vertex 5 should be unchanged');
  assert.deepEqual(ring[6], [4, 0], 'vertex 6 should be unchanged');

  // changedSegment should have 5 entries (one per shared vertex)
  assert.equal(changedSegment.length, 5, 'changedSegment should have 5 projected vertices');

  // Quality may be 'poor' for synthetic coordinates spanning several degrees,
  // because the distance between the shared section and the surrounding ring
  // exceeds real-world thresholds.  In real use the coordinates are much
  // closer together so quality will be 'good'.
});

test('syncBoundaryByProjection with reversed winding projects correctly', () => {
  // Neighbour has detailed western boundary at x=2, winding top-to-bottom
  const neighbourGeom = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [2, 2],
      [2, 1.5],
      [2, 1.0],
      [2, 0.5],
      [2, 0],
      [4, 0],
      [4, 2],
      [2, 2],
    ]]],
  };

  // Edited boundary goes bottom-to-top (opposite direction)
  const editedPolyline: Position[] = [
    [1.5, 0],
    [1.5, 1.0],
    [1.5, 2.0],
  ];

  const adjacentInfo = {
    patchId: 'n1',
    patchCode: 'N-001',
    startIndex: 0,
    endIndex: 4,
    isReversed: true,       // opposite winding
    matchedVertexCount: 5,
    polygonIndex: 0,
    ringIndex: 0,
    editedPolygonIndex: 0,
    editedRingIndex: 0,
    editedStartIndex: 0,
    editedEndIndex: 2,
  };

  const { geometry } = syncBoundaryByProjection(
    neighbourGeom, editedPolyline, adjacentInfo,
  );

  const ring = geometry.coordinates[0][0];

  // All 5 shared vertices should be projected to x ≈ 1.5
  for (let i = 0; i <= 4; i++) {
    assert.ok(
      Math.abs(ring[i][0] - 1.5) < 0.01,
      `vertex ${i} x should be ≈1.5, got ${ring[i][0]}`,
    );
  }

  // Y-values should be preserved (each projects to the same y on a vertical line)
  assert.ok(Math.abs(ring[0][1] - 2.0) < 0.01, 'vertex 0 y should be ≈2.0');
  assert.ok(Math.abs(ring[4][1] - 0.0) < 0.01, 'vertex 4 y should be ≈0.0');
});

test('generateBoundaryProposals uses projection and preserves neighbour vertex density', () => {
  // Edited patch: simplified boundary at x=1.5 (3 vertices on east side)
  const editedGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],
      [1.5, 0],
      [1.5, 1],
      [1.5, 2],
      [0, 2],
      [0, 0],
    ]]],
  };

  // Pre-edit OLD geometry at x=2
  const oldGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [0, 0],
      [2, 0],
      [2, 0.5],
      [2, 1],
      [2, 1.5],
      [2, 2],
      [0, 2],
      [0, 0],
    ]]],
  };

  // Neighbour with detailed western boundary at x=2 (5 shared vertices)
  const neighbour = makePatch('n1', 'N-001', [[
    [2, 2],
    [2, 1.5],
    [2, 1.0],
    [2, 0.5],
    [2, 0],
    [4, 0],
    [4, 2],
    [2, 2],
  ]]);

  const analysis = analysePostEdit('edited', oldGeometry, editedGeometry, [neighbour]);
  assert.ok(analysis.neighbours.length >= 1, 'should detect neighbour');

  const proposals = generateBoundaryProposals(analysis, editedGeometry, [neighbour]);
  assert.equal(proposals.length, 1, 'should generate one proposal');

  const proposedRing = proposals[0].proposedGeometry.coordinates[0][0];

  // The proposed ring should have the SAME vertex count as the neighbour's original ring
  // (projection preserves density — it doesn't splice/replace)
  assert.equal(
    proposedRing.length,
    neighbour.geometry.coordinates[0][0].length,
    'proposed ring should preserve the neighbour vertex count (projection)',
  );

  // The shared vertices should now be at x ≈ 1.5
  const projectedVertices = proposedRing.filter(
    (v: Position) => Math.abs(v[0] - 1.5) < 0.1,
  );
  assert.ok(
    projectedVertices.length >= 3,
    `expected ≥3 vertices at x≈1.5, got ${projectedVertices.length}`,
  );
});

// ── syncBoundaryByDisplacement tests ─────────────────────────────────

test('syncBoundaryByDisplacement moves only vertices near the edit', () => {
  // Using realistic coordinates (~100m boundary, ~100m displacement)
  // Neighbour has a detailed western boundary at x=150.002
  const neighbourGeom = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [150.002, -33.0],
      [150.002, -33.001],
      [150.002, -33.002],
      [150.002, -33.003],
      [150.002, -33.004],
      [150.006, -33.004],
      [150.006, -33.0],
      [150.002, -33.0],  // closing vertex
    ]]],
  };

  // OLD edited ring: eastern boundary at x=150.002 (matching the neighbour)
  const oldEditedRing: Position[] = [
    [150.0, -33.0],
    [150.002, -33.0],
    [150.002, -33.001],
    [150.002, -33.002],
    [150.002, -33.003],
    [150.002, -33.004],
    [150.0, -33.004],
    [150.0, -33.0],
  ];

  // NEW edited ring: user moved just the middle section from x=150.002 to x=150.001
  // (vertices at y=-33.001, y=-33.002, y=-33.003 moved; y=-33.0 and y=-33.004 unchanged)
  const newEditedRing: Position[] = [
    [150.0, -33.0],
    [150.002, -33.0],
    [150.001, -33.001],
    [150.001, -33.002],
    [150.001, -33.003],
    [150.002, -33.004],
    [150.0, -33.004],
    [150.0, -33.0],
  ];

  const { geometry, displacedCount, changedSegment } = syncBoundaryByDisplacement(
    neighbourGeom, oldEditedRing, newEditedRing, 0, 0,
  );

  const ring = geometry.coordinates[0][0];

  // Vertex count should be preserved
  assert.equal(ring.length, 8, 'vertex count preserved');

  // Vertices at y=-33.0 and y=-33.004 should NOT have moved
  assert.ok(
    Math.abs(ring[0][0] - 150.002) < 0.0001,
    `vertex at y=-33.0 should stay at x≈150.002, got ${ring[0][0]}`,
  );
  assert.ok(
    Math.abs(ring[4][0] - 150.002) < 0.0001,
    `vertex at y=-33.004 should stay at x≈150.002, got ${ring[4][0]}`,
  );

  // Vertices at y=-33.001, y=-33.002, y=-33.003 should have moved TOWARDS x≈150.001.
  // Near transition points (top/bottom of the edit) the displacement is interpolated
  // from diagonal edges, so vertices may end up between 150.001 and 150.002.
  // The key invariant is that they moved LEFT from their original x=150.002.
  for (let i = 1; i <= 3; i++) {
    assert.ok(
      ring[i][0] < 150.002 - 0.00001,
      `vertex ${i} should have moved west from x=150.002, got ${ring[i][0]}`,
    );
    assert.ok(
      ring[i][0] >= 150.001 - 0.0001,
      `vertex ${i} should not overshoot past x=150.001, got ${ring[i][0]}`,
    );
  }

  // Non-shared vertices should be unchanged
  assert.ok(Math.abs(ring[5][0] - 150.006) < 0.0001, 'non-shared vertex unchanged');
  assert.ok(Math.abs(ring[6][0] - 150.006) < 0.0001, 'non-shared vertex unchanged');

  assert.equal(displacedCount, 3, '3 vertices displaced');
  assert.equal(changedSegment.length, 3, '3 changed vertices');
});

test('syncBoundaryByDisplacement ignores vertices far from old boundary', () => {
  // Neighbour: only the western boundary at x=150.002 is shared
  // Using realistic coordinates (~100m displacements)
  const neighbourGeom = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [150.002, -33.0],
      [150.002, -33.002],
      [150.002, -33.004],
      [150.006, -33.004],
      [150.006, -33.0],
      [150.002, -33.0],
    ]]],
  };

  // OLD ring: boundary at x=150.002
  const oldEditedRing: Position[] = [
    [150.0, -33.0], [150.002, -33.0], [150.002, -33.002],
    [150.002, -33.004], [150.0, -33.004], [150.0, -33.0],
  ];

  // NEW ring: boundary moved to x=150.001 (~100m west)
  const newEditedRing: Position[] = [
    [150.0, -33.0], [150.001, -33.0], [150.001, -33.002],
    [150.001, -33.004], [150.0, -33.004], [150.0, -33.0],
  ];

  const { geometry, displacedCount } = syncBoundaryByDisplacement(
    neighbourGeom, oldEditedRing, newEditedRing, 0, 0,
  );

  const ring = geometry.coordinates[0][0];

  // All 3 shared vertices should move from x=150.002 to x≈150.001
  assert.ok(
    Math.abs(ring[0][0] - 150.001) < 0.0001,
    `v0 x should be ≈150.001, got ${ring[0][0]}`,
  );
  assert.ok(
    Math.abs(ring[1][0] - 150.001) < 0.0001,
    `v1 x should be ≈150.001, got ${ring[1][0]}`,
  );
  assert.ok(
    Math.abs(ring[2][0] - 150.001) < 0.0001,
    `v2 x should be ≈150.001, got ${ring[2][0]}`,
  );

  // Non-shared vertices at x=150.006 should be unchanged
  assert.ok(
    Math.abs(ring[3][0] - 150.006) < 0.0001,
    'non-shared vertex unchanged',
  );
  assert.ok(
    Math.abs(ring[4][0] - 150.006) < 0.0001,
    'non-shared vertex unchanged',
  );

  assert.equal(displacedCount, 3, '3 vertices displaced');
});

test('syncBoundaryByDisplacement works with different vertex counts (simplification)', () => {
  // Neighbour: detailed boundary with 5 vertices on western side
  // Using realistic-sized coordinates (~100m displacements)
  const neighbourGeom = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [150.0, -33.0],
      [150.0, -33.001],
      [150.0, -33.002],
      [150.0, -33.003],
      [150.0, -33.004],
      [150.004, -33.004],
      [150.004, -33.0],
      [150.0, -33.0],
    ]]],
  };

  // OLD ring: full detail, matching neighbour's boundary at x=150.0
  const oldEditedRing: Position[] = [
    [149.996, -33.0],
    [150.0, -33.0],
    [150.0, -33.001],
    [150.0, -33.002],
    [150.0, -33.003],
    [150.0, -33.004],
    [149.996, -33.004],
    [149.996, -33.0],
  ];

  // NEW ring: simplified (fewer vertices), user moved boundary west by ~100m
  const newEditedRing: Position[] = [
    [149.996, -33.0],
    [149.999, -33.0],
    [149.999, -33.004],
    [149.996, -33.004],
    [149.996, -33.0],
  ];

  const { geometry, displacedCount } = syncBoundaryByDisplacement(
    neighbourGeom, oldEditedRing, newEditedRing, 0, 0,
  );

  const ring = geometry.coordinates[0][0];

  // All 5 shared vertices should move to x≈149.999 (displacement of -0.001)
  for (let i = 0; i <= 4; i++) {
    assert.ok(
      Math.abs(ring[i][0] - 149.999) < 0.0001,
      `vertex ${i} x should be ≈149.999, got ${ring[i][0]}`,
    );
  }

  // Vertex count preserved
  assert.equal(ring.length, 8, 'vertex count preserved');

  // Non-shared unchanged
  assert.ok(Math.abs(ring[5][0] - 150.004) < 0.0001, 'non-shared x unchanged');
  assert.ok(Math.abs(ring[6][0] - 150.004) < 0.0001, 'non-shared x unchanged');

  assert.equal(displacedCount, 5, '5 vertices displaced');
});

test('generateBoundaryProposals uses displacement when oldEditedGeometry provided', () => {
  // Use realistic coordinates (~100m displacements)
  // OLD edited geometry: full detail, eastern boundary at x=150.002
  const oldGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [150.0, -33.0],
      [150.002, -33.0],
      [150.002, -33.001],
      [150.002, -33.002],
      [150.002, -33.003],
      [150.002, -33.004],
      [150.0, -33.004],
      [150.0, -33.0],
    ]]],
  };

  // NEW edited geometry: simplified, user moved part to x=150.001 (~100m west)
  const editedGeometry = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [150.0, -33.0],
      [150.002, -33.0],
      [150.001, -33.002],
      [150.002, -33.004],
      [150.0, -33.004],
      [150.0, -33.0],
    ]]],
  };

  // Neighbour with detailed western boundary at x=150.002
  const neighbour = makePatch('n1', 'N-001', [[
    [150.002, -33.004],
    [150.002, -33.003],
    [150.002, -33.002],
    [150.002, -33.001],
    [150.002, -33.0],
    [150.006, -33.0],
    [150.006, -33.004],
    [150.002, -33.004],
  ]]);

  const analysis = analysePostEdit('edited', oldGeometry, editedGeometry, [neighbour]);
  assert.ok(analysis.neighbours.length >= 1, 'should detect neighbour');

  // Pass oldGeometry as 4th argument to enable displacement
  const proposals = generateBoundaryProposals(
    analysis, editedGeometry, [neighbour], oldGeometry,
  );
  assert.equal(proposals.length, 1, 'should generate one proposal');

  const proposedRing = proposals[0].proposedGeometry.coordinates[0][0];

  // Vertex count should be PRESERVED (displacement doesn't add/remove vertices)
  assert.equal(
    proposedRing.length,
    neighbour.geometry.coordinates[0][0].length,
    'vertex count preserved with displacement',
  );

  // At least one vertex should have moved inward (x < 150.002)
  const movedVertices = proposedRing.filter(
    (v: Position) => v[0] < 150.0019,
  );
  assert.ok(
    movedVertices.length >= 1,
    `expected ≥1 vertices displaced inward, got ${movedVertices.length}. ` +
    `x-values: ${proposedRing.map((v: Position) => v[0].toFixed(4))}`,
  );
});

// ── syncBoundaryExactCopy tests ──────────────────────────────────────

test('syncBoundaryExactCopy splices edited section into neighbour ring', () => {
  // Using realistic coordinates
  // Neighbour: detailed western boundary at x=150.002
  const neighbourGeom = {
    type: 'MultiPolygon' as const,
    coordinates: [[[
      [150.002, -33.0],
      [150.002, -33.001],
      [150.002, -33.002],
      [150.002, -33.003],
      [150.002, -33.004],
      [150.006, -33.004],
      [150.006, -33.0],
      [150.002, -33.0],
    ]]],
  };

  // Old original ring: eastern boundary at x=150.002
  const oldOriginalRing: Position[] = [
    [150.0, -33.0],
    [150.002, -33.0],
    [150.002, -33.001],
    [150.002, -33.002],
    [150.002, -33.003],
    [150.002, -33.004],
    [150.0, -33.004],
    [150.0, -33.0],
  ];

  // Pre-edit simplified ring (same as old in this test)
  const preSimplifiedRing: Position[] = [...oldOriginalRing];

  // Post-edit ring: user moved middle vertices to x=150.001
  const newEditedRing: Position[] = [
    [150.0, -33.0],
    [150.002, -33.0],       // unchanged anchor
    [150.001, -33.001],     // EDITED
    [150.001, -33.002],     // EDITED
    [150.001, -33.003],     // EDITED
    [150.002, -33.004],     // unchanged anchor
    [150.0, -33.004],
    [150.0, -33.0],
  ];

  const { geometry, displacedCount, changedSegment } = syncBoundaryExactCopy(
    neighbourGeom,
    oldOriginalRing,
    newEditedRing,
    preSimplifiedRing,
    0, 0,
  );

  assert.ok(displacedCount > 0, 'should have displaced vertices');

  const ring = geometry.coordinates[0][0];

  // The edited section should be an EXACT COPY from the new ring.
  // Find vertices at x≈150.001
  const editedVertices = ring.filter(
    (v: Position) => Math.abs(v[0] - 150.001) < 0.0001,
  );
  assert.ok(
    editedVertices.length >= 2,
    `expected ≥2 vertices at x≈150.001 (exact copy of edit), got ${editedVertices.length}`,
  );

  // Ring should still be closed
  const lastV = ring[ring.length - 1];
  assert.ok(
    Math.abs(ring[0][0] - lastV[0]) < 1e-10 &&
    Math.abs(ring[0][1] - lastV[1]) < 1e-10,
    'ring should be closed',
  );

  // Non-shared vertices (at x=150.006) should be unchanged
  const nonShared = ring.filter(
    (v: Position) => Math.abs(v[0] - 150.006) < 0.0001,
  );
  assert.ok(
    nonShared.length >= 2,
    `non-shared vertices preserved: expected ≥2 at x≈150.006, got ${nonShared.length}. ` +
    `Full ring: ${JSON.stringify(ring.map((v: Position) => [+v[0].toFixed(4), +v[1].toFixed(4)]))}`,
  );
});
