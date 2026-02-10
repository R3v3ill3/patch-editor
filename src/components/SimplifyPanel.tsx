'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { MultiPolygon } from 'geojson';
import {
  simplifyPatch,
  computeSimplifyStats,
  findToleranceForTarget,
  type SimplifyStats,
} from '@/lib/simplify';
import type { PatchFeature } from '@/types';
import { ensureMultiPolygon } from '@/lib/geojson';

interface SimplifyPanelProps {
  patch: PatchFeature;
  isRefining: boolean;
  onSimplifiedGeometryChange: (geometry: MultiPolygon) => void;
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
  onSimplifiedGeometryChange,
  onRefine,
  onApply,
  onCancel,
}: SimplifyPanelProps) {
  const originalGeometry = useMemo(() => {
    return patch.geometry.type === 'MultiPolygon'
      ? patch.geometry as MultiPolygon
      : ensureMultiPolygon(patch.geometry);
  }, [patch.geometry]);

  const [loading, setLoading] = useState(true);
  const [sliderValue, setSliderValue] = useState(100); // mid-range default
  const [stats, setStats] = useState<SimplifyStats | null>(null);
  const [currentSimplified, setCurrentSimplified] = useState<MultiPolygon | null>(null);

  const tolerance = logToTolerance(sliderToLog(sliderValue));

  // Initial computation: find a good default tolerance (runs once, async-ish)
  useEffect(() => {
    setLoading(true);
    // Defer heavy computation to next frame so the loading UI renders first
    const timeoutId = setTimeout(() => {
      const initStats = computeSimplifyStats(originalGeometry, originalGeometry);
      const target = Math.max(50, Math.floor(initStats.originalVertexCount * 0.1));
      const defaultTol = findToleranceForTarget(originalGeometry, target);

      const defaultSlider = logToSlider(toleranceToLog(defaultTol));
      setSliderValue(defaultSlider);

      const simplified = simplifyPatch(originalGeometry, defaultTol);
      const newStats = computeSimplifyStats(originalGeometry, simplified);
      setStats(newStats);
      setCurrentSimplified(simplified);
      onSimplifiedGeometryChange(simplified);
      setLoading(false);
    }, 50);

    return () => clearTimeout(timeoutId);
  // Only on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalGeometry]);

  // Recompute when slider changes (after initial load)
  useEffect(() => {
    if (loading || isRefining) return;

    const simplified = simplifyPatch(originalGeometry, tolerance);
    const newStats = computeSimplifyStats(originalGeometry, simplified);
    setStats(newStats);
    setCurrentSimplified(simplified);
    onSimplifiedGeometryChange(simplified);
  }, [tolerance, originalGeometry, loading, isRefining, onSimplifiedGeometryChange]);

  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSliderValue(Number(e.target.value));
  }, []);

  const handleRefine = useCallback(() => {
    if (currentSimplified) {
      onRefine(currentSimplified);
    }
  }, [currentSimplified, onRefine]);

  const handleApply = useCallback(() => {
    if (isRefining) {
      // Extract the refined geometry from terra-draw
      window.dispatchEvent(new CustomEvent('extract-edit-region'));
    } else if (currentSimplified) {
      onApply(currentSimplified);
    }
  }, [currentSimplified, onApply, isRefining]);

  return (
    <div className="border-t border-gray-200 p-3 space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">
        Simplify: {patch.properties.code}
      </h3>

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
          {stats && (
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
                <span className={`font-medium ${
                  stats.maxDeviationMeters > 50 ? 'text-red-600' :
                  stats.maxDeviationMeters > 10 ? 'text-amber-600' : 'text-green-600'
                }`}>
                  {stats.maxDeviationMeters < 1
                    ? `${(stats.maxDeviationMeters * 100).toFixed(0)}cm`
                    : stats.maxDeviationMeters < 1000
                    ? `${stats.maxDeviationMeters.toFixed(1)}m`
                    : `${(stats.maxDeviationMeters / 1000).toFixed(2)}km`}
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
            disabled={!currentSimplified}
            className="w-full text-xs px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            Apply Simplification
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
