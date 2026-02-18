'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { MultiPolygon } from 'geojson';
import {
  simplifyPatch,
  computeSimplifyStats,
  findToleranceForTarget,
  type SimplifyStats,
} from '@/lib/simplify';
import type { PatchFeature } from '@/types';
import type { AdjacentPatchInfo } from '@/lib/geometry-edit';
import { ensureMultiPolygon } from '@/lib/geojson';

interface SimplifyPanelProps {
  patch: PatchFeature;
  isRefining: boolean;
  neighbors?: AdjacentPatchInfo[];
  neighborsLoading?: boolean;
  linkedPatchIds?: Set<string>;
  onToggleLink?: (patchId: string) => void;
  onSimplifiedGeometryChange: (geometry: MultiPolygon) => void;
  onInitialSimplificationComplete?: (simplifiedGeometry: MultiPolygon) => void;
  onRefine: (geometry: MultiPolygon) => void;
  onApply: (geometry: MultiPolygon) => void;
  onCancel: () => void;
}

// Tolerance slider uses log scale
const MIN_LOG = -7;  // 10^-7
const MAX_LOG = -2;  // 10^-2
const SLIDER_STEPS = 200;

function logToTolerance(logVal: number): number {
  return Math.pow(10, logVal);
}

function toleranceToLog(tolerance: number): number {
  return Math.log10(tolerance);
}

function sliderToLog(sliderVal: number): number {
  return MIN_LOG + (sliderVal / SLIDER_STEPS) * (MAX_LOG - MIN_LOG);
}

function logToSlider(logVal: number): number {
  return Math.round(((logVal - MIN_LOG) / (MAX_LOG - MIN_LOG)) * SLIDER_STEPS);
}

export default function SimplifyPanel({
  patch,
  isRefining,
  neighbors = [],
  neighborsLoading = false,
  linkedPatchIds = new Set(),
  onToggleLink,
  onSimplifiedGeometryChange,
  onInitialSimplificationComplete,
  onRefine,
  onApply,
  onCancel,
}: SimplifyPanelProps) {
  // #region agent log
  console.log('[DEBUG] SimplifyPanel RENDER', {patchId:patch.properties.id,isRefining,neighborCount:neighbors.length,timestamp:Date.now()});
  // #endregion
  const originalGeometry = useMemo(() => {
    // #region agent log
    console.log('[DEBUG] SimplifyPanel originalGeometry useMemo COMPUTING', {patchId:patch.properties.id,timestamp:Date.now()});
    // #endregion
    return patch.geometry.type === 'MultiPolygon'
      ? patch.geometry as MultiPolygon
      : ensureMultiPolygon(patch.geometry);
  }, [patch.geometry]);

  const [loading, setLoading] = useState(true);
  const [sliderValue, setSliderValue] = useState(100); // mid-range default
  const [stats, setStats] = useState<SimplifyStats | null>(null);
  const [currentSimplified, setCurrentSimplified] = useState<MultiPolygon | null>(null);
  const [backgroundRefining, setBackgroundRefining] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const initialComputationRanRef = useRef(false);
  const initialNeighborsTriggeredRef = useRef(false);
  const computeJobRef = useRef(0);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refineTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextSliderRef = useRef(false);
  const lastRefinedRef = useRef<{ tolerance: number; geometry: MultiPolygon } | null>(null);
  const onSimplifiedGeometryChangeRef = useRef(onSimplifiedGeometryChange);
  const onInitialSimplificationCompleteRef = useRef(onInitialSimplificationComplete);

  const tolerance = logToTolerance(sliderToLog(sliderValue));

  const cancelPendingTimers = useCallback(() => {
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
    if (refineTimeoutRef.current) {
      clearTimeout(refineTimeoutRef.current);
      refineTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    cancelPendingTimers();
    computeJobRef.current += 1;
    initialComputationRanRef.current = false;
    initialNeighborsTriggeredRef.current = false;
    skipNextSliderRef.current = false;
    lastRefinedRef.current = null;
    setLoading(true);
    setBackgroundRefining(false);
    setIsApplying(false);
    setStats(null);
    setCurrentSimplified(null);
  }, [patch.properties.id, cancelPendingTimers]);

  useEffect(() => {
    onSimplifiedGeometryChangeRef.current = onSimplifiedGeometryChange;
    onInitialSimplificationCompleteRef.current = onInitialSimplificationComplete;
  }, [onSimplifiedGeometryChange, onInitialSimplificationComplete]);

  const schedulePreviewAndRefine = useCallback((
    targetTolerance: number,
    options: { refineDelayMs: number; triggerInitialNeighbors?: boolean; setLoading?: boolean }
  ) => {
    const {
      refineDelayMs,
      triggerInitialNeighbors = false,
      setLoading: shouldSetLoading = false,
    } = options;

    const jobId = ++computeJobRef.current;
    cancelPendingTimers();
    if (shouldSetLoading) {
      setLoading(true);
    }
    setBackgroundRefining(true);

    previewTimeoutRef.current = setTimeout(() => {
      const preview = simplifyPatch(originalGeometry, targetTolerance, { highQuality: false });
      const previewStats = computeSimplifyStats(originalGeometry, preview, { includeDeviation: false });

      if (jobId !== computeJobRef.current) return;
      setCurrentSimplified(preview);
      setStats(previewStats);
      onSimplifiedGeometryChangeRef.current(preview);
      setLoading(false);

      refineTimeoutRef.current = setTimeout(() => {
        const refined = simplifyPatch(originalGeometry, targetTolerance, { highQuality: true });
        const refinedStats = computeSimplifyStats(originalGeometry, refined, { includeDeviation: true });

        if (jobId !== computeJobRef.current) return;
        lastRefinedRef.current = { tolerance: targetTolerance, geometry: refined };
        setCurrentSimplified(refined);
        setStats(refinedStats);
        onSimplifiedGeometryChangeRef.current(refined);
        setBackgroundRefining(false);

        if (triggerInitialNeighbors && !initialNeighborsTriggeredRef.current) {
          initialNeighborsTriggeredRef.current = true;
          onInitialSimplificationCompleteRef.current?.(refined);
        }
      }, refineDelayMs);
    }, 0);
  }, [
    cancelPendingTimers,
    originalGeometry,
  ]);

  // Initial computation: find a good default tolerance (runs once, async-ish)
  useEffect(() => {
    // #region agent log
    const vtxCount = originalGeometry.coordinates.reduce((acc,p)=>acc+p.reduce((a,r)=>a+r.length,0),0);
    console.log('[DEBUG] SimplifyPanel INITIAL COMPUTATION useEffect TRIGGERED', {vertexCount:vtxCount,alreadyRan:initialComputationRanRef.current,timestamp:Date.now()});
    // #endregion
    if (initialComputationRanRef.current) {
      // #region agent log
      console.log('[DEBUG] SimplifyPanel SKIPPING re-run of initial computation', {timestamp:Date.now()});
      // #endregion
      return;
    }
    initialComputationRanRef.current = true;
    setLoading(true);
    setBackgroundRefining(false);
    setStats(null);
    setCurrentSimplified(null);
    lastRefinedRef.current = null;
    initialNeighborsTriggeredRef.current = false;
    // Defer heavy computation to next frame so the loading UI renders first
    const timeoutId = setTimeout(() => {
      // #region agent log
      console.log('[DEBUG] SimplifyPanel TIMEOUT FIRED - computing stats', {timestamp:Date.now()});
      // #endregion
      const initStats = computeSimplifyStats(originalGeometry, originalGeometry, { includeDeviation: false });
      // #region agent log
      console.log('[DEBUG] SimplifyPanel STATS COMPUTED', {originalVertexCount:initStats.originalVertexCount,timestamp:Date.now()});
      // #endregion
      const target = Math.max(50, Math.floor(initStats.originalVertexCount * 0.1));
      // #region agent log
      console.log('[DEBUG] SimplifyPanel BEFORE findToleranceForTarget', {target,timestamp:Date.now()});
      // #endregion
      const defaultTol = findToleranceForTarget(originalGeometry, target, { highQuality: false });
      // #region agent log
      console.log('[DEBUG] SimplifyPanel AFTER findToleranceForTarget', {defaultTol,timestamp:Date.now()});
      // #endregion

      const defaultSlider = logToSlider(toleranceToLog(defaultTol));
      skipNextSliderRef.current = true;
      setSliderValue(defaultSlider);

      schedulePreviewAndRefine(defaultTol, { refineDelayMs: 0, triggerInitialNeighbors: true });
    }, 50);

    return () => clearTimeout(timeoutId);
  // Only on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalGeometry]);

  // Recompute when slider changes (after initial load)
  useEffect(() => {
    if (loading || isRefining) return;

    if (skipNextSliderRef.current) {
      skipNextSliderRef.current = false;
      return;
    }

    schedulePreviewAndRefine(tolerance, { refineDelayMs: 250 });
  }, [tolerance, loading, isRefining, schedulePreviewAndRefine]);

  useEffect(() => () => cancelPendingTimers(), [cancelPendingTimers]);

  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSliderValue(Number(e.target.value));
  }, []);

  const handleRefine = useCallback(() => {
    if (currentSimplified) {
      onRefine(currentSimplified);
    }
  }, [currentSimplified, onRefine]);

  const handleApply = useCallback(() => {
    // #region agent log
    console.log('[DEBUG] SimplifyPanel handleApply CLICKED', { isRefining, hasCurrentSimplified: !!currentSimplified, timestamp:Date.now() });
    // #endregion
    if (isRefining) {
      // Extract the refined geometry from terra-draw
      // #region agent log
      console.log('[DEBUG] SimplifyPanel dispatching extract-edit-region event', {timestamp:Date.now()});
      // #endregion
      window.dispatchEvent(new CustomEvent('extract-edit-region'));
    } else if (currentSimplified && !isApplying) {
      const refinedMatch = lastRefinedRef.current &&
        lastRefinedRef.current.tolerance === tolerance
        ? lastRefinedRef.current.geometry
        : null;

      if (refinedMatch && !backgroundRefining) {
        onApply(refinedMatch);
        return;
      }

      // Ensure apply uses high-quality geometry for current tolerance
      cancelPendingTimers();
      const jobId = ++computeJobRef.current;
      setBackgroundRefining(false);
      setIsApplying(true);

      setTimeout(() => {
        const refined = simplifyPatch(originalGeometry, tolerance, { highQuality: true });
        const refinedStats = computeSimplifyStats(originalGeometry, refined, { includeDeviation: true });

        if (jobId !== computeJobRef.current) return;
        lastRefinedRef.current = { tolerance, geometry: refined };
        setCurrentSimplified(refined);
        setStats(refinedStats);
        onSimplifiedGeometryChange(refined);
        setIsApplying(false);
        onApply(refined);
      }, 0);
    }
  }, [
    backgroundRefining,
    cancelPendingTimers,
    currentSimplified,
    isApplying,
    isRefining,
    onApply,
    onSimplifiedGeometryChange,
    originalGeometry,
    tolerance,
  ]);

  return (
    <div className="border-t border-gray-200 p-3 space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">
        Simplify: {patch.properties.code}
      </h3>

      {/* Linked neighbor selection */}
      {neighborsLoading && !loading && (
        <div className="flex items-center gap-2 text-[10px] text-indigo-500 bg-indigo-50 border border-indigo-200 rounded px-2 py-1">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />
          Shared boundaries loading...
        </div>
      )}
      {neighbors.length > 0 && !loading && (
        <div className="bg-indigo-50 border border-indigo-200 rounded p-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-indigo-800">
              Shared boundaries
            </span>
            <span className="text-[10px] text-indigo-500">
              {linkedPatchIds.size}/{neighbors.length} linked
            </span>
          </div>
          <div className="space-y-1 max-h-[120px] overflow-y-auto">
            {neighbors.map(n => {
              const isLinked = linkedPatchIds.has(n.patchId);
              return (
                <label
                  key={n.patchId}
                  className="flex items-center gap-2 text-xs cursor-pointer hover:bg-indigo-100 rounded px-1 py-0.5 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={isLinked}
                    onChange={() => onToggleLink?.(n.patchId)}
                    className="rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500 h-3.5 w-3.5"
                  />
                  <span className={isLinked ? 'text-indigo-900' : 'text-indigo-400'}>
                    {n.patchCode}
                  </span>
                  <span className="text-[10px] text-indigo-400 ml-auto">
                    {n.matchedVertexCount} vtx
                  </span>
                </label>
              );
            })}
          </div>
          <p className="text-[10px] text-indigo-500 leading-tight">
            Linked neighbors will be auto-aligned when you apply.
          </p>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 py-4 justify-center">
          <svg className="animate-spin h-5 w-5 text-purple-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-sm text-gray-500">Analyzing geometry...</span>
        </div>
      )}

      {!loading && !isRefining && (
        <>
          {/* Tolerance slider */}
          <div>
            <label className="text-xs text-gray-500 block mb-1">
              Simplification Level
            </label>
            <input
              type="range"
              min={0}
              max={SLIDER_STEPS}
              value={sliderValue}
              onChange={handleSliderChange}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
            <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
              <span>Fine</span>
              <span>Aggressive</span>
            </div>
          </div>

          {/* Stats */}
          {stats && (() => {
            const deviationReady = Number.isFinite(stats.maxDeviationMeters);
            const deviationClass = deviationReady
              ? (stats.maxDeviationMeters > 50 ? 'text-red-600' :
                stats.maxDeviationMeters > 10 ? 'text-amber-600' : 'text-green-600')
              : 'text-gray-400';
            const deviationText = deviationReady
              ? (stats.maxDeviationMeters < 1
                ? `${(stats.maxDeviationMeters * 100).toFixed(0)}cm`
                : stats.maxDeviationMeters < 1000
                ? `${stats.maxDeviationMeters.toFixed(1)}m`
                : `${(stats.maxDeviationMeters / 1000).toFixed(2)}km`)
              : 'Calculating...';

            return (
              <div className="bg-gray-50 rounded p-2 space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">Vertices:</span>
                  <span className="font-medium">
                    {stats.originalVertexCount.toLocaleString()}
                    {' -> '}
                    <span className={stats.reductionPercent > 50 ? 'text-green-600' : 'text-gray-900'}>
                      {stats.simplifiedVertexCount.toLocaleString()}
                    </span>
                    <span className="text-gray-400 ml-1">
                      (-{stats.reductionPercent.toFixed(0)}%)
                    </span>
                  </span>
                </div>

                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">Max deviation:</span>
                  <span className={`font-medium ${deviationClass}`}>
                    {deviationText}
                  </span>
                </div>

                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">Area change:</span>
                  <span className={`font-medium ${
                    Math.abs(stats.areaChangePercent) > 1 ? 'text-red-600' :
                    Math.abs(stats.areaChangePercent) > 0.1 ? 'text-amber-600' : 'text-green-600'
                  }`}>
                    {stats.areaChangePercent >= 0 ? '+' : ''}
                    {stats.areaChangePercent.toFixed(3)}%
                  </span>
                </div>
              </div>
            );
          })()}

          {backgroundRefining && (
            <div className="text-[10px] text-gray-400">
              Refining geometry in background...
            </div>
          )}
        </>
      )}

      {isRefining && (
        <div className="text-xs text-blue-700 bg-blue-50 p-2 rounded space-y-1">
          <p className="font-medium">Manual Refinement</p>
          <p>Drag vertices to fine-tune the boundary.</p>
          <p>Click on the line between vertices to add new points.</p>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-col gap-2">
        {!loading && !isRefining && (
          <button
            onClick={handleRefine}
            disabled={!currentSimplified}
            className="w-full text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            Refine Manually
          </button>
        )}

        {!loading && (
          <button
            onClick={handleApply}
            disabled={!currentSimplified || isApplying}
            className="w-full text-xs px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            {isApplying ? 'Finalizing...' : 'Apply Simplification'}
          </button>
        )}

        <button
          onClick={onCancel}
          className="w-full text-xs px-3 py-1.5 bg-gray-100 text-gray-700 border border-gray-200 rounded hover:bg-gray-200 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
