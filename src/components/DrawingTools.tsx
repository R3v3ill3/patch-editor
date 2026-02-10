'use client';

import { useEffect, useRef } from 'react';
import {
  TerraDraw,
  TerraDrawPolygonMode,
  TerraDrawSelectMode,
} from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import type maplibregl from 'maplibre-gl';
import type { Polygon, MultiPolygon } from 'geojson';
import { ensureMultiPolygon } from '@/lib/geojson';
import type { EditMode, PatchFeature } from '@/types';

interface DrawingToolsProps {
  map: maplibregl.Map | null;
  editMode: EditMode;
  selectedPatch: PatchFeature | null;
  simplifiedGeometry: MultiPolygon | null;
  onNewPolygonComplete: (geometry: MultiPolygon) => void;
  onRefineComplete: (geometry: MultiPolygon) => void;
  onEditingPatchChange: (patchId: string | null) => void;
}

export default function DrawingTools({
  map,
  editMode,
  selectedPatch,
  simplifiedGeometry,
  onNewPolygonComplete,
  onRefineComplete,
  onEditingPatchChange,
}: DrawingToolsProps) {
  const drawRef = useRef<TerraDraw | null>(null);
  const prevEditModeRef = useRef<EditMode>('view');

  const normalizePolygonForEdit = (polygon: Polygon): Polygon => {
    const normalizedRings = polygon.coordinates
      .map((ring) => {
        const deduped: typeof ring = [];
        for (const position of ring) {
          const prev = deduped[deduped.length - 1];
          if (!prev || prev[0] !== position[0] || prev[1] !== position[1]) {
            deduped.push([position[0], position[1]]);
          }
        }

        if (deduped.length < 3) return deduped;

        const first = deduped[0];
        const last = deduped[deduped.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          deduped.push([first[0], first[1]]);
        }

        return deduped;
      })
      .filter((ring) => ring.length >= 4);

    return {
      type: 'Polygon',
      coordinates: normalizedRings.length > 0 ? normalizedRings : polygon.coordinates,
    };
  };

  // Initialize terra-draw
  useEffect(() => {
    if (!map) return;

    const initDraw = () => {
      if (drawRef.current) return;

      try {
        const selectMode = new TerraDrawSelectMode({
          flags: {
            polygon: {
              feature: {
                draggable: true,
                coordinates: {
                  midpoints: { draggable: true },
                  draggable: true,
                  deletable: true,
                },
              },
            },
          },
        });

        const polygonMode = new TerraDrawPolygonMode({ pointerDistance: 30 });

        const draw = new TerraDraw({
          adapter: new TerraDrawMapLibreGLAdapter({ map }),
          modes: [selectMode, polygonMode],
        });

        draw.start();
        drawRef.current = draw;
      } catch (error) {
        console.error('Error initializing terra-draw:', error);
      }
    };

    const timeoutId = setTimeout(initDraw, 100);

    return () => {
      clearTimeout(timeoutId);
      if (drawRef.current) {
        try { drawRef.current.stop(); } catch { /* ignore */ }
        drawRef.current = null;
      }
    };
  }, [map]);

  // Handle mode transitions -- only act when editMode actually changes
  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;

    // Skip if mode hasn't changed
    if (prevEditModeRef.current === editMode) return;
    prevEditModeRef.current = editMode;

    const clearFeatures = () => {
      const existing = draw.getSnapshot();
      existing.forEach(f => {
        try { draw.removeFeatures([f.id as string]); } catch { /* ignore */ }
      });
    };

    // ── SIMPLIFY-REFINE MODE: load simplified polygon for editing ──
    if (editMode === 'simplify-refine' && simplifiedGeometry && selectedPatch) {
      onEditingPatchChange(selectedPatch.properties.id);
      clearFeatures();

      const coords = simplifiedGeometry.coordinates[0];
      if (coords && coords[0] && coords[0].length >= 4) {
        const rawPolygon: Polygon = {
          type: 'Polygon',
          coordinates: coords,
        };
        const editPolygon = normalizePolygonForEdit(rawPolygon);

        draw.setMode('select');

        const addResult = draw.addFeatures([{
          type: 'Feature',
          geometry: editPolygon,
          properties: { mode: 'polygon' },
        }]);

        const addedId = addResult?.[0]?.id;
        const snapshot = draw.getSnapshot();
        if (snapshot.length > 0 && addedId !== undefined && addedId !== null) {
          setTimeout(() => {
            try {
              draw.selectFeature(addedId as string | number);
            } catch (err) {
              console.warn('Could not auto-select polygon:', err);
            }
          }, 100);
        }
      }
    }

    // ── DRAW MODE: draw new polygon ──
    else if (editMode === 'draw') {
      onEditingPatchChange(null);
      clearFeatures();
      draw.setMode('polygon');
    }

    // ── VIEW MODE / SIMPLIFY PREVIEW ──
    else if (editMode === 'view' || editMode === 'simplify') {
      clearFeatures();
      if (editMode === 'view') onEditingPatchChange(null);
      try { draw.setMode('select'); } catch { /* ignore */ }
    }

  }, [editMode, selectedPatch, simplifiedGeometry, onEditingPatchChange]);

  // Listen for finish events (new polygon drawn)
  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;

    const handleFinish = (id: string | number, _context: { mode: string; action: string }) => {
      if (editMode === 'draw') {
        const snapshot = draw.getSnapshot();
        const feature = snapshot.find(f => f.id === id);
        if (feature && feature.geometry.type === 'Polygon') {
          const multi = ensureMultiPolygon(feature.geometry);
          onNewPolygonComplete(multi);
          snapshot.forEach(f => {
            try { draw.removeFeatures([f.id as string]); } catch { /* ignore */ }
          });
        }
      }
    };

    draw.on('finish', handleFinish);
    return () => { draw.off('finish', handleFinish); };
  }, [editMode, onNewPolygonComplete]);

  // Extract edited geometry when parent requests it
  useEffect(() => {
    const handleExtractEdit = () => {
      const draw = drawRef.current;
      if (!draw || editMode !== 'simplify-refine') return;

      const snapshot = draw.getSnapshot();
      if (snapshot.length === 0) return;

      const feature = snapshot[0];
      if (feature.geometry.type === 'Polygon') {
        const multi: MultiPolygon = {
          type: 'MultiPolygon',
          coordinates: [(feature.geometry as Polygon).coordinates],
        };
        onRefineComplete(multi);
      }
    };

    window.addEventListener('extract-edit-region', handleExtractEdit);
    return () => window.removeEventListener('extract-edit-region', handleExtractEdit);
  }, [editMode, onRefineComplete]);

  return null;
}
