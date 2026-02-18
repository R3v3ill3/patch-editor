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
  const lastProbeCoordRef = useRef<string>('');
  const dragProbeRef = useRef<{ featureId: string | number | null; index: number }>({
    featureId: null,
    index: -1,
  });

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
          pointerDistance: 12,
          flags: {
            polygon: {
              feature: {
                draggable: false,
                selfIntersectable: true,
                coordinates: {
                  midpoints: { draggable: true },
                  draggable: true,
                  deletable: true,
                },
              },
            },
          },
          styles: {
            selectionPointWidth: 8,
            selectionPointColor: '#2563eb',
            selectionPointOutlineColor: '#ffffff',
            selectionPointOutlineWidth: 2,
            midPointWidth: 6,
            selectedPolygonFillOpacity: 0.25,
          },
        });

        // Diagnostic: inspect select-mode drag branch decisions directly on mode instance
        const selectModeAny = selectMode as unknown as {
          onDragStart?: (event: unknown, setMapDraggability: (enabled: boolean) => void) => void;
          onDrag?: (event: unknown, setMapDraggability: (enabled: boolean) => void) => void;
          selected?: Array<string | number>;
          dragCoordinate?: {
            getDraggableIndex?: (event: unknown, featureId: string | number) => number;
            isDragging?: () => boolean;
          };
          dragFeature?: {
            isDragging?: () => boolean;
          };
        };
        if (selectModeAny.onDragStart) {
          const originalOnDragStart = selectModeAny.onDragStart.bind(selectModeAny);
          selectModeAny.onDragStart = (event, setMapDraggability) => {
            const selectedId = selectModeAny.selected?.[0];
            let draggableIndex: number | null = null;
            if (selectedId !== undefined && selectModeAny.dragCoordinate?.getDraggableIndex) {
              try {
                draggableIndex = selectModeAny.dragCoordinate.getDraggableIndex(event, selectedId);
              } catch {
                draggableIndex = null;
              }
            }
            console.log('[SELECT-DRAG-START]', { selectedId, draggableIndex });
            dragProbeRef.current = {
              featureId: selectedId ?? null,
              index: draggableIndex ?? -1,
            };
            originalOnDragStart(event, setMapDraggability);
            console.log('[SELECT-DRAG-ACTIVE]', {
              coordinateDragging: selectModeAny.dragCoordinate?.isDragging?.() ?? false,
              featureDragging: selectModeAny.dragFeature?.isDragging?.() ?? false,
            });
          };
        }
        if (selectModeAny.onDrag) {
          const originalOnDrag = selectModeAny.onDrag.bind(selectModeAny);
          selectModeAny.onDrag = (event, setMapDraggability) => {
            const eventObj = event as { lng?: number; lat?: number };
            const selectedId = selectModeAny.selected?.[0];
            const beforeSnapshot = draw.getSnapshot();
            const beforePoly = beforeSnapshot.find((f) => f.geometry.type === 'Polygon');
            const beforeRing = beforePoly?.geometry.type === 'Polygon'
              ? beforePoly.geometry.coordinates[0]
              : null;
            const draggedIndex = dragProbeRef.current.index;
            const beforeDragged = beforeRing && draggedIndex >= 0 && draggedIndex < beforeRing.length
              ? beforeRing[draggedIndex]
              : null;
            const beforeMarker = beforeRing && beforeRing.length > 0
              ? `${beforeRing[0][0].toFixed(7)},${beforeRing[0][1].toFixed(7)}|v=${beforeRing.length}`
              : 'none';

            console.log('[SELECT-DRAG-EVENT]', {
              selectedId,
              lng: eventObj.lng,
              lat: eventObj.lat,
              coordinateDragging: selectModeAny.dragCoordinate?.isDragging?.() ?? false,
            });

            originalOnDrag(event, setMapDraggability);

            const afterSnapshot = draw.getSnapshot();
            const afterPoly = afterSnapshot.find((f) => f.geometry.type === 'Polygon');
            const afterRing = afterPoly?.geometry.type === 'Polygon'
              ? afterPoly.geometry.coordinates[0]
              : null;
            const afterDragged = afterRing && draggedIndex >= 0 && draggedIndex < afterRing.length
              ? afterRing[draggedIndex]
              : null;
            const afterMarker = afterRing && afterRing.length > 0
              ? `${afterRing[0][0].toFixed(7)},${afterRing[0][1].toFixed(7)}|v=${afterRing.length}`
              : 'none';
            if (beforeMarker !== afterMarker) {
              console.log('[SELECT-DRAG-MUTATED]', { beforeMarker, afterMarker });
            }
            if (beforeDragged && afterDragged) {
              const beforeDraggedMarker = `${beforeDragged[0].toFixed(7)},${beforeDragged[1].toFixed(7)}`;
              const afterDraggedMarker = `${afterDragged[0].toFixed(7)},${afterDragged[1].toFixed(7)}`;
              if (beforeDraggedMarker !== afterDraggedMarker) {
                console.log('[SELECT-DRAG-MUTATED-INDEX]', {
                  index: draggedIndex,
                  beforeDraggedMarker,
                  afterDraggedMarker,
                });
              }
            }
          };
        }

        const polygonMode = new TerraDrawPolygonMode({ pointerDistance: 30 });

        const draw = new TerraDraw({
          adapter: new TerraDrawMapLibreGLAdapter({ map }),
          modes: [selectMode, polygonMode],
        });

        draw.start();

        // Diagnostic: monitor terra-draw's internal drag state
        const adapter = (draw as unknown as { _adapter: { _dragState: string } })._adapter;
        if (adapter) {
          const origDragState = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(adapter), '_dragState'
          );
          let lastDragState = adapter._dragState;
          const canvas = map.getCanvas();
          canvas.addEventListener('pointermove', () => {
            if (adapter._dragState !== lastDragState) {
              console.log('[DRAG-STATE]', lastDragState, '→', adapter._dragState);
              lastDragState = adapter._dragState;
            }
          });
          canvas.addEventListener('pointerdown', () => {
            setTimeout(() => {
              if (adapter._dragState !== lastDragState) {
                console.log('[DRAG-STATE]', lastDragState, '→', adapter._dragState);
                lastDragState = adapter._dragState;
              }
            }, 0);
          });
          canvas.addEventListener('pointerup', () => {
            setTimeout(() => {
              if (adapter._dragState !== lastDragState) {
                console.log('[DRAG-STATE]', lastDragState, '→', adapter._dragState);
                lastDragState = adapter._dragState;
              }
            }, 0);
          });
        }

        // Diagnostic: verify whether polygon coordinates actually mutate during drag
        draw.on('change', () => {
          if (prevEditModeRef.current !== 'simplify-refine') return;
          const snapshot = draw.getSnapshot();
          const poly = snapshot.find((f) => f.geometry.type === 'Polygon');
          if (!poly || poly.geometry.type !== 'Polygon') return;
          const ring = poly.geometry.coordinates[0];
          if (!ring || ring.length === 0) return;
          const first = ring[0];
          const marker = `${first[0].toFixed(7)},${first[1].toFixed(7)}|v=${ring.length}`;
          if (marker !== lastProbeCoordRef.current) {
            console.log('[COORD-MUTATION]', marker);
            lastProbeCoordRef.current = marker;
          }
        });

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

        const firstResult = addResult?.[0];
        const addedId = firstResult?.id;
        const isValid = firstResult?.valid !== false;
        const snapshot = draw.getSnapshot();

        if (snapshot.length > 0 && addedId != null && isValid) {
          setTimeout(() => {
            try {
              draw.selectFeature(String(addedId));
            } catch (err) {
              console.warn('[DrawingTools] Could not auto-select polygon:', err);
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

  }, [editMode, selectedPatch, simplifiedGeometry, onEditingPatchChange, map]);

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
      if (!draw || editMode !== 'simplify-refine') {
        console.log('[EXTRACT-EDIT] ignored', { hasDraw: !!draw, editMode });
        return;
      }

      const snapshot = draw.getSnapshot();
      const polygonFeatures = snapshot.filter((f) => f.geometry.type === 'Polygon');
      console.log('[EXTRACT-EDIT] snapshot', {
        snapshotLength: snapshot.length,
        firstType: snapshot[0]?.geometry?.type,
        polygonCount: polygonFeatures.length,
      });
      if (snapshot.length === 0) return;

      // Use the actual polygon feature from snapshot rather than assuming index 0.
      const feature = polygonFeatures[0];
      if (feature && feature.geometry.type === 'Polygon') {
        const multi: MultiPolygon = {
          type: 'MultiPolygon',
          coordinates: [(feature.geometry as Polygon).coordinates],
        };
        console.log('[EXTRACT-EDIT] sending refined geometry', {
          ringVertexCount: (feature.geometry as Polygon).coordinates[0]?.length ?? 0,
        });
        onRefineComplete(multi);
      } else {
        console.warn('[EXTRACT-EDIT] no polygon feature found in snapshot');
      }
    };

    window.addEventListener('extract-edit-region', handleExtractEdit);
    return () => window.removeEventListener('extract-edit-region', handleExtractEdit);
  }, [editMode, onRefineComplete]);

  return null;
}
