import test from 'node:test';
import assert from 'node:assert/strict';
import type { Position } from 'geojson';
import { extractSegmentFromRing, findAdjacentPatches, syncAdjacentBoundary } from '@/lib/geometry-edit';
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
