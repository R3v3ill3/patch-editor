'use client';

import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import maplibregl from 'maplibre-gl';
import type { PatchFeatureCollection, OverlapWarning } from '@/types';

const SYDNEY_CENTER: [number, number] = [151.21, -33.87];
const DEFAULT_ZOOM = 10;

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    'osm-tiles': {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    {
      id: 'osm-tiles',
      type: 'raster',
      source: 'osm-tiles',
    },
  ],
};

export interface MapViewHandle {
  getMap: () => maplibregl.Map | null;
  flyToPatch: (patchId: string) => void;
}

interface SimplifyOverlay {
  original: GeoJSON.Feature | null;
  simplified: GeoJSON.Feature | null;
}

interface MapViewProps {
  featureCollection: PatchFeatureCollection;
  selectedPatchId: string | null;
  overlaps: OverlapWarning[];
  editingPatchId: string | null;
  simplifyOverlay?: SimplifyOverlay | null;
  gapPreview?: GeoJSON.Feature | null;
  onPatchClick: (patchId: string) => void;
  onMapReady?: (map: maplibregl.Map) => void;
}

const MapView = forwardRef<MapViewHandle, MapViewProps>(function MapView(
  { featureCollection, selectedPatchId, overlaps, editingPatchId, simplifyOverlay, gapPreview, onPatchClick, onMapReady },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const mapReady = useRef(false);

  // Expose map ref and fly-to
  useImperativeHandle(ref, () => ({
    getMap: () => mapRef.current,
    flyToPatch: (patchId: string) => {
      const map = mapRef.current;
      if (!map || !mapReady.current) return;

      // Don't fly during editing -- it disrupts the user's view
      if (editingPatchId) return;

      const feature = featureCollection.features.find(f => f.properties.id === patchId);
      if (!feature) return;

      // Calculate bounds from the feature geometry
      const bounds = new maplibregl.LngLatBounds();
      const geom = feature.geometry;

      function addCoords(coords: number[][]) {
        coords.forEach(c => bounds.extend([c[0], c[1]] as [number, number]));
      }

      if (geom.type === 'Polygon') {
        geom.coordinates.forEach(ring => addCoords(ring));
      } else if (geom.type === 'MultiPolygon') {
        geom.coordinates.forEach(polygon => polygon.forEach(ring => addCoords(ring)));
      }

      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 1000 });
      }
    },
  }), [featureCollection, editingPatchId]);

  // Initialize map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: SYDNEY_CENTER,
      zoom: DEFAULT_ZOOM,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
      mapReady.current = true;

      // Patches source
      map.addSource('patches', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // Fill layer
      map.addLayer({
        id: 'patches-fill',
        type: 'fill',
        source: 'patches',
        paint: {
          'fill-color': ['get', 'fillColor'],
          'fill-opacity': 0.4,
        },
      });

      // Outline layer
      map.addLayer({
        id: 'patches-outline',
        type: 'line',
        source: 'patches',
        paint: {
          'line-color': '#1f2937', // Darker gray for better visibility
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            5,
            2.5,
          ],
          'line-opacity': 0.9,
        },
      });

      // Selected highlight layer
      map.addLayer({
        id: 'patches-selected',
        type: 'line',
        source: 'patches',
        paint: {
          'line-color': '#3b82f6', // Bright blue for high contrast
          'line-width': 7,
          'line-opacity': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            0.95,
            0,
          ],
        },
      });

      // Overlap visualization source + layer
      map.addSource('overlaps', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'overlaps-fill',
        type: 'fill',
        source: 'overlaps',
        paint: {
          'fill-color': '#ef4444',
          'fill-opacity': 0.5,
        },
      });

      map.addLayer({
        id: 'overlaps-outline',
        type: 'line',
        source: 'overlaps',
        paint: {
          'line-color': '#dc2626',
          'line-width': 2,
          'line-dasharray': [3, 2],
        },
      });

      // Simplify overlay layers
      map.addSource('simplify-original', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'simplify-original-line',
        type: 'line',
        source: 'simplify-original',
        paint: {
          'line-color': '#6b7280',
          'line-width': 2,
          'line-dasharray': [4, 3],
          'line-opacity': 0.7,
        },
      });

      map.addSource('simplify-preview', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'simplify-preview-line',
        type: 'line',
        source: 'simplify-preview',
        paint: {
          'line-color': '#2563eb',
          'line-width': 3,
          'line-opacity': 0.9,
        },
      });

      map.addLayer({
        id: 'simplify-preview-vertices',
        type: 'circle',
        source: 'simplify-preview',
        paint: {
          'circle-radius': 4,
          'circle-color': '#2563eb',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
        },
        filter: ['==', '$type', 'Point'],
      });

      // Gap preview layers
      map.addSource('gap-preview', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'gap-preview-fill',
        type: 'fill',
        source: 'gap-preview',
        paint: {
          'fill-color': '#f59e0b',
          'fill-opacity': 0.3,
        },
      });

      map.addLayer({
        id: 'gap-preview-outline',
        type: 'line',
        source: 'gap-preview',
        paint: {
          'line-color': '#d97706',
          'line-width': 2,
          'line-dasharray': [4, 3],
        },
      });

      // Click handler for patches
      map.on('click', 'patches-fill', (e) => {
        if (e.features && e.features.length > 0) {
          const id = e.features[0].properties?.id;
          if (id) onPatchClick(id);
        }
      });

      // Cursor change on hover
      map.on('mouseenter', 'patches-fill', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'patches-fill', () => {
        map.getCanvas().style.cursor = '';
      });

      // Notify parent that map is ready
      console.log('MapView: map loaded, calling onMapReady');
      onMapReady?.(map);
    });

    mapRef.current = map;

    return () => {
      mapReady.current = false;
      map.remove();
      mapRef.current = null;
    };
  // onPatchClick is stable from parent via useCallback
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update patches data
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady.current) return;

    const source = map.getSource('patches') as maplibregl.GeoJSONSource | undefined;
    if (!source) return;

    // Filter out the currently-being-edited patch (terra-draw handles its display)
    const filtered = {
      ...featureCollection,
      features: featureCollection.features.filter(
        f => f.properties.id !== editingPatchId
      ),
    };

    source.setData(filtered as GeoJSON.FeatureCollection);
  }, [featureCollection, editingPatchId]);

  // Update overlap visualization
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady.current) return;

    const source = map.getSource('overlaps') as maplibregl.GeoJSONSource | undefined;
    if (!source) return;

    source.setData({
      type: 'FeatureCollection',
      features: overlaps.map(o => o.overlapGeometry),
    } as GeoJSON.FeatureCollection);
  }, [overlaps]);

  // Update simplify overlay
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady.current) return;

    const origSource = map.getSource('simplify-original') as maplibregl.GeoJSONSource | undefined;
    const prevSource = map.getSource('simplify-preview') as maplibregl.GeoJSONSource | undefined;
    if (!origSource || !prevSource) return;

    if (simplifyOverlay?.original) {
      origSource.setData({
        type: 'FeatureCollection',
        features: [simplifyOverlay.original],
      } as GeoJSON.FeatureCollection);
    } else {
      origSource.setData({ type: 'FeatureCollection', features: [] });
    }

    if (simplifyOverlay?.simplified) {
      prevSource.setData({
        type: 'FeatureCollection',
        features: [simplifyOverlay.simplified],
      } as GeoJSON.FeatureCollection);
    } else {
      prevSource.setData({ type: 'FeatureCollection', features: [] });
    }
  }, [simplifyOverlay]);

  // Update gap preview
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady.current) return;

    const source = map.getSource('gap-preview') as maplibregl.GeoJSONSource | undefined;
    if (!source) return;

    if (gapPreview) {
      source.setData({
        type: 'FeatureCollection',
        features: [gapPreview],
      } as GeoJSON.FeatureCollection);
    } else {
      source.setData({ type: 'FeatureCollection', features: [] });
    }
  }, [gapPreview]);

  // Update selected state
  const prevSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady.current) return;

    // Clear previous selection
    if (prevSelectedRef.current) {
      map.setFeatureState(
        { source: 'patches', id: prevSelectedRef.current },
        { selected: false }
      );
    }

    // Set new selection
    if (selectedPatchId) {
      map.setFeatureState(
        { source: 'patches', id: selectedPatchId },
        { selected: true }
      );
    }

    prevSelectedRef.current = selectedPatchId;
  }, [selectedPatchId]);

  // Update click handler when onPatchClick changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady.current) return;

    const handler = (e: maplibregl.MapLayerMouseEvent) => {
      if (e.features && e.features.length > 0) {
        const id = e.features[0].properties?.id;
        if (id) onPatchClick(id);
      }
    };

    map.off('click', 'patches-fill', handler);
    map.on('click', 'patches-fill', handler);
  }, [onPatchClick]);

  return (
    <div ref={containerRef} className="w-full h-full" />
  );
});

export default MapView;
