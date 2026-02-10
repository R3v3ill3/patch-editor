'use client';

import { useState, useCallback } from 'react';
import type { Feature, Polygon, MultiPolygon } from 'geojson';
import type { PostEditAnalysis } from '@/lib/geometry-edit';

interface PostEditDialogProps {
  isOpen: boolean;
  editedPatchCode: string;
  analysis: PostEditAnalysis;
  onApplyToDuplicates: (patchIds: string[]) => void;
  onAlignNeighbours: (patchIds: string[]) => void;
  onCreateGapPatch: (gapGeometry: Feature<Polygon | MultiPolygon>) => void;
  onDone: () => void;
}

export default function PostEditDialog({
  isOpen,
  editedPatchCode,
  analysis,
  onApplyToDuplicates,
  onAlignNeighbours,
  onCreateGapPatch,
  onDone,
}: PostEditDialogProps) {
  const [selectedNeighbours, setSelectedNeighbours] = useState<Set<string>>(new Set());

  const toggleNeighbour = useCallback((patchId: string) => {
    setSelectedNeighbours(prev => {
      const next = new Set(prev);
      if (next.has(patchId)) {
        next.delete(patchId);
      } else {
        next.add(patchId);
      }
      return next;
    });
  }, []);

  const selectAllNeighbours = useCallback(() => {
    setSelectedNeighbours(new Set(analysis.neighbours.map(n => n.patchId)));
  }, [analysis.neighbours]);

  const deselectAllNeighbours = useCallback(() => {
    setSelectedNeighbours(new Set());
  }, []);

  if (!isOpen) return null;

  const hasDuplicates = analysis.duplicates.length > 0;
  const hasNeighbours = analysis.neighbours.length > 0;
  const hasGap = analysis.gapGeometry !== null && analysis.gapAreaSqm > 0;

  if (!hasDuplicates && !hasNeighbours && !hasGap) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-6 pt-6 pb-3">
          <h2 className="text-lg font-semibold text-gray-900">
            Boundary Updated: {editedPatchCode}
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Review and apply post-edit actions as needed.
          </p>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 space-y-4">

          {/* 1. Duplicate Patches */}
          {hasDuplicates && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">
                Duplicate Patches
              </h3>
              <div className="bg-purple-50 border border-purple-200 rounded p-3">
                <p className="text-xs text-purple-800 mb-2">
                  {analysis.duplicates.length === 1
                    ? 'This patch has a duplicate with identical geometry.'
                    : `This patch has ${analysis.duplicates.length} duplicates with identical geometry.`}
                  {' '}Apply the same edit to keep them in sync.
                </p>
                <div className="space-y-1 mb-2">
                  {analysis.duplicates.map(d => (
                    <div key={d.patchId} className="text-xs text-purple-700">
                      {d.patchCode}
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => onApplyToDuplicates(analysis.duplicates.map(d => d.patchId))}
                  className="text-xs px-3 py-1.5 bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors"
                >
                  Apply Edit to {analysis.duplicates.length === 1 ? 'Duplicate' : 'All Duplicates'}
                </button>
              </div>
            </div>
          )}

          {/* 2. Neighbouring Patches (with checkboxes) */}
          {hasNeighbours && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-700">
                  Neighbouring Patches
                </h3>
                <div className="flex gap-2">
                  <button
                    onClick={selectAllNeighbours}
                    className="text-[10px] text-blue-600 hover:underline"
                  >
                    Select all
                  </button>
                  <button
                    onClick={deselectAllNeighbours}
                    className="text-[10px] text-gray-500 hover:underline"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="border border-gray-200 rounded divide-y divide-gray-100">
                {analysis.neighbours.map(n => (
                  <label
                    key={n.patchId}
                    className="p-3 flex items-center gap-3 cursor-pointer hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={selectedNeighbours.has(n.patchId)}
                      onChange={() => toggleNeighbour(n.patchId)}
                      className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium text-gray-900">
                        {n.patchCode}
                      </span>
                      <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${
                        n.relationship === 'overlap'
                          ? 'bg-red-100 text-red-700'
                          : n.relationship === 'gap'
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-green-100 text-green-700'
                      }`}>
                        {n.relationship === 'overlap' ? 'Overlapping' :
                         n.relationship === 'gap' ? 'Gap' : 'Aligned'}
                      </span>
                    </div>
                  </label>
                ))}
              </div>

              {selectedNeighbours.size > 0 && (
                <button
                  onClick={() => onAlignNeighbours(Array.from(selectedNeighbours))}
                  className="mt-2 w-full text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                >
                  Align {selectedNeighbours.size} Selected Neighbour{selectedNeighbours.size !== 1 ? 's' : ''} to Match
                </button>
              )}
            </div>
          )}

          {/* 3. Gap Detection */}
          {hasGap && analysis.gapGeometry && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">
                Unallocated Space
              </h3>
              <div className="bg-amber-50 border border-amber-200 rounded p-3">
                <p className="text-sm text-amber-800 mb-2">
                  A gap of{' '}
                  <span className="font-medium">
                    {analysis.gapAreaSqm < 10000
                      ? `${Math.round(analysis.gapAreaSqm)} m\u00B2`
                      : `${(analysis.gapAreaSqm / 10000).toFixed(2)} ha`}
                  </span>
                  {' '}was created. You can create a new patch to fill it.
                </p>
                <button
                  onClick={() => onCreateGapPatch(analysis.gapGeometry!)}
                  className="text-xs px-3 py-1.5 bg-amber-600 text-white rounded hover:bg-amber-700 transition-colors"
                >
                  Create Patch from Gap
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end">
          <button
            onClick={onDone}
            className="text-sm px-4 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
