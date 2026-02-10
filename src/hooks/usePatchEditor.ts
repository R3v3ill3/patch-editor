'use client';

import { useState, useCallback } from 'react';
import type { Geometry, MultiPolygon } from 'geojson';
import type { EditMode, PatchFeature, PatchFeatureCollection } from '@/types';

export function usePatchEditor(originalFeatureCollection: PatchFeatureCollection) {
  const [selectedPatchId, setSelectedPatchId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<EditMode>('view');
  const [modifiedGeometries, setModifiedGeometries] = useState<Map<string, Geometry>>(new Map());
  const [dirtyPatchIds, setDirtyPatchIds] = useState<Set<string>>(new Set());
  const [newPatches, setNewPatches] = useState<PatchFeature[]>([]);
  const [deletedPatchIds, setDeletedPatchIds] = useState<Set<string>>(new Set());

  // Simplification state
  const [simplifiedGeometry, setSimplifiedGeometry] = useState<MultiPolygon | null>(null);

  const selectPatch = useCallback((id: string | null) => {
    setSelectedPatchId(id);
    if (id === null) {
      setEditMode('view');
    }
  }, []);

  const enterDrawMode = useCallback(() => {
    setSelectedPatchId(null);
    setEditMode('draw');
  }, []);

  const exitEditMode = useCallback(() => {
    setEditMode('view');
    setSimplifiedGeometry(null);
  }, []);

  // Edit Boundary mode (simplify slider + refine)
  const enterEditBoundaryMode = useCallback(() => {
    if (selectedPatchId) {
      setEditMode('simplify');
      setSimplifiedGeometry(null);
    }
  }, [selectedPatchId]);

  const enterRefineMode = useCallback((simplified: MultiPolygon) => {
    setSimplifiedGeometry(simplified);
    setEditMode('simplify-refine');
  }, []);

  const updateGeometry = useCallback((patchId: string, geometry: Geometry) => {
    setModifiedGeometries(prev => {
      const next = new Map(prev);
      next.set(patchId, geometry);
      return next;
    });
    setDirtyPatchIds(prev => {
      const next = new Set(prev);
      next.add(patchId);
      return next;
    });
  }, []);

  const addNewPatch = useCallback((patch: PatchFeature) => {
    setNewPatches(prev => [...prev, patch]);
    setDirtyPatchIds(prev => {
      const next = new Set(prev);
      next.add(patch.properties.id);
      return next;
    });
  }, []);

  const markDeleted = useCallback((patchId: string) => {
    setDeletedPatchIds(prev => {
      const next = new Set(prev);
      next.add(patchId);
      return next;
    });
    setSelectedPatchId(null);
    setEditMode('view');
  }, []);

  const clearDirty = useCallback((patchIds?: string[]) => {
    if (patchIds) {
      setDirtyPatchIds(prev => {
        const next = new Set(prev);
        patchIds.forEach(id => next.delete(id));
        return next;
      });
    } else {
      setDirtyPatchIds(new Set());
    }
  }, []);

  const clearAll = useCallback(() => {
    setModifiedGeometries(new Map());
    setDirtyPatchIds(new Set());
    setNewPatches([]);
    setDeletedPatchIds(new Set());
    setSelectedPatchId(null);
    setEditMode('view');
    setSimplifiedGeometry(null);
  }, []);

  // Build the current working FeatureCollection
  const workingFeatureCollection: PatchFeatureCollection = {
    type: 'FeatureCollection',
    features: [
      ...originalFeatureCollection.features
        .filter(f => !deletedPatchIds.has(f.properties.id))
        .map(f => {
          const modified = modifiedGeometries.get(f.properties.id);
          if (modified) {
            return { ...f, geometry: modified as PatchFeature['geometry'] };
          }
          return f;
        }),
      ...newPatches.filter(p => !deletedPatchIds.has(p.properties.id)),
    ],
  };

  const selectedPatch = workingFeatureCollection.features.find(
    f => f.properties.id === selectedPatchId
  ) ?? null;

  const hasDirtyPatches = dirtyPatchIds.size > 0;

  return {
    selectedPatchId,
    selectedPatch,
    editMode,
    simplifiedGeometry,
    modifiedGeometries,
    dirtyPatchIds,
    hasDirtyPatches,
    newPatches,
    deletedPatchIds,
    workingFeatureCollection,
    selectPatch,
    enterDrawMode,
    exitEditMode,
    enterEditBoundaryMode,
    enterRefineMode,
    updateGeometry,
    addNewPatch,
    markDeleted,
    clearDirty,
    clearAll,
  };
}
