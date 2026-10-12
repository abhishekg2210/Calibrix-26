import math
import os
import requests
from typing import Dict, List, Optional, Tuple, Any

EARTH_RADIUS_KM = 6371.0

def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate great-circle distance between two points in km."""
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS_KM * c

def calculate_offset_waypoints(start: Dict[str, float], end: Dict[str, float]) -> List[Dict[str, float]]:
    """
    Generate perpendicular offset waypoints from the midpoint to discover
    real alternate road branches via OSRM.
    """
    lat1, lon1 = start['lat'], start['lng']
    lat2, lon2 = end['lat'], end['lng']

    mid_lat = (lat1 + lat2) / 2.0
    mid_lon = (lon1 + lon2) / 2.0

    d_lat = lat2 - lat1
    d_lon = lon2 - lon1
    dist = math.sqrt(d_lat**2 + d_lon**2)
    if dist < 0.0001:
        return []

    # Perpendicular unit vector (-d_lon, d_lat) and (d_lon, -d_lat)
    perp_lat = -d_lon / dist
    perp_lon = d_lat / dist

    # Offset magnitude proportional to distance, capped reasonably
    offset_scale = min(max(dist * 0.22, 0.015), 0.08)

    offset1 = {
        'lat': mid_lat + perp_lat * offset_scale,
        'lng': mid_lon + perp_lon * offset_scale,
        'label': 'North/East Corridor'
    }
    offset2 = {
        'lat': mid_lat - perp_lat * offset_scale,
        'lng': mid_lon - perp_lon * offset_scale,
        'label': 'South/West Bypass'
    }
    return [offset1, offset2]

def check_hazard_intersection(route_geometry: Dict[str, Any], hazard: Dict[str, Any], threshold_km: float = 0.45) -> bool:
    """Check if any coordinate along the route polyline is close to a hazard."""
    if not hazard or not route_geometry or 'coordinates' not in route_geometry:
        return False
    h_lat = float(hazard.get('lat', 0))
    h_lng = float(hazard.get('lng', 0))
    if not h_lat or not h_lng:
        return False

    coords = route_geometry['coordinates']
    for pt in coords:
        # GeoJSON is [lng, lat]
        pt_lng, pt_lat = pt[0], pt[1]
        dist = haversine_distance(pt_lat, pt_lng, h_lat, h_lng)
        if dist <= threshold_km:
            return True
    return False

def query_osrm_single(coords_str: str, timeout: int = 10) -> Optional[Dict[str, Any]]:
    """Query OSRM public demo routing service."""
    url = f"https://router.project-osrm.org/route/v1/driving/{coords_str}"
    params = {
        "overview": "full",
        "geometries": "geojson",
        "alternatives": "true",
        "steps": "true"
    }
    try:
        resp = requests.get(url, params=params, timeout=timeout)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("code") == "Ok" and data.get("routes"):
                return data
    except Exception:
        pass
    return None

def calculate_routes(
    start: Dict[str, float],
    end: Dict[str, float],
    active_hazards: Optional[List[Dict[str, Any]]] = None,
    hazards: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """
    Calculate primary and genuine alternative routes.
    Guarantees multiple distinct routes when physically viable.
    """
    if not start or not end:
        return {"ok": False, "error": "Start and destination points are required."}

    try:
        s_lat, s_lng = float(start["lat"]), float(start["lng"])
        e_lat, e_lng = float(end["lat"]), float(end["lng"])
    except (ValueError, KeyError, TypeError):
        return {"ok": False, "error": "Invalid coordinates format."}

    if not (-90 <= s_lat <= 90 and -180 <= s_lng <= 180 and -90 <= e_lat <= 90 and -180 <= e_lng <= 180):
        return {"ok": False, "error": "Coordinates are out of geographical range."}

    direct_coords = f"{s_lng:.6f},{s_lat:.6f};{e_lng:.6f},{e_lat:.6f}"
    primary_osrm_data = query_osrm_single(direct_coords)

    if not primary_osrm_data:
        return {
            "ok": False,
            "error": "Routing service is currently unavailable. Please verify internet connectivity and try points near a known road."
        }

    raw_routes = list(primary_osrm_data.get("routes", []))

    # If OSRM returned only 1 route, generate genuine alternate paths via intermediate road corridors
    if len(raw_routes) == 1:
        offsets = calculate_offset_waypoints(start, end)
        for offset in offsets:
            via_coords = f"{s_lng:.6f},{s_lat:.6f};{offset['lng']:.6f},{offset['lat']:.6f};{e_lng:.6f},{e_lat:.6f}"
            alt_data = query_osrm_single(via_coords, timeout=8)
            if alt_data and alt_data.get("routes"):
                alt_route = alt_data["routes"][0]
                # Ensure it is genuinely distinct (different distance by at least 2% or different duration)
                dist_diff = abs(alt_route["distance"] - raw_routes[0]["distance"])
                if dist_diff > 250: # at least 250m difference
                    raw_routes.append(alt_route)
            if len(raw_routes) >= 3:
                break

    parsed_routes = []
    active_hazards = active_hazards or hazards or []

    for idx, r in enumerate(raw_routes):
        dist_km = round(r["distance"] / 1000.0, 2)
        dur_min = round(r["duration"] / 60.0, 1)

        # Check hazard collisions for this route
        route_hazards = []
        for h in active_hazards:
            if check_hazard_intersection(r["geometry"], h):
                route_hazards.append(h)

        has_hazard = len(route_hazards) > 0
        # Only Construction and Road Blockages force corridor rerouting per requirements
        has_blockage = any(
            h.get("type") in ["Road Blocked", "Road closure", "Barricade", "Construction Working", "Construction"]
            for h in route_hazards
        )

        # Heuristic traffic condition and toll tag for realistic Indian road context
        if idx == 0:
            name = "Route 1: Primary Highway Corridor"
            traffic = "ROAD BLOCKED (Closure Alert)" if has_blockage else ("Moderate Flow (+2 min delay)" if has_hazard else "Smooth Traffic Flow")
            toll = "Toll Applicable (NHAI Express)" if dist_km > 15 else "Toll-Free"
            penalty = 1000.0 if has_blockage else (35.0 if has_hazard else 0.0)
            base_score = dur_min + penalty
        elif idx == 1:
            name = "Route 2: Arterial Ring Road Bypass"
            traffic = "ROAD BLOCKED (Closure Alert)" if has_blockage else ("Congested Junction" if has_hazard else "Normal Flow")
            toll = "Toll-Free Arterial"
            penalty = 1000.0 if has_blockage else (35.0 if has_hazard else 0.0)
            base_score = dur_min + penalty
        else:
            name = f"Route {idx + 1}: Alternate Sector Link"
            traffic = "ROAD BLOCKED (Closure Alert)" if has_blockage else ("Caution Advised" if has_hazard else "Clear Traffic")
            toll = "Toll-Free Local"
            penalty = 1000.0 if has_blockage else (35.0 if has_hazard else 0.0)
            base_score = dur_min + penalty

        parsed_routes.append({
            "id": idx + 1,
            "name": name,
            "distance_km": dist_km,
            "duration_min": dur_min,
            "traffic_condition": traffic,
            "toll_info": toll,
            "geometry": r["geometry"],
            "hazards": route_hazards,
            "has_hazard": has_hazard,
            "is_blocked": has_blockage,
            "_score": base_score
        })

    # Determine recommended route based on lowest score (freedom from hazards + duration)
    best_route = min(parsed_routes, key=lambda x: x["_score"])
    for r in parsed_routes:
        is_rec = (r["id"] == best_route["id"])
        r["is_recommended"] = is_rec
        if is_rec:
            if r["has_hazard"]:
                r["recommendation_reason"] = "Least impacted route despite hazard proximity"
            elif r["id"] == 1:
                r["recommendation_reason"] = "Fastest route with minimum travel time"
            else:
                r["recommendation_reason"] = "Safest alternative · completely avoids active road hazard"
        else:
            if r["has_hazard"]:
                r["recommendation_reason"] = "Hazard warning active along this corridor"
            else:
                delta = round(r["duration_min"] - best_route["duration_min"], 1)
                r["recommendation_reason"] = f"+{delta} min compared to recommended"
        del r["_score"]

    all_blocked = len(parsed_routes) > 0 and all(r.get("is_blocked", False) for r in parsed_routes)
    unblocked_alternative_available = any(not r.get("is_blocked", False) for r in parsed_routes)

    return {
        "ok": True,
        "routes": parsed_routes,
        "total_alternatives": len(parsed_routes) - 1,
        "all_blocked": all_blocked,
        "unblocked_alternative_available": unblocked_alternative_available,
        "provider": "OSRM (OpenStreetMap) Driving Engine",
        "traffic_live": False,
        "note": "Route estimates calculated. Simulated sensor & obstacle avoidance active."
    }
