'use client';

import { useOrganiserAssignments } from '@/hooks/usePatchData';
import type { PatchFeature, EditMode } from '@/types';

interface PatchDetailsPanelProps {
  patch: PatchFeature;
  editMode: EditMode;
  isAdmin: boolean;
  onEditBoundary: () => void;
  onDelete: () => void;
}

export default function PatchDetailsPanel({
  patch,
  editMode,
  isAdmin,
  onEditBoundary,
  onDelete,
}: PatchDetailsPanelProps) {
  const { assignments, loading: assignmentsLoading } = useOrganiserAssignments(patch.properties.id);

  return (
    <div className="border-t border-gray-200 p-3 space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">Selected Patch</h3>

      <div className="space-y-1">
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Code:</span>
          <span className="font-medium">{patch.properties.code}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Name:</span>
          <span className="font-medium">{patch.properties.name ?? '--'}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Status:</span>
          <span className={`text-xs px-1.5 py-0.5 rounded ${
            patch.properties.status === 'active'
              ? 'bg-green-100 text-green-700'
              : 'bg-gray-100 text-gray-600'
          }`}>
            {patch.properties.status}
          </span>
        </div>
      </div>

      {/* Assigned Organisers */}
      <div>
        <h4 className="text-xs font-medium text-gray-500 mb-1">Assigned Organisers</h4>
        {assignmentsLoading ? (
          <div className="text-xs text-gray-400">Loading...</div>
        ) : assignments.length === 0 ? (
          <div className="text-xs text-gray-400">None assigned</div>
        ) : (
          <div className="space-y-1">
            {assignments.map(a => (
              <div key={a.id} className="text-xs text-gray-700 flex items-center gap-1">
                <span>{a.organiser_name ?? a.organiser_email ?? 'Unknown'}</span>
                {a.is_primary && (
                  <span className="text-[10px] bg-blue-100 text-blue-700 px-1 rounded">primary</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Action buttons */}
      {isAdmin && editMode === 'view' && (
        <div className="space-y-2 pt-1">
          <button
            onClick={onEditBoundary}
            className="w-full text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
          >
            Edit Boundary
          </button>
          <button
            onClick={onDelete}
            className="w-full text-xs px-3 py-1.5 bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 transition-colors"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
