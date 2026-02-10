'use client';

import type { AppUser, EditMode } from '@/types';

interface ToolbarProps {
  user: AppUser | null;
  isAdmin: boolean;
  editMode: EditMode;
  hasDirtyPatches: boolean;
  canUndo: boolean;
  canRedo: boolean;
  saving: boolean;
  onValidate: () => void;
  onSave: () => void;
  onExport: () => void;
  onImport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDrawNew: () => void;
  onCancelDraw: () => void;
  onSignOut: () => void;
}

export default function Toolbar({
  user,
  isAdmin,
  editMode,
  hasDirtyPatches,
  canUndo,
  canRedo,
  saving,
  onValidate,
  onSave,
  onExport,
  onImport,
  onUndo,
  onRedo,
  onDrawNew,
  onCancelDraw,
  onSignOut,
}: ToolbarProps) {
  return (
    <header className="flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200 shadow-sm z-10">
      {/* Left: App name + action buttons */}
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold text-gray-900 mr-2">Patch Editor</h1>

        <div className="h-5 w-px bg-gray-300" />

        <button
          onClick={onValidate}
          className="text-xs px-3 py-1.5 bg-amber-50 text-amber-700 border border-amber-200 rounded hover:bg-amber-100 transition-colors"
        >
          Validate
        </button>

        {isAdmin && (
          <button
            onClick={onSave}
            disabled={!hasDirtyPatches || saving}
            className="text-xs px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        )}

        <button
          onClick={onExport}
          className="text-xs px-3 py-1.5 bg-gray-100 text-gray-700 border border-gray-200 rounded hover:bg-gray-200 transition-colors"
        >
          Export
        </button>

        {isAdmin && (
          <button
            onClick={onImport}
            className="text-xs px-3 py-1.5 bg-gray-100 text-gray-700 border border-gray-200 rounded hover:bg-gray-200 transition-colors"
          >
            Import
          </button>
        )}

        <div className="h-5 w-px bg-gray-300" />

        <button
          onClick={onUndo}
          disabled={!canUndo}
          className="text-xs px-2 py-1.5 text-gray-600 hover:bg-gray-100 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Undo (Ctrl+Z)"
        >
          Undo
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          className="text-xs px-2 py-1.5 text-gray-600 hover:bg-gray-100 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Redo (Ctrl+Shift+Z)"
        >
          Redo
        </button>

        <div className="h-5 w-px bg-gray-300" />

        {isAdmin && editMode !== 'draw' && (
          <button
            onClick={onDrawNew}
            className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
          >
            + Draw New Patch
          </button>
        )}

        {editMode === 'draw' && (
          <button
            onClick={onCancelDraw}
            className="text-xs px-3 py-1.5 bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 transition-colors"
          >
            Cancel Drawing
          </button>
        )}
      </div>

      {/* Right: User info */}
      <div className="flex items-center gap-3">
        {editMode === 'simplify' && (
          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">
            Edit Boundary -- Preview
          </span>
        )}
        {editMode === 'simplify-refine' && (
          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">
            Edit Boundary -- Refining
          </span>
        )}
        {editMode === 'draw' && (
          <span className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded">
            Drawing Mode
          </span>
        )}
        {user && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-gray-700">
              {user.fullName ?? user.email}
            </span>
            <span className={`text-xs px-1.5 py-0.5 rounded ${
              isAdmin
                ? 'bg-green-100 text-green-700'
                : 'bg-gray-100 text-gray-600'
            }`}>
              {user.role ?? 'user'}
            </span>
            <button
              onClick={onSignOut}
              className="text-xs text-gray-500 hover:text-gray-700 underline"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
