'use client';

import { useState, useMemo } from 'react';
import type { PatchFeatureCollection } from '@/types';

interface PatchListPanelProps {
  featureCollection: PatchFeatureCollection;
  selectedPatchId: string | null;
  dirtyPatchIds: Set<string>;
  onSelectPatch: (id: string | null) => void;
}

export default function PatchListPanel({
  featureCollection,
  selectedPatchId,
  dirtyPatchIds,
  onSelectPatch,
}: PatchListPanelProps) {
  const [search, setSearch] = useState('');

  const filteredPatches = useMemo(() => {
    const query = search.toLowerCase().trim();
    if (!query) return featureCollection.features;
    return featureCollection.features.filter(f => {
      const name = (f.properties.name ?? '').toLowerCase();
      const code = f.properties.code.toLowerCase();
      return name.includes(query) || code.includes(query);
    });
  }, [featureCollection.features, search]);

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="p-3 border-b border-gray-200">
        <input
          type="text"
          placeholder="Search patches..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      {/* Patch list */}
      <div className="flex-1 overflow-y-auto">
        {filteredPatches.length === 0 ? (
          <div className="p-4 text-sm text-gray-500 text-center">
            No patches found
          </div>
        ) : (
          filteredPatches.map(feature => {
            const { id, code, name, fillColor } = feature.properties;
            const isSelected = id === selectedPatchId;
            const isDirty = dirtyPatchIds.has(id);

            return (
              <button
                key={id}
                onClick={() => onSelectPatch(isSelected ? null : id)}
                className={`w-full text-left px-3 py-2 border-b border-gray-100 hover:bg-gray-50 transition-colors flex items-center gap-2 ${
                  isSelected ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''
                }`}
              >
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: fillColor }}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-gray-900 truncate">
                    {code}
                    {isDirty && (
                      <span className="ml-1 text-amber-500 text-xs">*</span>
                    )}
                  </div>
                  {name && (
                    <div className="text-xs text-gray-500 truncate">{name}</div>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Count */}
      <div className="p-2 border-t border-gray-200 text-xs text-gray-500 text-center">
        {featureCollection.features.length} patches
        {dirtyPatchIds.size > 0 && (
          <span className="ml-2 text-amber-600">
            ({dirtyPatchIds.size} unsaved)
          </span>
        )}
      </div>
    </div>
  );
}
