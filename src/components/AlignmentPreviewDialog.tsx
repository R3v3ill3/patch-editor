'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import {
  TerraDraw,
  TerraDrawSelectMode,
  TerraDrawPolygonMode,
} from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import type { BoundaryProposal } from '@/lib/geometry-edit';
import type { MultiPolygon, Position, Polygon } from 'geojson';

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    'osm-tiles': {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    {
      id: 'osm-tiles',
      type: 'raster',
      source: 'osm-tiles',
    },
  ],
};

interface AlignmentPreviewDialogProps {
  isOpen: boolean;
  editedPatchCode: string;
  editedGeometry: MultiPolygon;
  proposals: BoundaryProposal[];
  onUpdateProposal: (patchId: string, newGeometry: MultiPolygon) => void;
  onApply: (selectedPatchIds: string[]) => void;
  onClose: () => void;
}

export default function AlignmentPreviewDialog({
  isOpen,
  editedPatchCode,
  editedGeometry,
  proposals,
  onUpdateProposal,
  onApply,
  onClose,
}: AlignmentPreviewDialogProps) {
  const [selectedProposals, setSelectedProposals] = useState<Set<string>>(new Set());
  const [rejectedProposals, setRejectedProposals] = useState<Set<string>>(new Set());
  const [focusedPatchId, setFocusedPatchId] = useState<string | null>(null);
  const [editingPatchId, setEditingPatchId] = useState<string | null>(null);
  
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapReady = useRef(false);
  const drawRef = useRef<TerraDraw | null>(null);

  // Initialize map
  useEffect(() => {
    if (!isOpen || !mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: OSM_STYLE,
      center: [151.21, -33.87],
      zoom: 12,
    });

    map.on('load', () => {
      mapReady.current = true;
      
      // Initialize terra-draw
      try {
        const selectMode = new TerraDrawSelectMode({
          pointerDistance: 12,
          flags: {
            polygon: {
              feature: {
                draggable: false,
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

        const polygonMode = new TerraDrawPolygonMode({ pointerDistance: 30 });

        const draw = new TerraDraw({
          adapter: new TerraDrawMapLibreGLAdapter({ map }),
          modes: [selectMode, polygonMode],
        });

        draw.start();
        draw.setMode('select');
        drawRef.current = draw;
      } catch (err) {
        console.error('[AlignmentPreview] Failed to initialize terra-draw:', err);
      }
      
      // Add sources
      map.addSource('edited-patch', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: editedGeometry,
          properties: {}
        }
      });

      map.addSource('original-boundaries', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });

      map.addSource('proposed-boundaries', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });

      map.addSource('original-segments', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });

      map.addSource('proposed-segments', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });

      // Add layers
      map.addLayer({
        id: 'edited-patch-fill',
        type: 'fill',
        source: 'edited-patch',
        paint: {
          'fill-color': '#14b8a6',
          'fill-opacity': 0.1
        }
      });

      map.addLayer({
        id: 'edited-patch-outline',
        type: 'line',
        source: 'edited-patch',
        paint: {
          'line-color': '#14b8a6',
          'line-width': 2
        }
      });

      map.addLayer({
        id: 'original-boundaries-line',
        type: 'line',
        source: 'original-boundaries',
        paint: {
          'line-color': '#9ca3af',
          'line-width': 2,
          'line-dasharray': [4, 4]
        }
      });

      map.addLayer({
        id: 'proposed-boundaries-fill',
        type: 'fill',
        source: 'proposed-boundaries',
        paint: {
          'fill-color': '#818cf8',
          'fill-opacity': 0.1
        }
      });

      map.addLayer({
        id: 'proposed-boundaries-line',
        type: 'line',
        source: 'proposed-boundaries',
        paint: {
          'line-color': '#6366f1',
          'line-width': 2
        }
      });

      map.addLayer({
        id: 'original-segments-line',
        type: 'line',
        source: 'original-segments',
        paint: {
          'line-color': '#f97316',
          'line-width': 3,
          'line-dasharray': [3, 2],
        }
      });

      map.addLayer({
        id: 'proposed-segments-line',
        type: 'line',
        source: 'proposed-segments',
        paint: {
          'line-color': [
            'match',
            ['get', 'quality'],
            'good', '#22c55e',
            'poor', '#f59e0b',
            '#2563eb'
          ],
          'line-width': 3,
        }
      });

      // Highlight layer for focused proposal
      map.addSource('focus-highlight', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      map.addLayer({
        id: 'focus-highlight-fill',
        type: 'fill',
        source: 'focus-highlight',
        paint: {
          'fill-color': '#8b5cf6',
          'fill-opacity': 0.15,
        }
      });

      map.addLayer({
        id: 'focus-highlight-outline',
        type: 'line',
        source: 'focus-highlight',
        paint: {
          'line-color': '#8b5cf6',
          'line-width': 3,
        }
      });

      // Selection highlight layer
      map.addSource('selection-highlight', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      map.addLayer({
        id: 'selection-highlight-outline',
        type: 'line',
        source: 'selection-highlight',
        paint: {
          'line-color': '#06b6d4',
          'line-width': 2.5,
        }
      });

      updateMapData();
    });

    mapRef.current = map;

    return () => {
      if (drawRef.current) {
        try {
          drawRef.current.stop();
          drawRef.current = null;
        } catch (err) {
          console.error('[AlignmentPreview] Error stopping terra-draw:', err);
        }
      }
      mapReady.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, [isOpen]);

  // Update map data when proposals change
  const updateMapData = useCallback(() => {
    const map = mapRef.current;
    if (!map || !mapReady.current) return;

    // Filter out the editing patch from preview layers if in edit mode
    const visibleProposals = editingPatchId
      ? proposals.filter(p => p.patchId !== editingPatchId)
      : proposals;

    const originalFeatures = visibleProposals.map(p => ({
      type: 'Feature' as const,
      geometry: p.originalGeometry,
      properties: { patchId: p.patchId }
    }));

    const proposedFeatures = visibleProposals.map(p => ({
      type: 'Feature' as const,
      geometry: p.proposedGeometry,
      properties: { patchId: p.patchId }
    }));

    const originalSegmentFeatures = visibleProposals.map(p => ({
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: p.originalSegment
      },
      properties: {
        patchId: p.patchId,
      }
    }));

    const proposedSegmentFeatures = visibleProposals.map(p => ({
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: p.proposedSegment
      },
      properties: {
        patchId: p.patchId,
        quality: p.snapQuality
      }
    }));

    const originalSource = map.getSource('original-boundaries') as maplibregl.GeoJSONSource;
    if (originalSource) {
      originalSource.setData({
        type: 'FeatureCollection',
        features: originalFeatures
      });
    }

    const proposedSource = map.getSource('proposed-boundaries') as maplibregl.GeoJSONSource;
    if (proposedSource) {
      proposedSource.setData({
        type: 'FeatureCollection',
        features: proposedFeatures
      });
    }

    const originalSegmentSource = map.getSource('original-segments') as maplibregl.GeoJSONSource;
    if (originalSegmentSource) {
      originalSegmentSource.setData({
        type: 'FeatureCollection',
        features: originalSegmentFeatures
      });
    }

    const proposedSegmentSource = map.getSource('proposed-segments') as maplibregl.GeoJSONSource;
    if (proposedSegmentSource) {
      proposedSegmentSource.setData({
        type: 'FeatureCollection',
        features: proposedSegmentFeatures
      });
    }

    // Fit bounds to show all features
    if (proposals.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      
      function addCoords(coords: Position[]) {
        coords.forEach(c => bounds.extend([c[0], c[1]] as [number, number]));
      }

      proposals.forEach(p => {
        p.proposedGeometry.coordinates.forEach(polygon => 
          polygon.forEach(ring => addCoords(ring))
        );
      });

      editedGeometry.coordinates.forEach(polygon =>
        polygon.forEach(ring => addCoords(ring))
      );

      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 40, duration: 500 });
      }
    }
  }, [proposals, editedGeometry, editingPatchId]);

  // Update map when proposals or editing state changes
  useEffect(() => {
    updateMapData();
  }, [updateMapData]);

  useEffect(() => {
    const validIds = new Set(proposals.map(p => p.patchId));
    setRejectedProposals(prev => {
      const next = new Set(Array.from(prev).filter(id => validIds.has(id)));
      if (next.size === prev.size && Array.from(next).every(id => prev.has(id))) {
        return prev;
      }
      return next;
    });
    setSelectedProposals(prev => {
      const next = new Set(
        Array.from(prev).filter(id => validIds.has(id) && !rejectedProposals.has(id))
      );
      if (next.size === prev.size && Array.from(next).every(id => prev.has(id))) {
        return prev;
      }
      return next;
    });
  }, [proposals, rejectedProposals]);

  // Update selection highlight when selectedProposals changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady.current) return;

    const selectionSource = map.getSource('selection-highlight') as maplibregl.GeoJSONSource | undefined;
    if (!selectionSource) return;

    const selectedFeatures = proposals
      .filter(p => selectedProposals.has(p.patchId))
      .map(p => ({
        type: 'Feature' as const,
        geometry: p.proposedGeometry,
        properties: { patchId: p.patchId },
      }));

    selectionSource.setData({
      type: 'FeatureCollection',
      features: selectedFeatures,
    });
  }, [proposals, selectedProposals]);

  // Focus on a specific proposal
  const focusOnProposal = useCallback((patchId: string) => {
    setFocusedPatchId(patchId);
    
    const map = mapRef.current;
    if (!map || !mapReady.current) return;

    const proposal = proposals.find(p => p.patchId === patchId);
    if (!proposal) return;

    // Update highlight layer
    const highlightSource = map.getSource('focus-highlight') as maplibregl.GeoJSONSource | undefined;
    if (highlightSource) {
      highlightSource.setData({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: proposal.proposedGeometry, properties: {} },
        ],
      });
    }

    const bounds = new maplibregl.LngLatBounds();
    proposal.proposedGeometry.coordinates.forEach(polygon =>
      polygon.forEach(ring =>
        ring.forEach(coord => bounds.extend([coord[0], coord[1]] as [number, number]))
      )
    );

    editedGeometry.coordinates.forEach(polygon =>
      polygon.forEach(ring =>
        ring.forEach(coord => bounds.extend([coord[0], coord[1]] as [number, number]))
      )
    );

    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 800 });
    }
  }, [proposals, editedGeometry]);

  const toggleProposal = useCallback((patchId: string) => {
    if (rejectedProposals.has(patchId)) return;
    setSelectedProposals(prev => {
      const next = new Set(prev);
      if (next.has(patchId)) {
        next.delete(patchId);
      } else {
        next.add(patchId);
      }
      return next;
    });
  }, [rejectedProposals]);

  const selectAll = useCallback(() => {
    const selectable = proposals
      .filter(p => !rejectedProposals.has(p.patchId))
      .map(p => p.patchId);
    setSelectedProposals(new Set(selectable));
  }, [proposals, rejectedProposals]);

  const clearAll = useCallback(() => {
    setSelectedProposals(new Set());
  }, []);

  const toggleReject = useCallback((patchId: string) => {
    setRejectedProposals(prev => {
      const next = new Set(prev);
      if (next.has(patchId)) {
        next.delete(patchId);
      } else {
        next.add(patchId);
      }
      return next;
    });
    setSelectedProposals(prev => {
      if (!prev.has(patchId)) return prev;
      const next = new Set(prev);
      next.delete(patchId);
      return next;
    });
  }, []);

  const handleApply = useCallback(() => {
    const eligible = Array.from(selectedProposals).filter(id => !rejectedProposals.has(id));
    if (eligible.length === 0) return;
    onApply(eligible);
  }, [selectedProposals, rejectedProposals, onApply]);

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

  const handleEditVertices = useCallback((patchId: string) => {
    const draw = drawRef.current;
    if (!draw) return;

    const proposal = proposals.find(p => p.patchId === patchId);
    if (!proposal) return;

    setEditingPatchId(patchId);
    setRejectedProposals(prev => {
      if (!prev.has(patchId)) return prev;
      const next = new Set(prev);
      next.delete(patchId);
      return next;
    });
    setSelectedProposals(prev => {
      if (prev.has(patchId)) return prev;
      const next = new Set(prev);
      next.add(patchId);
      return next;
    });

    // Ensure we're in select mode
    try { draw.setMode('select'); } catch { /* ignore */ }

    // Clear any existing features
    const existing = draw.getSnapshot();
    existing.forEach(f => {
      try { draw.removeFeatures([f.id as string]); } catch { /* ignore */ }
    });

    // Load the proposed geometry
    const coords = proposal.proposedGeometry.coordinates[0];
    if (coords && coords[0] && coords[0].length >= 4) {
      const rawPolygon: Polygon = {
        type: 'Polygon',
        coordinates: coords,
      };
      const editPolygon = normalizePolygonForEdit(rawPolygon);

      console.log('[AlignmentPreview] Adding polygon for editing:', {
        patchId,
        ringCount: editPolygon.coordinates.length,
        vertexCount: editPolygon.coordinates[0]?.length ?? 0,
      });

      const addResult = draw.addFeatures([{
        type: 'Feature',
        geometry: editPolygon,
        properties: { mode: 'polygon', patchId },
      }]);

      console.log('[AlignmentPreview] Add result:', {
        addResult,
        resultCount: addResult?.length ?? 0,
      });

      const firstResult = addResult?.[0];
      const addedId = firstResult?.id;
      const isValid = firstResult?.valid !== false;

      if (addedId != null && isValid) {
        console.log('[AlignmentPreview] Feature added successfully, selecting:', { addedId });
        // Use a longer delay to let terra-draw fully register the feature
        setTimeout(() => {
          try {
            const currentMode = draw.getMode();
            console.log('[AlignmentPreview] Current mode before select:', currentMode);
            draw.setMode('select');
            draw.selectFeature(String(addedId));
            console.log('[AlignmentPreview] Feature selected:', addedId);
          } catch (err) {
            console.warn('[AlignmentPreview] Could not auto-select polygon:', err);
          }
        }, 200);
      } else {
        console.warn('[AlignmentPreview] Feature not valid or no ID:', {addedId, isValid, firstResult});
      }
    }

    // Focus on the proposal
    focusOnProposal(patchId);
  }, [proposals, focusOnProposal]);

  const handleSaveEdit = useCallback(() => {
    if (!editingPatchId) return;

    const draw = drawRef.current;
    if (!draw) return;

    const snapshot = draw.getSnapshot();
    const polygons = snapshot.filter(f => f.geometry.type === 'Polygon');

    if (polygons.length > 0) {
      const feature = polygons[0];
      const multi: MultiPolygon = {
        type: 'MultiPolygon',
        coordinates: [(feature.geometry as Polygon).coordinates],
      };

      onUpdateProposal(editingPatchId, multi);
    }

    // Clear features
    const existing = draw.getSnapshot();
    existing.forEach(f => {
      try { draw.removeFeatures([f.id as string]); } catch { /* ignore */ }
    });

    setEditingPatchId(null);
  }, [editingPatchId, onUpdateProposal]);

  const handleCancelEdit = useCallback(() => {
    if (!editingPatchId) return;

    const draw = drawRef.current;
    if (draw) {
      // Clear features
      const existing = draw.getSnapshot();
      existing.forEach(f => {
        try { draw.removeFeatures([f.id as string]); } catch { /* ignore */ }
      });
    }

    setEditingPatchId(null);
  }, [editingPatchId]);

  if (!isOpen) return null;

  const focusedProposal = focusedPatchId ? proposals.find(p => p.patchId === focusedPatchId) : null;
  const selectableCount = proposals.filter(p => !rejectedProposals.has(p.patchId)).length;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl h-[85vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">
            Review Boundary Alignments: {editedPatchCode}
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Preview and adjust how neighboring patches will be aligned to match the edited boundary.
          </p>
        </div>

        {/* Main content */}
        <div className="flex-1 flex min-h-0">
          {/* Left sidebar - Proposal list */}
          <div className="w-80 border-r border-gray-200 flex flex-col">
            {/* Controls */}
            <div className="p-4 border-b border-gray-200">
              <div className="flex gap-2 mb-3">
                <button
                  onClick={selectAll}
                  className="text-xs px-3 py-1.5 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
                >
                  Select All
                </button>
                <button
                  onClick={clearAll}
                  className="text-xs px-3 py-1.5 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
                >
                  Clear
                </button>
              </div>
              <p className="text-xs text-gray-500">
                {selectedProposals.size} of {selectableCount} selected
              </p>
            </div>

            {/* Proposal list */}
            <div className="flex-1 overflow-y-auto">
              {proposals.length === 0 ? (
                <div className="p-4 text-xs text-gray-500">
                  No neighbor alignment proposals available.
                </div>
              ) : proposals.map(proposal => {
                const isRejected = rejectedProposals.has(proposal.patchId);
                return (
                  <div
                    key={proposal.patchId}
                    className={`border-b border-gray-100 ${
                      focusedPatchId === proposal.patchId ? 'bg-blue-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="p-4">
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedProposals.has(proposal.patchId)}
                          onChange={() => toggleProposal(proposal.patchId)}
                          disabled={isRejected}
                          className="mt-0.5 w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 disabled:opacity-40"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-medium text-gray-900">
                              {proposal.patchCode}
                            </span>
                            <span className={`text-xs px-1.5 py-0.5 rounded ${
                              proposal.relationship === 'overlap'
                                ? 'bg-red-100 text-red-700'
                                : proposal.relationship === 'gap'
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-green-100 text-green-700'
                            }`}>
                              {proposal.relationship === 'overlap' ? 'Overlap' :
                               proposal.relationship === 'gap' ? 'Gap' : 'Aligned'}
                            </span>
                            {isRejected && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">
                                Rejected
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`text-xs px-1.5 py-0.5 rounded ${
                              proposal.snapQuality === 'good'
                                ? 'bg-green-100 text-green-700'
                                : 'bg-yellow-100 text-yellow-700'
                            }`}>
                              {proposal.snapQuality === 'good' ? 'Good fit' : 'Needs review'}
                            </span>
                          </div>
                        </div>
                      </label>
                      <div className="flex gap-2 mt-2 ml-7">
                        <button
                          onClick={() => focusOnProposal(proposal.patchId)}
                          className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded transition-colors"
                        >
                          Focus
                        </button>
                        <button
                          onClick={() => handleEditVertices(proposal.patchId)}
                          className="text-xs px-2 py-1 text-gray-600 hover:bg-gray-100 rounded transition-colors"
                          disabled={editingPatchId !== null}
                        >
                          Edit Vertices
                        </button>
                        <button
                          onClick={() => toggleReject(proposal.patchId)}
                          className="text-xs px-2 py-1 text-gray-600 hover:bg-gray-100 rounded transition-colors"
                          disabled={editingPatchId !== null}
                        >
                          {isRejected ? 'Undo Reject' : 'Reject'}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right panel - Map preview */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Map */}
            <div className="flex-1 relative">
              <div ref={mapContainerRef} className="absolute inset-0" />
              
              {/* Edit mode overlay */}
              {editingPatchId && (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-white rounded-lg shadow-lg px-4 py-3 z-10">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-gray-900">
                      Editing {proposals.find(p => p.patchId === editingPatchId)?.patchCode}
                    </span>
                    <button
                      onClick={handleSaveEdit}
                      className="text-sm px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                    >
                      Save
                    </button>
                    <button
                      onClick={handleCancelEdit}
                      className="text-sm px-3 py-1 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Legend */}
              <div className="absolute bottom-3 left-3 bg-white/90 rounded shadow px-3 py-2 z-10 text-[10px] space-y-1">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-5 h-0.5 bg-teal-500" />
                  <span className="text-gray-700">Edited patch boundary</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-5 h-0.5 border-t-2 border-dashed border-orange-500" />
                  <span className="text-gray-700">Original shared boundary (before edit)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-5 h-0.5 bg-green-500" />
                  <span className="text-gray-700">Proposed neighbour boundary (auto-apply)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-5 h-0.5 bg-amber-500" />
                  <span className="text-gray-700">Proposed neighbour boundary (needs review)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-5 h-0.5 border-t-2 border-dashed border-gray-400" />
                  <span className="text-gray-700">Neighbour current outline</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-5 h-0.5 bg-indigo-500" />
                  <span className="text-gray-700">Neighbour outline after alignment</span>
                </div>
              </div>
            </div>

            {/* Info panel */}
            {focusedProposal && (
              <div className="p-4 border-t border-gray-200 bg-gray-50">
                <h3 className="text-sm font-medium text-gray-900 mb-2">
                  {focusedProposal.patchCode} Details
                </h3>
                <div className="space-y-1 text-xs text-gray-600">
                  <div>
                    <span className="font-medium">Relationship:</span>{' '}
                    {focusedProposal.relationship}
                  </div>
                  <div>
                    <span className="font-medium">Snap Quality:</span>{' '}
                    {focusedProposal.snapQuality}
                  </div>
                  <div>
                    <span className="font-medium">Vertices Changed:</span>{' '}
                    {focusedProposal.proposedSegment.length}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-between items-center">
          <button
            onClick={onClose}
            className="text-sm px-4 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={selectedProposals.size === 0}
            className="text-sm px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Apply {selectedProposals.size > 0 ? `${selectedProposals.size} ` : ''}Alignment{selectedProposals.size !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
