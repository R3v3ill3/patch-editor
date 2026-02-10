'use client';

import type { PatchFeatureCollection } from '@/types';

interface ExportButtonProps {
  featureCollection: PatchFeatureCollection;
  selectedPatchId: string | null;
}

export function exportGeoJSON(featureCollection: PatchFeatureCollection, selectedPatchId: string | null) {
  // If a patch is selected, export only that; otherwise export all
  const features = selectedPatchId
    ? featureCollection.features.filter(f => f.properties.id === selectedPatchId)
    : featureCollection.features;

  const exportData = {
    type: 'FeatureCollection',
    features: features.map(f => ({
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        id: f.properties.id,
        code: f.properties.code,
        name: f.properties.name,
      },
    })),
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = selectedPatchId
    ? `patch-${features[0]?.properties.code ?? 'export'}.geojson`
    : 'patches-export.geojson';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function ExportButton({ featureCollection, selectedPatchId }: ExportButtonProps) {
  return (
    <button
      onClick={() => exportGeoJSON(featureCollection, selectedPatchId)}
      className="text-xs px-3 py-1.5 bg-gray-100 text-gray-700 border border-gray-200 rounded hover:bg-gray-200 transition-colors"
    >
      Export GeoJSON
    </button>
  );
}
