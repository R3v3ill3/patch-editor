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
import AlignmentPreviewDialog from '@/components/AlignmentPreviewDialog';
import { validateOverlaps } from '@/lib/validation';
import { convertGeoJSONToWKT, ensureMultiPolygon } from '@/lib/geojson';
import {
  analysePostEdit,
  extractSegmentFromRing,
  syncBoundaryByProjection,
  syncBoundaryExactCopy,
  generateBoundaryProposals,
  detectNeighbors,
  type PostEditAnalysis,
  type BoundaryProposal,
  type AdjacentPatchInfo,
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
  const [postEditOldGeometry, setPostEditOldGeometry] = useState<MultiPolygon | null>(null);
  const [postEditPreSimplifiedGeometry, setPostEditPreSimplifiedGeometry] = useState<MultiPolygon | null>(null);
  const [gapPreview, setGapPreview] = useState<GeoJSON.Feature | null>(null);

  // Pre-edit neighbor detection state (for linked boundary editing)
  const [preEditNeighbors, setPreEditNeighbors] = useState<AdjacentPatchInfo[]>([]);
  const [linkedPatchIds, setLinkedPatchIds] = useState<Set<string>>(new Set());
  const [neighborsLoading, setNeighborsLoading] = useState(false);

  // Alignment preview state
  const [showAlignmentPreview, setShowAlignmentPreview] = useState(false);
  const [alignmentProposals, setAlignmentProposals] = useState<BoundaryProposal[]>([]);

  const isEditingBoundary = editor.editMode === 'simplify' || editor.editMode === 'simplify-refine';

  // Compute linked neighbor overlay for map visualization during editing
  const linkedNeighborOverlay = useMemo((): GeoJSON.FeatureCollection | null => {
    // #region agent log
    console.log('[DEBUG] linkedNeighborOverlay useMemo COMPUTING', {isEditingBoundary,preEditNeighborsCount:preEditNeighbors.length,timestamp:Date.now()});
    // #endregion
    if (!isEditingBoundary || preEditNeighbors.length === 0) return null;

    const features: GeoJSON.Feature[] = [];
    for (const neighbor of preEditNeighbors) {
      const patch = editor.workingFeatureCollection.features.find(
        f => f.properties.id === neighbor.patchId
      );
      if (!patch || !patch.geometry) continue;
      const isLinked = linkedPatchIds.has(neighbor.patchId);
      features.push({
        type: 'Feature',
        geometry: patch.geometry,
        properties: {
          patchId: neighbor.patchId,
          patchCode: neighbor.patchCode,
          isLinked,
        },
      });
    }

    // #region agent log
    console.log('[DEBUG] linkedNeighborOverlay useMemo COMPLETE', {featureCount:features.length,timestamp:Date.now()});
    // #endregion
    return features.length > 0
      ? { type: 'FeatureCollection', features }
      : null;
  }, [isEditingBoundary, preEditNeighbors, linkedPatchIds, editor.workingFeatureCollection.features]);

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
    // #region agent log
    console.log('[DEBUG] handleEditBoundary ENTRY', {hasSelectedPatch:!!editor.selectedPatch,selectedPatchId:editor.selectedPatch?.properties.id,currentEditMode:editor.editMode,timestamp:Date.now()});
    // #endregion
    if (!editor.selectedPatch) return;
    setSimplifyOriginalOverlay({
      type: 'Feature',
      geometry: editor.selectedPatch.geometry,
      properties: {},
    });

    // NOTE: Neighbor detection moved to SimplifyPanel after initial simplification
    // to avoid freezing on high-vertex geometries (can be 30k+ vertices)
    setPreEditNeighbors([]);
    setLinkedPatchIds(new Set());
    setNeighborsLoading(true);

    // #region agent log
    console.log('[DEBUG] BEFORE enterEditBoundaryMode', {currentEditMode:editor.editMode,timestamp:Date.now()});
    // #endregion
    editor.enterEditBoundaryMode();
    // #region agent log
    console.log('[DEBUG] AFTER enterEditBoundaryMode', {editModeAfterCall:editor.editMode,timestamp:Date.now()});
    // #endregion
  }, [editor]);

  const handleToggleLink = useCallback((patchId: string) => {
    setLinkedPatchIds(prev => {
      const next = new Set(prev);
      if (next.has(patchId)) {
        next.delete(patchId);
      } else {
        next.add(patchId);
      }
      return next;
    });
  }, []);

  const handleSimplifiedGeometryChange = useCallback((geometry: MultiPolygon) => {
    setSimplifyPreviewOverlay({
      type: 'Feature',
      geometry,
      properties: {},
    });
  }, []);

  // Called after SimplifyPanel's initial simplification to detect neighbors on simplified geometry
  const handleInitialSimplificationComplete = useCallback((simplifiedGeometry: MultiPolygon) => {
    if (!editor.selectedPatch) return;
    
    const patchId = editor.selectedPatch.properties.id;
    // #region agent log
    console.log('[DEBUG] handleInitialSimplificationComplete - detecting neighbors on simplified geometry', {patchId,timestamp:Date.now()});
    // #endregion
    
    try {
      const neighbors = detectNeighbors(
        patchId,
        simplifiedGeometry,
        editor.workingFeatureCollection.features
      );
      // #region agent log
      console.log('[DEBUG] Neighbors detected on simplified geometry', {neighborCount:neighbors.length,timestamp:Date.now()});
      // #endregion
      setPreEditNeighbors(neighbors);
      setLinkedPatchIds(new Set(neighbors.map(n => n.patchId)));
      setNeighborsLoading(false);
    } catch (err) {
      console.error('[DEBUG] detectNeighbors on simplified geometry ERROR', err);
      setPreEditNeighbors([]);
      setLinkedPatchIds(new Set());
      setNeighborsLoading(false);
    }
  }, [editor]);

  const handleRefine = useCallback((geometry: MultiPolygon) => {
    editor.enterRefineMode(geometry);
    setSimplifyPreviewOverlay(null);
  }, [editor]);

  // Shared post-edit handler: saves geometry and runs post-edit analysis
  // With linked boundary support: auto-propagates edits to linked neighbors
  const applyBoundaryEdit = useCallback((geometry: MultiPolygon) => {
    const vertexCount = geometry.coordinates.reduce((acc,p)=>acc+p.reduce((a,r)=>a+r.length,0),0);
    console.log('[APPLY-BOUNDARY] START', {
      hasSelectedPatch: !!editor.selectedPatch,
      vertexCount,
      linkedNeighborCount: linkedPatchIds.size,
    });
    if (!editor.selectedPatch) {
      console.log('[APPLY-BOUNDARY] EARLY RETURN - no selected patch');
      return;
    }

    const patchId = editor.selectedPatch.properties.id;
    const patchCode = editor.selectedPatch.properties.code;

    // Capture old geometry and features BEFORE updating
    const oldGeometry = editor.selectedPatch.geometry.type === 'MultiPolygon'
      ? editor.selectedPatch.geometry as MultiPolygon
      : ensureMultiPolygon(editor.selectedPatch.geometry);
    // Snapshot the feature list before the edit so duplicate detection
    // can compare the old geometry against all existing patches.
    const preEditFeatures = [...editor.workingFeatureCollection.features];
    console.log('[APPLY-BOUNDARY] Captured state', {
      patchId: editor.selectedPatch.properties.id,
      preEditFeaturesCount: preEditFeatures.length,
    });

    // Apply the edit to the selected patch
    editor.updateGeometry(patchId, geometry);

    // Exit edit mode and clear overlays
    editor.exitEditMode();
    setSimplifyOriginalOverlay(null);
    setSimplifyPreviewOverlay(null);

    // Clear pre-edit neighbor state
    const currentLinkedIds = new Set(linkedPatchIds);
    setPreEditNeighbors([]);
    setLinkedPatchIds(new Set());

    console.log('[APPLY-BOUNDARY] Before analysis', {linkedCount: currentLinkedIds.size});

    // Run post-edit analysis
    try {
      const analysisStart = performance.now();
      console.log('[APPLY-BOUNDARY] Calling analysePostEdit', {
        patchId,
        preEditFeaturesCount: preEditFeatures.length,
      });
      // Pass the pre-edit simplified geometry (if refining was used) so
      // that analysePostEdit can narrow neighbour proposals to only the
      // portion of the boundary the user actually edited.  Without this,
      // the entire shared boundary would be transferred as the simplified
      // version, creating visible straight-line artefacts.
      const analysis = analysePostEdit(
        patchId,
        oldGeometry,
        geometry,
        preEditFeatures,
        editor.simplifiedGeometry,
      );
      console.log('[APPLY-BOUNDARY] analysePostEdit complete', {
        elapsedMs: Math.round(performance.now() - analysisStart),
        neighbours: analysis.neighbours.length,
        duplicates: analysis.duplicates.length,
        hasGap: !!analysis.gapGeometry,
      });

      // Auto-propagate to linked neighbors
      const autoApplied: { patchId: string; geometry: MultiPolygon }[] = [];
      const poorQualityLinked: BoundaryProposal[] = [];

      console.log('[APPLY-BOUNDARY] Auto-propagation check', {
        linkedCount: currentLinkedIds.size,
        neighborCount: analysis.neighbours.length,
      });

      if (currentLinkedIds.size > 0 && analysis.neighbours.length > 0) {
        // Generate proposals for all neighbors
        // Pass oldGeometry so the displacement approach can compare the
        // original (full-detail) ring with the new (simplified+edited) ring.
        const proposals = generateBoundaryProposals(
          analysis,
          geometry,
          editor.workingFeatureCollection.features,
          oldGeometry,
          editor.simplifiedGeometry,
        );
        console.log('[APPLY-BOUNDARY] Proposals generated', {proposalCount: proposals.length});
        for (const proposal of proposals) {
          if (!currentLinkedIds.has(proposal.patchId)) continue;

          if (proposal.snapQuality === 'good') {
            editor.updateGeometry(proposal.patchId, proposal.proposedGeometry);
            autoApplied.push({ patchId: proposal.patchId, geometry: proposal.proposedGeometry });
          } else {
            poorQualityLinked.push(proposal);
          }
        }
        console.log('[APPLY-BOUNDARY] Proposals processed', {
          autoAppliedCount: autoApplied.length,
          poorQualityCount: poorQualityLinked.length,
        });
      }
      // Build snapshot including all auto-applied changes
      const snapshot = new Map(
        editor.workingFeatureCollection.features.map(f => [f.properties.id, f.geometry])
      );
      snapshot.set(patchId, geometry);
      for (const applied of autoApplied) {
        snapshot.set(applied.patchId, applied.geometry);
      }
      history.pushState(snapshot);

      // Update analysis to reflect auto-applied neighbors
      const autoAppliedIds = new Set(autoApplied.map(a => a.patchId));
      const updatedAnalysis: PostEditAnalysis = {
        ...analysis,
        neighbours: analysis.neighbours.map(n =>
          autoAppliedIds.has(n.patchId) ? { ...n, relationship: 'aligned' as const } : n
        ),
      };

      // Determine remaining actions
      const remainingNeighbors = updatedAnalysis.neighbours.filter(
        n => n.relationship !== 'aligned'
      );
      const hasRemainingActions =
        remainingNeighbors.length > 0 ||
        updatedAnalysis.duplicates.length > 0 ||
        updatedAnalysis.gapGeometry !== null ||
        poorQualityLinked.length > 0;

      console.log('[APPLY-BOUNDARY] Remaining actions', {
        remainingNeighborCount: remainingNeighbors.length,
        duplicateCount: updatedAnalysis.duplicates.length,
        hasGap: !!updatedAnalysis.gapGeometry,
        poorQualityLinkedCount: poorQualityLinked.length,
        hasRemainingActions,
        autoAppliedCount: autoApplied.length,
      });

      // Show results
      if (autoApplied.length > 0) {
        showToast(
          `Boundary updated — ${autoApplied.length} linked neighbor${autoApplied.length !== 1 ? 's' : ''} auto-aligned`,
          'success'
        );
      }

      if (hasRemainingActions) {
        console.log('[APPLY-BOUNDARY] Setting dialog state', {patchCode});
        setPostEditAnalysis(updatedAnalysis);
        setPostEditPatchCode(patchCode);
        setPostEditNewGeometry(geometry);
        setPostEditOldGeometry(oldGeometry);
        setPostEditPreSimplifiedGeometry(editor.simplifiedGeometry ?? null);
        setShowPostEditDialog(true);

        if (updatedAnalysis.gapGeometry) {
          setGapPreview(updatedAnalysis.gapGeometry);
        }

        // If there are poor-quality linked neighbors, open alignment preview directly
        if (poorQualityLinked.length > 0 && remainingNeighbors.length === 0 && updatedAnalysis.duplicates.length === 0) {
          setAlignmentProposals(poorQualityLinked);
          setShowAlignmentPreview(true);
          showToast('Some linked neighbors need manual review', 'info');
        } else if (autoApplied.length === 0) {
          showToast('Boundary updated — review post-edit actions', 'info');
        }
      } else if (autoApplied.length === 0) {
        showToast('Boundary updated', 'success');
      }
    } catch (err) {
      console.error('[APPLY-BOUNDARY] Analysis error:', err);
      // Still push history for the main edit even if analysis fails
      const snapshot = new Map(
        editor.workingFeatureCollection.features.map(f => [f.properties.id, f.geometry])
      );
      snapshot.set(patchId, geometry);
      history.pushState(snapshot);
      showToast('Boundary updated', 'success');
    }
  }, [editor, history, showToast, linkedPatchIds]);

  const handleRefineComplete = useCallback((geometry: MultiPolygon) => {
    applyBoundaryEdit(geometry);
  }, [applyBoundaryEdit]);

  const handleApplySimplification = useCallback((geometry: MultiPolygon) => {
    // #region agent log
    const vtxCount = geometry.coordinates.reduce((acc,p)=>acc+p.reduce((a,r)=>a+r.length,0),0);
    console.log('[DEBUG] handleApplySimplification ENTRY', {
      polygonCount: geometry.coordinates.length,
      totalVertexCount: vtxCount,
      timestamp: Date.now()
    });
    // #endregion
    applyBoundaryEdit(geometry);
    // #region agent log
    console.log('[DEBUG] handleApplySimplification AFTER applyBoundaryEdit returned', {timestamp:Date.now()});
    // #endregion
  }, [applyBoundaryEdit]);

  const handleCancelEdit = useCallback(() => {
    editor.exitEditMode();
    setSimplifyOriginalOverlay(null);
    setSimplifyPreviewOverlay(null);
    setPreEditNeighbors([]);
    setLinkedPatchIds(new Set());
    setNeighborsLoading(false);
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

      // Prefer exact-copy approach when old geometry is available
      let updatedNeighbour: MultiPolygon | null = null;

      if (postEditOldGeometry) {
        const oldRing = postEditOldGeometry.coordinates[adjacentInfo.editedPolygonIndex]?.[adjacentInfo.editedRingIndex];
        const newRing = postEditNewGeometry.coordinates[adjacentInfo.editedPolygonIndex]?.[adjacentInfo.editedRingIndex];
        const preSimplifiedRing = postEditPreSimplifiedGeometry
          ?.coordinates[adjacentInfo.editedPolygonIndex]?.[adjacentInfo.editedRingIndex]
          ?? null;
        if (oldRing && newRing) {
          const { geometry, displacedCount } = syncBoundaryExactCopy(
            neighbourGeom,
            oldRing,
            newRing,
            preSimplifiedRing,
            adjacentInfo.polygonIndex,
            adjacentInfo.ringIndex,
          );
          if (displacedCount > 0) {
            updatedNeighbour = geometry;
          }
        }
      }

      // Fallback to projection if exact-copy didn't work
      if (!updatedNeighbour) {
        const editedRing = postEditNewGeometry.coordinates[adjacentInfo.editedPolygonIndex]?.[adjacentInfo.editedRingIndex];
        if (!editedRing) {
          skippedCount++;
          continue;
        }
        const newSegment = extractSegmentFromRing(
          editedRing,
          adjacentInfo.editedStartIndex,
          adjacentInfo.editedEndIndex,
        );
        if (newSegment.length < 2) {
          skippedCount++;
          continue;
        }
        ({ geometry: updatedNeighbour } = syncBoundaryByProjection(
          neighbourGeom,
          newSegment,
          adjacentInfo,
        ));
      }

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
  }, [postEditAnalysis, postEditNewGeometry, postEditOldGeometry, editor, showToast]);

  const handleCreateGapPatch = useCallback((gapGeometry: Feature<Polygon | MultiPolygon>) => {
    const geometry = gapGeometry.geometry.type === 'MultiPolygon'
      ? gapGeometry.geometry as MultiPolygon
      : ensureMultiPolygon(gapGeometry.geometry);

    setPendingGeometry(geometry);
    setShowNewPatchDialog(true);
  }, []);

  const handleOpenAlignmentPreview = useCallback(() => {
    if (!postEditAnalysis || !postEditNewGeometry) return;

    try {
      const proposals = generateBoundaryProposals(
        postEditAnalysis,
        postEditNewGeometry,
        editor.workingFeatureCollection.features,
        postEditOldGeometry ?? undefined,
        postEditPreSimplifiedGeometry,
      );

      setAlignmentProposals(proposals);
      setShowAlignmentPreview(true);
    } catch (err) {
      console.error('Failed to generate boundary proposals:', err);
      showToast('Failed to generate alignment proposals', 'error');
    }
  }, [postEditAnalysis, postEditNewGeometry, postEditOldGeometry, postEditPreSimplifiedGeometry, editor.workingFeatureCollection.features, showToast]);

  const handleUpdateProposal = useCallback((patchId: string, newGeometry: MultiPolygon) => {
    setAlignmentProposals(prev =>
      prev.map(p =>
        p.patchId === patchId
          ? (() => {
              const ring = newGeometry.coordinates[p.adjacentInfo.polygonIndex]?.[p.adjacentInfo.ringIndex];
              const updatedSegment = ring
                ? extractSegmentFromRing(ring, p.adjacentInfo.startIndex, p.adjacentInfo.endIndex)
                : p.proposedSegment;

              return {
                ...p,
                proposedGeometry: newGeometry,
                proposedSegment: updatedSegment,
                changedSegment: updatedSegment,
              };
            })()
          : p
      )
    );
  }, []);

  const handleApplyAlignments = useCallback((selectedPatchIds: string[]) => {
    const selectedProposals = alignmentProposals.filter(p => selectedPatchIds.includes(p.patchId));
    
    let appliedCount = 0;
    for (const proposal of selectedProposals) {
      editor.updateGeometry(proposal.patchId, proposal.proposedGeometry);
      appliedCount++;
    }

    if (appliedCount > 0) {
      showToast(`${appliedCount} neighbor${appliedCount !== 1 ? 's' : ''} aligned`, 'success');
    }

    // Update the analysis to reflect aligned neighbours
    setPostEditAnalysis(prev => {
      if (!prev) return null;
      const alignedIds = new Set(selectedPatchIds);
      return {
        ...prev,
        neighbours: prev.neighbours.map(n =>
          alignedIds.has(n.patchId) ? { ...n, relationship: 'aligned' as const } : n
        ),
      };
    });

    // Close the alignment preview dialog
    setShowAlignmentPreview(false);
    setAlignmentProposals([]);
  }, [alignmentProposals, editor, showToast]);

  const handleCloseAlignmentPreview = useCallback(() => {
    setShowAlignmentPreview(false);
    setAlignmentProposals([]);
  }, []);

  const handlePostEditDone = useCallback(() => {
    setShowPostEditDialog(false);
    setPostEditAnalysis(null);
    setPostEditPatchCode('');
    setPostEditNewGeometry(null);
    setPostEditOldGeometry(null);
    setPostEditPreSimplifiedGeometry(null);
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
          {(() => {
            // #region agent log
            console.log('[DEBUG] SimplifyPanel RENDER CHECK', {hasSelectedPatch:!!editor.selectedPatch,isEditingBoundary,editMode:editor.editMode,willRender:!!(editor.selectedPatch&&isEditingBoundary),timestamp:Date.now()});
            // #endregion
            return null;
          })()}
          {editor.selectedPatch && isEditingBoundary && (
            <SimplifyPanel
              patch={editor.selectedPatch}
              isRefining={editor.editMode === 'simplify-refine'}
              neighbors={preEditNeighbors}
              neighborsLoading={neighborsLoading}
              linkedPatchIds={linkedPatchIds}
              onToggleLink={handleToggleLink}
              onSimplifiedGeometryChange={handleSimplifiedGeometryChange}
              onInitialSimplificationComplete={handleInitialSimplificationComplete}
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
            linkedNeighborOverlay={linkedNeighborOverlay}
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
        onOpenAlignmentPreview={handleOpenAlignmentPreview}
        onCreateGapPatch={handleCreateGapPatch}
        onDone={handlePostEditDone}
      />

      {showAlignmentPreview && postEditNewGeometry && (
        <AlignmentPreviewDialog
          isOpen={showAlignmentPreview}
          editedPatchCode={postEditPatchCode}
          editedGeometry={postEditNewGeometry}
          proposals={alignmentProposals}
          onUpdateProposal={handleUpdateProposal}
          onApply={handleApplyAlignments}
          onClose={handleCloseAlignmentPreview}
        />
      )}
    </div>
  );
}
