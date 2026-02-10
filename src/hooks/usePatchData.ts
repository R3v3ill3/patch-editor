'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { getPatchColor } from '@/lib/colors';
import type { PatchRow, PatchFeature, PatchFeatureCollection, OrganiserAssignment } from '@/types';

export function usePatchData() {
  const [patches, setPatches] = useState<PatchRow[]>([]);
  const [featureCollection, setFeatureCollection] = useState<PatchFeatureCollection>({
    type: 'FeatureCollection',
    features: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPatches = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await supabase
        .from('patches_with_geojson')
        .select('*')
        .eq('type', 'geo')
        .eq('status', 'active');

      if (queryError) throw queryError;

      const rows = (data ?? []) as PatchRow[];
      setPatches(rows);

      // Convert to GeoJSON FeatureCollection
      const features: PatchFeature[] = rows
        .filter(row => row.geom_geojson != null)
        .map(row => {
          const colors = getPatchColor(row.id);
          return {
            type: 'Feature' as const,
            id: row.id,
            geometry: row.geom_geojson!,
            properties: {
              id: row.id,
              code: row.code,
              name: row.name,
              type: row.type,
              status: row.status,
              fillColor: colors.fillWithAlpha,
              outlineColor: colors.outline,
            },
          };
        });

      setFeatureCollection({ type: 'FeatureCollection', features });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to fetch patches';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPatches();
  }, [fetchPatches]);

  return { patches, featureCollection, loading, error, refetch: fetchPatches };
}

export function useOrganiserAssignments(patchId: string | null) {
  const [assignments, setAssignments] = useState<OrganiserAssignment[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!patchId) {
      setAssignments([]);
      return;
    }

    setLoading(true);
    supabase
      .from('organiser_patch_assignments')
      .select(`
        id,
        organiser_id,
        patch_id,
        effective_from,
        effective_to,
        is_primary,
        profiles:organiser_id (full_name, email)
      `)
      .eq('patch_id', patchId)
      .is('effective_to', null)
      .then(({ data }) => {
        const mapped = (data ?? []).map((row: Record<string, unknown>) => {
          const profile = row.profiles as Record<string, unknown> | null;
          return {
            id: row.id as string,
            organiser_id: row.organiser_id as string,
            patch_id: row.patch_id as string,
            effective_from: row.effective_from as string,
            effective_to: row.effective_to as string | null,
            is_primary: row.is_primary as boolean,
            organiser_name: (profile?.full_name as string) ?? undefined,
            organiser_email: (profile?.email as string) ?? undefined,
          };
        });
        setAssignments(mapped);
        setLoading(false);
      });
  }, [patchId]);

  return { assignments, loading };
}
