import type { Geometry, MultiPolygon, Polygon, Position } from 'geojson';

/**
 * Convert a GeoJSON geometry (Polygon or MultiPolygon) to WKT MULTIPOLYGON string.
 * All geometries are normalized to MultiPolygon for database consistency.
 */
export function convertGeoJSONToWKT(geometry: Geometry): string {
  if (geometry.type === 'Polygon') {
    const rings = (geometry as Polygon).coordinates;
    const wktRings = rings.map(ring => {
      const points = ring.map(c => `${c[0]} ${c[1]}`).join(', ');
      return `(${points})`;
    }).join(', ');
    return `MULTIPOLYGON((${wktRings}))`;
  }

  if (geometry.type === 'MultiPolygon') {
    const polygons = (geometry as MultiPolygon).coordinates.map(polygon => {
      const rings = polygon.map(ring => {
        const points = ring.map(c => `${c[0]} ${c[1]}`).join(', ');
        return `(${points})`;
      }).join(', ');
      return `(${rings})`;
    }).join(', ');
    return `MULTIPOLYGON(${polygons})`;
  }

  throw new Error(`Unsupported geometry type: ${geometry.type}`);
}

/**
 * Ensure a Polygon geometry is wrapped as MultiPolygon.
 */
export function ensureMultiPolygon(geometry: Geometry): MultiPolygon {
  if (geometry.type === 'MultiPolygon') {
    return geometry as MultiPolygon;
  }
  if (geometry.type === 'Polygon') {
    return {
      type: 'MultiPolygon',
      coordinates: [(geometry as Polygon).coordinates],
    };
  }
  throw new Error(`Cannot convert ${geometry.type} to MultiPolygon`);
}

/**
 * Ensure a polygon ring is closed (first point equals last point).
 */
export function ensureClosedRing(ring: Position[]): Position[] {
  if (ring.length < 2) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return [...ring, first];
  }
  return ring;
}
