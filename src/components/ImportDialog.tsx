'use client';

import { useState, useRef, useCallback } from 'react';
import type { FeatureCollection, Feature, Geometry, MultiPolygon, Polygon } from 'geojson';
import { ensureMultiPolygon } from '@/lib/geojson';
import { getPatchColor } from '@/lib/colors';
import type { PatchFeature, PatchFeatureCollection } from '@/types';

interface ImportDialogProps {
  isOpen: boolean;
  existingPatches: PatchFeatureCollection;
  onClose: () => void;
  onImport: (patches: PatchFeature[]) => void;
}

interface ImportedFeature {
  originalFeature: Feature;
  action: 'new' | 'update';
  targetPatchId: string | null;
  code: string;
  name: string;
}

export default function ImportDialog({
  isOpen,
  existingPatches,
  onClose,
  onImport,
}: ImportDialogProps) {
  const [importedFeatures, setImportedFeatures] = useState<ImportedFeature[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = JSON.parse(event.target?.result as string);

        let features: Feature[] = [];
        if (content.type === 'FeatureCollection') {
          features = (content as FeatureCollection).features;
        } else if (content.type === 'Feature') {
          features = [content as Feature];
        } else {
          throw new Error('Invalid GeoJSON: expected FeatureCollection or Feature');
        }

        // Filter for polygon/multipolygon features
        const polygonFeatures = features.filter(
          f => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'
        );

        if (polygonFeatures.length === 0) {
          throw new Error('No polygon features found in the file');
        }

        const mapped: ImportedFeature[] = polygonFeatures.map(f => {
          const code = (f.properties?.code ?? f.properties?.Code ?? f.properties?.CODE ?? '') as string;
          const name = (f.properties?.name ?? f.properties?.Name ?? f.properties?.NAME ?? '') as string;

          // Try to match to existing patch by code
          const match = code
            ? existingPatches.features.find(
                ep => ep.properties.code.toLowerCase() === code.toLowerCase()
              )
            : null;

          return {
            originalFeature: f,
            action: match ? 'update' : 'new',
            targetPatchId: match?.properties.id ?? null,
            code: code || `IMPORT-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            name: name || '',
          };
        });

        setImportedFeatures(mapped);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to parse file');
        setImportedFeatures([]);
      }
    };
    reader.readAsText(file);
  }, [existingPatches]);

  const handleImport = useCallback(() => {
    const patches: PatchFeature[] = importedFeatures.map(item => {
      const geometry = ensureMultiPolygon(item.originalFeature.geometry);
      const id = item.targetPatchId ?? (self.crypto?.randomUUID?.() ?? (Math.random().toString(36).slice(2) + Date.now().toString(36)));
      const colors = getPatchColor(id);

      return {
        type: 'Feature' as const,
        id,
        geometry,
        properties: {
          id,
          code: item.code,
          name: item.name || null,
          type: 'geo',
          status: 'active',
          fillColor: colors.fillWithAlpha,
          outlineColor: colors.outline,
        },
      };
    });

    onImport(patches);
    setImportedFeatures([]);
    onClose();
  }, [importedFeatures, onImport, onClose]);

  const updateFeature = useCallback((index: number, updates: Partial<ImportedFeature>) => {
    setImportedFeatures(prev => prev.map((f, i) => i === index ? { ...f, ...updates } : f));
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Import GeoJSON</h2>
          <p className="text-sm text-gray-500 mt-1">Upload a .geojson file to import patch boundaries</p>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* File input */}
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".geojson,.json"
              onChange={handleFileUpload}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
            />
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 p-3 rounded">{error}</div>
          )}

          {/* Feature list */}
          {importedFeatures.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-gray-700">
                {importedFeatures.length} feature{importedFeatures.length !== 1 ? 's' : ''} found
              </h3>

              <div className="border border-gray-200 rounded divide-y">
                {importedFeatures.map((item, idx) => (
                  <div key={idx} className="p-3 space-y-2">
                    <div className="flex items-center gap-3">
                      <select
                        value={item.action}
                        onChange={e => updateFeature(idx, {
                          action: e.target.value as 'new' | 'update',
                          targetPatchId: e.target.value === 'new' ? null : item.targetPatchId,
                        })}
                        className="text-xs border border-gray-300 rounded px-2 py-1"
                      >
                        <option value="new">Create New</option>
                        <option value="update">Update Existing</option>
                      </select>

                      {item.action === 'update' && (
                        <select
                          value={item.targetPatchId ?? ''}
                          onChange={e => updateFeature(idx, { targetPatchId: e.target.value || null })}
                          className="text-xs border border-gray-300 rounded px-2 py-1 flex-1"
                        >
                          <option value="">-- Select patch --</option>
                          {existingPatches.features.map(p => (
                            <option key={p.properties.id} value={p.properties.id}>
                              {p.properties.code} - {p.properties.name ?? ''}
                            </option>
                          ))}
                        </select>
                      )}

                      {item.action === 'new' && (
                        <>
                          <input
                            type="text"
                            placeholder="Code"
                            value={item.code}
                            onChange={e => updateFeature(idx, { code: e.target.value })}
                            className="text-xs border border-gray-300 rounded px-2 py-1 w-24"
                          />
                          <input
                            type="text"
                            placeholder="Name"
                            value={item.name}
                            onChange={e => updateFeature(idx, { name: e.target.value })}
                            className="text-xs border border-gray-300 rounded px-2 py-1 flex-1"
                          />
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
          <button
            onClick={() => { setImportedFeatures([]); setError(null); onClose(); }}
            className="text-sm px-4 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={importedFeatures.length === 0}
            className="text-sm px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Import {importedFeatures.length} Feature{importedFeatures.length !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
