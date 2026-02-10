import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';

// ── Database row types ──────────────────────────────────────────────

export interface PatchRow {
  id: string;
  code: string;
  name: string | null;
  type: string | null;        // 'geo' | 'trade'
  status: string;             // 'active' | 'inactive'
  geom_geojson: MultiPolygon | null;
  sub_sectors: string[] | null;
  description: string | null;
  source_kml_path: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface OrganiserAssignment {
  id: string;
  organiser_id: string;
  patch_id: string;
  effective_from: string;
  effective_to: string | null;
  is_primary: boolean;
  organiser_name?: string;
  organiser_email?: string;
}

export interface Profile {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string | null;
}

// ── GeoJSON feature types ───────────────────────────────────────────

export interface PatchProperties {
  id: string;
  code: string;
  name: string | null;
  type: string | null;
  status: string;
  fillColor: string;
  outlineColor: string;
}

export type PatchFeature = Feature<MultiPolygon | Polygon, PatchProperties>;

export type PatchFeatureCollection = FeatureCollection<MultiPolygon | Polygon, PatchProperties>;

// ── Editor state ────────────────────────────────────────────────────

export type EditMode = 'view' | 'draw' | 'simplify' | 'simplify-refine';

export interface OverlapWarning {
  patchAId: string;
  patchACode: string;
  patchBId: string;
  patchBCode: string;
  overlapGeometry: Feature;
  overlapAreaSqm: number;
}

// ── Auth ────────────────────────────────────────────────────────────

export interface AppUser {
  id: string;
  email: string;
  fullName: string | null;
  role: string | null;
}
