'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useToast } from '@/components/Toast';
import { usePatchData } from '@/hooks/usePatchData';
import { usePatchEditor } from '@/hooks/usePatchEditor';
import { useEditHistory } from '@/hooks/useEditHistory';
import MapView, { type MapViewHandle } from '@/components/MapView';
import DrawingTools from '@/components/DrawingTools';
import PatchListPanel from '@/components/PatchListPanel';
import PatchDetailsPanel from '@/components/PatchDetailsPanel';
import SimplifyPanel from '@/components/SimplifyPanel';
import Toolbar from '@/components/Toolbar';
import ValidationBar from '@/components/ValidationBar';
import ImportDialog from '@/components/ImportDialog';
import NewPatchDialog from '@/components/NewPatchDialog';
import PostEditDialog from '@/components/PostEditDialog';
import { validateOverlaps } from '@/lib/validation';
import { convertGeoJSONToWKT, ensureMultiPolygon } from '@/lib/geojson';
import {
  analysePostEdit,
  extractSegmentFromRing,
  syncAdjacentBoundary,
  type PostEditAnalysis,
} from '@/lib/geometry-edit';
import { exportGeoJSON } from '@/components/ExportButton';
import { supabase } from '@/lib/supabase';
import { getPatchColor } from '@/lib/colors';
import type { OverlapWarning, PatchFeature } from '@/types';
import type { MultiPolygon, Polygon, Feature } from 'geojson';
import type maplibregl from 'maplibre-gl';

export default function EditorPage() {
  const router = useRouter();
  const { user, loading: authLoading, isAdmin, signOut } = useAuth();
  const { showToast } = useToast();
  const { featureCollection, loading: patchesLoading, error: patchesError, refetch } = usePatchData();

  const editor = usePatchEditor(featureCollection);
  const history = useEditHistory();

  const mapRef = useRef<MapViewHandle>(null);
  const [mapInstance, setMapInstance] = useState<maplibregl.Map | null>(null);
  const [editingPatchId, setEditingPatchId] = useState<string | null>(null);
  const [overlaps, setOverlaps] = useState<OverlapWarning[]>([]);
  const [saving, setSaving] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showNewPatchDialog, setShowNewPatchDialog] = useState(false);
  const [pendingGeometry, setPendingGeometry] = useState<MultiPolygon | null>(null);

  // Simplify overlay state
  const [simplifyOriginalOverlay, setSimplifyOriginalOverlay] = useState<GeoJSON.Feature | null>(null);
  const [simplifyPreviewOverlay, setSimplifyPreviewOverlay] = useState<GeoJSON.Feature | null>(null);

  // Post-edit analysis state
  const [postEditAnalysis, setPostEditAnalysis] = useState<PostEditAnalysis | null>(null);
  const [showPostEditDialog, setShowPostEditDialog] = useState(false);
  const [postEditPatchCode, setPostEditPatchCode] = useState<string>('');
  const [postEditNewGeometry, setPostEditNewGeometry] = useState<MultiPolygon | null>(null);
  const [gapPreview, setGapPreview] = useState<GeoJSON.Feature | null>(null);

  // Duplicate patch warnings
  const duplicateWarnings = useMemo(() => {
    const warnings: { code1: string; code2: string }[] = [];
    const features = featureCollection.features;
    for (let i = 0; i < features.length; i++) {
      for (let j = i + 1; j < features.length; j++) {
        const a = features[i];
        const b = features[j];
        if (!a.geometry || !b.geometry) continue;
        // Quick check: if geometries are identical (same JSON), flag as duplicate
        if (JSON.stringify(a.geometry) === JSON.stringify(b.geometry)) {
          warnings.push({ code1: a.properties.code, code2: b.properties.code });
        }
      }
    }
    return warnings;
  }, [featureCollection]);

  // Redirect if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/login');
    }
  }, [authLoading, user, router]);

  // Initialize history when patches load
  useEffect(() => {
    if (!patchesLoading && featureCollection.features.length > 0) {
      const snapshot = new Map(
        featureCollection.features.map(f => [f.properties.id, f.geometry])
      );
      history.initialize(snapshot);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchesLoading]);

  // ── Patch selection ───────────────────────────────────────────────

  const handlePatchClick = useCallback((patchId: string) => {
    if (editor.editMode !== 'view') return;
    editor.selectPatch(patchId);
    mapRef.current?.flyToPatch(patchId);
  }, [editor]);

  const handleListSelect = useCallback((id: string | null) => {
    if (editor.editMode !== 'view') return;
    editor.selectPatch(id);
    if (id) mapRef.current?.flyToPatch(id);
  }, [editor]);

  // ── Edit Boundary mode ────────────────────────────────────────────

  const handleEditBoundary = useCallback(() => {
    if (!editor.selectedPatch) return;
    setSimplifyOriginalOverlay({
      type: 'Feature',
      geometry: editor.selectedPatch.geometry,
      properties: {},
    });
    editor.enterEditBoundaryMode();
  }, [editor]);

  const handleSimplifiedGeometryChange = useCallback((geometry: MultiPolygon) => {
    setSimplifyPreviewOverlay({
      type: 'Feature',
      geometry,
      properties: {},
    });
  }, []);

  const handleRefine = useCallback((geometry: MultiPolygon) => {
    editor.enterRefineMode(geometry);
    setSimplifyPreviewOverlay(null);
  }, [editor]);

  // Shared post-edit handler: saves geometry and runs post-edit analysis
  const applyBoundaryEdit = useCallback((geometry: MultiPolygon) => {
    if (!editor.selectedPatch) return;

    const patchId = editor.selectedPatch.properties.id;
    const patchCode = editor.selectedPatch.properties.code;

    // Capture old geometry BEFORE updating
    const oldGeometry = editor.selectedPatch.geometry.type === 'MultiPolygon'
      ? editor.selectedPatch.geometry as MultiPolygon
      : ensureMultiPolygon(editor.selectedPatch.geometry);

    // Apply the edit
    editor.updateGeometry(patchId, geometry);

    const snapshot = new Map(
      editor.workingFeatureCollection.features.map(f => [f.properties.id, f.geometry])
    );
    snapshot.set(patchId, geometry);
    history.pushState(snapshot);

    editor.exitEditMode();
    setSimplifyOriginalOverlay(null);
    setSimplifyPreviewOverlay(null);

    // Run post-edit analysis
    try {
      const analysis = analysePostEdit(
        patchId,
        oldGeometry,
        geometry,
        editor.workingFeatureCollection.features
      );

      const hasActions = analysis.neighbours.length > 0 || analysis.gapGeometry !== null;

      if (hasActions) {
        setPostEditAnalysis(analysis);
        setPostEditPatchCode(patchCode);
        setPostEditNewGeometry(geometry);
        setShowPostEditDialog(true);

        // Show gap on map if detected
        if (analysis.gapGeometry) {
          setGapPreview(analysis.gapGeometry);
        }

        showToast('Boundary updated -- review post-edit actions', 'info');
      } else {
        showToast('Boundary updated', 'success');
      }
    } catch (err) {
      console.warn('Post-edit analysis failed:', err);
      showToast('Boundary updated', 'success');
    }
  }, [editor, history, showToast]);

  const handleRefineComplete = useCallback((geometry: MultiPolygon) => {
    applyBoundaryEdit(geometry);
  }, [applyBoundaryEdit]);

  const handleApplySimplification = useCallback((geometry: MultiPolygon) => {
    applyBoundaryEdit(geometry);
  }, [applyBoundaryEdit]);

  const handleCancelEdit = useCallback(() => {
    editor.exitEditMode();
    setSimplifyOriginalOverlay(null);
    setSimplifyPreviewOverlay(null);
  }, [editor]);

  // ── Post-edit actions ─────────────────────────────────────────────

  // Apply the full new geometry to duplicate patches
  const handleApplyToDuplicates = useCallback((patchIds: string[]) => {
    if (!postEditNewGeometry) return;

    for (const patchId of patchIds) {
      editor.updateGeometry(patchId, postEditNewGeometry);
    }

    showToast(`Edit applied to ${patchIds.length} duplicate${patchIds.length !== 1 ? 's' : ''}`, 'success');

    // Remove duplicates from analysis
    setPostEditAnalysis(prev => {
      if (!prev) return null;
      return { ...prev, duplicates: [] };
    });
  }, [postEditNewGeometry, editor, showToast]);

  // Align selected neighbours' boundaries to match the edit
  const handleAlignNeighbours = useCallback((patchIds: string[]) => {
    if (!postEditAnalysis || !postEditNewGeometry) return;

    const alignedPatchIds = new Set<string>();
    let alignedCount = 0;
    let skippedCount = 0;
    for (const patchId of patchIds) {
      const neighbourInfo = postEditAnalysis.neighbours.find(n => n.patchId === patchId);
      if (!neighbourInfo) {
        skippedCount++;
        continue;
      }

      const neighbourPatch = editor.workingFeatureCollection.features.find(
        f => f.properties.id === patchId
      );
      if (!neighbourPatch) {
        skippedCount++;
        continue;
      }

      const neighbourGeom = neighbourPatch.geometry.type === 'MultiPolygon'
        ? neighbourPatch.geometry as MultiPolygon
        : ensureMultiPolygon(neighbourPatch.geometry);

      const { adjacentInfo } = neighbourInfo;
      const editedRing = postEditNewGeometry.coordinates[adjacentInfo.editedPolygonIndex]?.[adjacentInfo.editedRingIndex];
      if (!editedRing) {
        skippedCount++;
        continue;
      }

      const newSegment = extractSegmentFromRing(
        editedRing,
        adjacentInfo.editedStartIndex,
        adjacentInfo.editedEndIndex
      );
      if (newSegment.length < 3) {
        skippedCount++;
        continue;
      }

      const updatedNeighbour = syncAdjacentBoundary(
        neighbourGeom,
        newSegment,
        adjacentInfo
      );

      const updatedRing = updatedNeighbour.coordinates[adjacentInfo.polygonIndex]?.[adjacentInfo.ringIndex];
      const isRingClosed = !!updatedRing &&
        updatedRing.length >= 4 &&
        updatedRing[0][0] === updatedRing[updatedRing.length - 1][0] &&
        updatedRing[0][1] === updatedRing[updatedRing.length - 1][1];

      if (!isRingClosed) {
        skippedCount++;
        continue;
      }

      editor.updateGeometry(patchId, updatedNeighbour);
      alignedPatchIds.add(patchId);
      alignedCount++;
    }

    if (alignedCount > 0) {
      showToast(`${alignedCount} neighbour${alignedCount !== 1 ? 's' : ''} aligned`, 'success');
    }
    if (skippedCount > 0) {
      showToast(
        `${skippedCount} neighbour update${skippedCount !== 1 ? 's' : ''} skipped (invalid shared boundary)`,
        'info'
      );
    }

    // Update the analysis to reflect aligned neighbours
    setPostEditAnalysis(prev => {
      if (!prev) return null;
      return {
        ...prev,
        neighbours: prev.neighbours.map(n =>
          alignedPatchIds.has(n.patchId) ? { ...n, relationship: 'aligned' as const } : n
        ),
      };
    });
  }, [postEditAnalysis, postEditNewGeometry, editor, showToast]);

  const handleCreateGapPatch = useCallback((gapGeometry: Feature<Polygon | MultiPolygon>) => {
    const geometry = gapGeometry.geometry.type === 'MultiPolygon'
      ? gapGeometry.geometry as MultiPolygon
      : ensureMultiPolygon(gapGeometry.geometry);

    setPendingGeometry(geometry);
    setShowNewPatchDialog(true);
  }, []);

  const handlePostEditDone = useCallback(() => {
    setShowPostEditDialog(false);
    setPostEditAnalysis(null);
    setPostEditPatchCode('');
    setPostEditNewGeometry(null);
    setGapPreview(null);
  }, []);

  // ── Draw new patch ────────────────────────────────────────────────

  const handleNewPolygonComplete = useCallback((geometry: MultiPolygon) => {
    setPendingGeometry(geometry);
    setShowNewPatchDialog(true);
    editor.exitEditMode();
  }, [editor]);

  const handleNewPatchConfirm = useCallback((code: string, name: string) => {
    if (!pendingGeometry) return;

    const id = self.crypto?.randomUUID?.() ?? (Math.random().toString(36).slice(2) + Date.now().toString(36));
    const colors = getPatchColor(id);

    const newPatch: PatchFeature = {
      type: 'Feature',
      id,
      geometry: pendingGeometry,
      properties: {
        id,
        code,
        name: name || null,
        type: 'geo',
        status: 'active',
        fillColor: colors.fillWithAlpha,
        outlineColor: colors.outline,
      },
    };

    editor.addNewPatch(newPatch);
    setPendingGeometry(null);
    setShowNewPatchDialog(false);

    const snapshot = new Map(
      [...editor.workingFeatureCollection.features, newPatch].map(f => [f.properties.id, f.geometry])
    );
    history.pushState(snapshot);
    showToast(`New patch ${code} created`, 'success');
  }, [pendingGeometry, editor, history, showToast]);

  // ── Delete patch ──────────────────────────────────────────────────

  const handleDelete = useCallback(async () => {
    if (!editor.selectedPatch || !isAdmin) return;

    const patch = editor.selectedPatch;
    const confirmed = window.confirm(
      `Delete patch ${patch.properties.code}${patch.properties.name ? ` (${patch.properties.name})` : ''}? This cannot be undone.`
    );
    if (!confirmed) return;

    try {
      const { error } = await supabase
        .from('patches')
        .delete()
        .eq('id', patch.properties.id);
      if (error) throw error;

      editor.markDeleted(patch.properties.id);
      showToast(`Patch ${patch.properties.code} deleted`, 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete patch';
      showToast(message, 'error');
    }
  }, [editor, isAdmin, showToast]);

  // ── Validate ──────────────────────────────────────────────────────

  const handleValidate = useCallback(() => {
    const warnings = validateOverlaps(editor.workingFeatureCollection.features);
    setOverlaps(warnings);
    if (warnings.length === 0) {
      showToast('No overlaps detected', 'success');
    } else {
      showToast(`${warnings.length} overlap(s) detected`, 'info');
    }
  }, [editor.workingFeatureCollection, showToast]);

  // ── Save ──────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!isAdmin || !editor.hasDirtyPatches) return;

    setSaving(true);
    try {
      const dirtyIds = Array.from(editor.dirtyPatchIds);
      let savedCount = 0;
      let createdCount = 0;

      for (const patchId of dirtyIds) {
        const newPatch = editor.newPatches.find(p => p.properties.id === patchId);
        const modifiedGeom = editor.modifiedGeometries.get(patchId);

        if (newPatch) {
          const wkt = convertGeoJSONToWKT(newPatch.geometry);

          const { error: insertError } = await supabase.from('patches').insert({
            id: newPatch.properties.id,
            code: newPatch.properties.code,
            name: newPatch.properties.name,
            type: 'geo',
            status: 'active',
            created_by: user?.id,
            updated_by: user?.id,
          });
          if (insertError) throw insertError;

          const { error: rpcError } = await supabase.rpc('set_patch_geometries_from_wkt', {
            p_patch_id: newPatch.properties.id,
            p_geometries_wkt: [wkt],
          });
          if (rpcError) console.warn('RPC failed for new patch geometry:', rpcError.message);

          createdCount++;
        } else if (modifiedGeom) {
          const wkt = convertGeoJSONToWKT(modifiedGeom);

          const { error: rpcError } = await supabase.rpc('set_patch_geometries_from_wkt', {
            p_patch_id: patchId,
            p_geometries_wkt: [wkt],
          });

          if (rpcError) {
            console.warn('RPC failed:', rpcError.message);
            const { error: updateError } = await supabase
              .from('patches')
              .update({
                updated_at: new Date().toISOString(),
                updated_by: user?.id,
              })
              .eq('id', patchId);
            if (updateError) throw updateError;
          }
          savedCount++;
        }
      }

      editor.clearDirty();
      await refetch();

      const parts = [];
      if (savedCount > 0) parts.push(`${savedCount} updated`);
      if (createdCount > 0) parts.push(`${createdCount} created`);
      showToast(`Saved: ${parts.join(', ')}`, 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed';
      showToast(message, 'error');
    } finally {
      setSaving(false);
    }
  }, [isAdmin, editor, user, refetch, showToast]);

  // ── Export / Import ───────────────────────────────────────────────

  const handleExport = useCallback(() => {
    exportGeoJSON(editor.workingFeatureCollection, editor.selectedPatchId);
    showToast('GeoJSON exported', 'success');
  }, [editor.workingFeatureCollection, editor.selectedPatchId, showToast]);

  const handleImport = useCallback((patches: PatchFeature[]) => {
    patches.forEach(patch => {
      const existing = editor.workingFeatureCollection.features.find(
        f => f.properties.id === patch.properties.id
      );
      if (existing) {
        editor.updateGeometry(patch.properties.id, patch.geometry);
      } else {
        editor.addNewPatch(patch);
      }
    });

    const snapshot = new Map(
      editor.workingFeatureCollection.features.map(f => [f.properties.id, f.geometry])
    );
    history.pushState(snapshot);
    showToast(`Imported ${patches.length} feature(s)`, 'success');
  }, [editor, history, showToast]);

  // ── Undo / Redo ───────────────────────────────────────────────────

  const handleUndo = useCallback(() => {
    const snapshot = history.undo();
    if (snapshot) {
      for (const [patchId, geom] of snapshot) {
        editor.updateGeometry(patchId, geom);
      }
      showToast('Undone', 'info');
    }
  }, [history, editor, showToast]);

  const handleRedo = useCallback(() => {
    const snapshot = history.redo();
    if (snapshot) {
      for (const [patchId, geom] of snapshot) {
        editor.updateGeometry(patchId, geom);
      }
      showToast('Redone', 'info');
    }
  }, [history, editor, showToast]);

  // ── Draw mode ─────────────────────────────────────────────────────

  const handleDrawNew = useCallback(() => {
    editor.enterDrawMode();
  }, [editor]);

  const handleCancelDraw = useCallback(() => {
    editor.exitEditMode();
  }, [editor]);

  // ── Sign out ──────────────────────────────────────────────────────

  const handleSignOut = useCallback(async () => {
    await signOut();
    router.replace('/login');
  }, [signOut, router]);

  // ── Render ────────────────────────────────────────────────────────

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (!user) return null;

  const isEditingBoundary = editor.editMode === 'simplify' || editor.editMode === 'simplify-refine';

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Toolbar */}
      <Toolbar
        user={user}
        isAdmin={isAdmin}
        editMode={editor.editMode}
        hasDirtyPatches={editor.hasDirtyPatches}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        saving={saving}
        onValidate={handleValidate}
        onSave={handleSave}
        onExport={handleExport}
        onImport={() => setShowImport(true)}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onDrawNew={handleDrawNew}
        onCancelDraw={handleCancelDraw}
        onSignOut={handleSignOut}
      />

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-[300px] flex-shrink-0 bg-white border-r border-gray-200 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden flex flex-col">
            {/* Duplicate warnings */}
            {duplicateWarnings.length > 0 && (
              <div className="p-2 bg-amber-50 border-b border-amber-200">
                <div className="text-xs text-amber-800 font-medium mb-1">
                  Duplicate patches detected:
                </div>
                {duplicateWarnings.slice(0, 5).map((w, i) => (
                  <div key={i} className="text-xs text-amber-700">
                    {w.code1} and {w.code2} have identical geometry
                  </div>
                ))}
                {duplicateWarnings.length > 5 && (
                  <div className="text-xs text-amber-600">
                    ...and {duplicateWarnings.length - 5} more
                  </div>
                )}
              </div>
            )}

            {patchesLoading ? (
              <div className="p-4 text-sm text-gray-500 text-center">Loading patches...</div>
            ) : patchesError ? (
              <div className="p-4 text-sm text-red-600 text-center">{patchesError}</div>
            ) : (
              <PatchListPanel
                featureCollection={editor.workingFeatureCollection}
                selectedPatchId={editor.selectedPatchId}
                dirtyPatchIds={editor.dirtyPatchIds}
                onSelectPatch={handleListSelect}
              />
            )}
          </div>

          {/* Edit Boundary panel (simplify slider + refine) */}
          {editor.selectedPatch && isEditingBoundary && (
            <SimplifyPanel
              patch={editor.selectedPatch}
              isRefining={editor.editMode === 'simplify-refine'}
              onSimplifiedGeometryChange={handleSimplifiedGeometryChange}
              onRefine={handleRefine}
              onApply={handleApplySimplification}
              onCancel={handleCancelEdit}
            />
          )}

          {/* Patch details (view mode) */}
          {editor.selectedPatch && !isEditingBoundary && (
            <PatchDetailsPanel
              patch={editor.selectedPatch}
              editMode={editor.editMode}
              isAdmin={isAdmin}
              onEditBoundary={handleEditBoundary}
              onDelete={handleDelete}
            />
          )}
        </aside>

        {/* Map */}
        <main className="flex-1 relative">
          <MapView
            ref={mapRef}
            featureCollection={editor.workingFeatureCollection}
            selectedPatchId={editor.selectedPatchId}
            overlaps={overlaps}
            editingPatchId={editingPatchId}
            simplifyOverlay={
              isEditingBoundary
                ? { original: simplifyOriginalOverlay, simplified: simplifyPreviewOverlay }
                : null
            }
            gapPreview={gapPreview}
            onPatchClick={handlePatchClick}
            onMapReady={setMapInstance}
          />
          <DrawingTools
            map={mapInstance}
            editMode={editor.editMode}
            selectedPatch={editor.selectedPatch}
            simplifiedGeometry={editor.simplifiedGeometry}
            onNewPolygonComplete={handleNewPolygonComplete}
            onRefineComplete={handleRefineComplete}
            onEditingPatchChange={setEditingPatchId}
          />
        </main>
      </div>

      {/* Validation bar */}
      <ValidationBar
        overlaps={overlaps}
        onDismiss={() => setOverlaps([])}
      />

      {/* Dialogs */}
      <ImportDialog
        isOpen={showImport}
        existingPatches={editor.workingFeatureCollection}
        onClose={() => setShowImport(false)}
        onImport={handleImport}
      />

      <NewPatchDialog
        isOpen={showNewPatchDialog}
        onClose={() => { setShowNewPatchDialog(false); setPendingGeometry(null); }}
        onConfirm={handleNewPatchConfirm}
      />

      <PostEditDialog
        isOpen={showPostEditDialog}
        editedPatchCode={postEditPatchCode}
        analysis={postEditAnalysis ?? { duplicates: [], neighbours: [], gapGeometry: null, gapAreaSqm: 0 }}
        onApplyToDuplicates={handleApplyToDuplicates}
        onAlignNeighbours={handleAlignNeighbours}
        onCreateGapPatch={handleCreateGapPatch}
        onDone={handlePostEditDone}
      />
    </div>
  );
}
