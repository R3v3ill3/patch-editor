import { intersect, area } from '@turf/turf';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import type { PatchFeature, OverlapWarning } from '@/types';

/**
 * Check all patch pairs for geometry overlaps.
 * Returns an array of overlap warnings with the overlapping geometry.
 */
export function validateOverlaps(patches: PatchFeature[]): OverlapWarning[] {
  const warnings: OverlapWarning[] = [];

  for (let i = 0; i < patches.length; i++) {
    for (let j = i + 1; j < patches.length; j++) {
      const a = patches[i];
      const b = patches[j];

      if (!a.geometry || !b.geometry) continue;

      try {
        const overlap = intersect(
          { type: 'FeatureCollection', features: [a as Feature<Polygon | MultiPolygon>, b as Feature<Polygon | MultiPolygon>] }
        );

        if (overlap) {
          const overlapArea = area(overlap);
          // Only report overlaps larger than 100 sq meters to avoid float noise
          if (overlapArea > 100) {
            warnings.push({
              patchAId: a.properties.id,
              patchACode: a.properties.code,
              patchBId: b.properties.id,
              patchBCode: b.properties.code,
              overlapGeometry: overlap,
              overlapAreaSqm: overlapArea,
            });
          }
        }
      } catch {
        // Skip invalid geometry pairs
        console.warn(`Could not check overlap between ${a.properties.code} and ${b.properties.code}`);
      }
    }
  }

  return warnings;
}
