'use client';

import type { AdjacentPatchInfo } from '@/lib/geometry-edit';

interface SyncDialogProps {
  isOpen: boolean;
  adjacentPatches: AdjacentPatchInfo[];
  onSync: (patchIds: string[]) => void;
  onSkip: () => void;
}

export default function SyncDialog({
  isOpen,
  adjacentPatches,
  onSync,
  onSkip,
}: SyncDialogProps) {
  if (!isOpen || adjacentPatches.length === 0) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">
          Shared Boundary Detected
        </h2>
        <p className="text-sm text-gray-600 mb-4">
          The boundary you edited is shared with {adjacentPatches.length === 1 ? 'another patch' : `${adjacentPatches.length} other patches`}.
          Would you like to sync {adjacentPatches.length === 1 ? 'its' : 'their'} boundary to match your changes?
        </p>

        <div className="space-y-2 mb-4">
          {adjacentPatches.map(ap => (
            <div
              key={ap.patchId}
              className="flex items-center gap-2 p-2 bg-gray-50 rounded text-sm"
            >
              <span className="font-medium text-gray-900">{ap.patchCode}</span>
              <span className="text-xs text-gray-500">
                ({ap.isReversed ? 'reverse direction' : 'same direction'})
              </span>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onSkip}
            className="text-sm px-4 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
          >
            Skip -- don't sync
          </button>
          <button
            onClick={() => onSync(adjacentPatches.map(ap => ap.patchId))}
            className="text-sm px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
          >
            Sync {adjacentPatches.length === 1 ? 'Boundary' : 'Boundaries'}
          </button>
        </div>
      </div>
    </div>
  );
}
