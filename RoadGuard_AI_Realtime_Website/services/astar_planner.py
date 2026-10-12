"""
A* Road-Graph Path Planning Engine for RoadGuard AI.
Implements genuine A* graph search over real-world road networks with:
- Geographic coordinates (lat, lng) per node
- Connected directed edges with length, road classification, speed limits, and one-way restrictions
- Priority queue (heapq) graph search with admissible Haversine distance heuristic
- Risk-aware edge cost model:
    cost = travel_time_s * traffic_factor + risk_penalty
    hard closures = infinity (impassable)
    cautious penalties for active hazards / construction / pedestrian risk
- Dynamic hazard replanning: recalculates alternative corridors when hazards intersect current path
- Alternative path discovery with distinct route comparisons (distance, ETA, risk score, hazard count)
"""

import math
import heapq
from typing import Dict, List, Tuple, Optional, Any, Set

EARTH_RADIUS_M = 6371000.0


def haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Computes great-circle distance between two geographic coordinates in meters."""
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2.0) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2.0) ** 2)
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return EARTH_RADIUS_M * c


class RoadGraphNode:
    def __init__(self, node_id: str, lat: float, lng: float, name: str = ""):
        self.node_id = str(node_id)
        self.lat = float(lat)
        self.lng = float(lng)
        self.name = name or str(node_id)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "node_id": self.node_id,
            "lat": self.lat,
            "lng": self.lng,
            "name": self.name
        }


class RoadSegmentEdge:
    def __init__(
        self,
        edge_id: str,
        from_node: str,
        to_node: str,
        road_name: str,
        length_m: float,
        speed_limit_kmh: float = 40.0,
        one_way: bool = False,
        road_type: str = "primary",
        geometry_coords: Optional[List[Tuple[float, float]]] = None
    ):
        self.edge_id = str(edge_id)
        self.from_node = str(from_node)
        self.to_node = str(to_node)
        self.road_name = road_name
        self.length_m = float(length_m)
        self.speed_limit_kmh = max(10.0, float(speed_limit_kmh))
        self.one_way = bool(one_way)
        self.road_type = road_type
        # Intermediate coordinates along road curve [(lat, lng), ...]
        self.geometry_coords = geometry_coords or []

        # Risk and traffic attributes
        self.is_closed = False
        self.hazard_penalty_s = 0.0
        self.traffic_multiplier = 1.0
        self.active_hazards: List[Dict[str, Any]] = []

    @property
    def free_flow_time_s(self) -> float:
        speed_mps = (self.speed_limit_kmh * 1000.0) / 3600.0
        return self.length_m / speed_mps

    def compute_traversal_cost(self) -> float:
        """
        Computes traversability cost. Returns infinity if hard closed.
        Otherwise base travel time * traffic multiplier + hazard penalties.
        """
        if self.is_closed:
            return float("inf")
        base_t = self.free_flow_time_s
        return (base_t * self.traffic_multiplier) + self.hazard_penalty_s


class AStarRoadPlanner:
    """
    Routable road graph planner using Dijkstra / A* with Haversine distance heuristics.
    """

    def __init__(self):
        self.nodes: Dict[str, RoadGraphNode] = {}
        self.edges: Dict[str, RoadSegmentEdge] = {}
        self.adjacency: Dict[str, List[str]] = {}  # node_id -> [edge_id, ...]
        self._build_default_urban_network()

    def clear(self):
        self.nodes.clear()
        self.edges.clear()
        self.adjacency.clear()

    def add_node(self, node_id: str, lat: float, lng: float, name: str = "") -> RoadGraphNode:
        node = RoadGraphNode(node_id, lat, lng, name)
        self.nodes[node.node_id] = node
        self.adjacency.setdefault(node.node_id, [])
        return node

    def add_edge(
        self,
        edge_id: str,
        from_node: str,
        to_node: str,
        road_name: str,
        length_m: Optional[float] = None,
        speed_limit_kmh: float = 40.0,
        one_way: bool = False,
        road_type: str = "primary",
        geometry_coords: Optional[List[Tuple[float, float]]] = None
    ) -> RoadSegmentEdge:
        if from_node not in self.nodes or to_node not in self.nodes:
            raise ValueError(f"Nodes {from_node} and {to_node} must exist before adding edge.")

        if length_m is None:
            n1 = self.nodes[from_node]
            n2 = self.nodes[to_node]
            length_m = haversine_distance_m(n1.lat, n1.lng, n2.lat, n2.lng)

        edge = RoadSegmentEdge(
            edge_id=edge_id,
            from_node=from_node,
            to_node=to_node,
            road_name=road_name,
            length_m=length_m,
            speed_limit_kmh=speed_limit_kmh,
            one_way=one_way,
            road_type=road_type,
            geometry_coords=geometry_coords
        )
        self.edges[edge.edge_id] = edge
        self.adjacency.setdefault(from_node, []).append(edge.edge_id)

        # If bidirectional, add reverse edge if not already exists
        if not one_way:
            rev_edge_id = f"{edge_id}_rev"
            rev_edge = RoadSegmentEdge(
                edge_id=rev_edge_id,
                from_node=to_node,
                to_node=from_node,
                road_name=road_name,
                length_m=length_m,
                speed_limit_kmh=speed_limit_kmh,
                one_way=True,
                road_type=road_type,
                geometry_coords=list(reversed(geometry_coords)) if geometry_coords else None
            )
            self.edges[rev_edge_id] = rev_edge
            self.adjacency.setdefault(to_node, []).append(rev_edge_id)

        return edge

    def find_nearest_node(self, lat: float, lng: float) -> Optional[str]:
        """Finds closest node in graph to given coordinate."""
        if not self.nodes:
            return None
        best_node = None
        min_dist = float("inf")
        for node_id, n in self.nodes.items():
            d = haversine_distance_m(lat, lng, n.lat, n.lng)
            if d < min_dist:
                min_dist = d
                best_node = node_id
        return best_node

    def apply_hazards(self, hazards: List[Dict[str, Any]], distance_threshold_m: float = 65.0):
        """
        Projects hazards onto nearest edges. Hard closures block the edge completely.
        Uncertain / caution hazards apply realistic traversal delays.
        """
        # Reset previous hazard penalties
        for edge in self.edges.values():
            edge.is_closed = False
            edge.hazard_penalty_s = 0.0
            edge.traffic_multiplier = 1.0
            edge.active_hazards = []

        for h in hazards:
            h_lat = float(h.get("lat", 0.0))
            h_lng = float(h.get("lng", 0.0))
            h_type = str(h.get("type", "Obstacle"))
            h_sev = str(h.get("severity", "Medium"))
            is_verified = bool(h.get("verified", True))
            confidence = float(h.get("confidence", 0.8))

            if not h_lat or not h_lng:
                continue

            for edge in self.edges.values():
                n1 = self.nodes.get(edge.from_node)
                n2 = self.nodes.get(edge.to_node)
                if not n1 or not n2:
                    continue

                pts = [(n1.lat, n1.lng)] + (edge.geometry_coords or []) + [(n2.lat, n2.lng)]
                touches = False
                for i in range(len(pts) - 1):
                    pA = pts[i]
                    pB = pts[i + 1]
                    # Midpoint approximation for segment
                    mid_lat = (pA[0] + pB[0]) / 2.0
                    mid_lng = (pA[1] + pB[1]) / 2.0
                    if haversine_distance_m(h_lat, h_lng, mid_lat, mid_lng) <= distance_threshold_m:
                        touches = True
                        break

                if touches:
                    edge.active_hazards.append(h)
                    # Hard blockage check
                    if h_type in ["Road Blocked", "Road closure", "Barricade"] and h_sev.lower() in ["critical", "high"]:
                        edge.is_closed = True
                    elif h_type in ["Construction Working", "Construction"]:
                        # Substantial delay penalty
                        penalty = 180.0 if is_verified else 60.0
                        edge.hazard_penalty_s += penalty * confidence
                        edge.traffic_multiplier = max(edge.traffic_multiplier, 1.8)
                    elif h_type in ["Pedestrian Moving", "Pedestrian", "Animal Crossing"]:
                        # Yield slowdown delay
                        edge.hazard_penalty_s += 45.0 * confidence
                        edge.traffic_multiplier = max(edge.traffic_multiplier, 1.4)
                    else:
                        # Pothole or general obstacle
                        edge.hazard_penalty_s += 25.0 * confidence

    def heuristic(self, current_node: str, goal_node: str, max_speed_kmh: float = 60.0) -> float:
        """
        Admissible Haversine heuristic estimating minimum travel time (seconds)
        to goal assuming vehicle can travel at maximum road speed.
        """
        n1 = self.nodes[current_node]
        n2 = self.nodes[goal_node]
        dist_m = haversine_distance_m(n1.lat, n1.lng, n2.lat, n2.lng)
        max_speed_mps = (max_speed_kmh * 1000.0) / 3600.0
        return dist_m / max_speed_mps

    def plan_path(
        self,
        start_node: str,
        goal_node: str,
        banned_edges: Optional[Set[str]] = None
    ) -> Dict[str, Any]:
        """
        A* path search from start_node to goal_node.
        Returns detailed route geometry, distance, ETA, and traversal statistics.
        """
        if start_node not in self.nodes or goal_node not in self.nodes:
            return {
                "ok": False,
                "error": f"Invalid start ({start_node}) or goal ({goal_node}) node.",
                "path": []
            }

        if start_node == goal_node:
            n = self.nodes[start_node]
            return {
                "ok": True,
                "distance_km": 0.0,
                "duration_min": 0.0,
                "path_nodes": [start_node],
                "edge_ids": [],
                "coordinates": [(n.lat, n.lng)],
                "geometry_geojson": {"type": "LineString", "coordinates": [[n.lng, n.lat]]},
                "hazard_count": 0,
                "risk_score": 0.0,
                "engine": "A* Road-Graph Search"
            }

        banned_edges = banned_edges or set()

        # Priority queue stores tuples of (f_score, counter, current_node)
        pq: List[Tuple[float, int, str]] = []
        counter = 0

        g_score: Dict[str, float] = {node_id: float("inf") for node_id in self.nodes}
        g_score[start_node] = 0.0

        f_score: Dict[str, float] = {node_id: float("inf") for node_id in self.nodes}
        f_score[start_node] = self.heuristic(start_node, goal_node)

        heapq.heappush(pq, (f_score[start_node], counter, start_node))

        came_from: Dict[str, Tuple[str, str]] = {}  # node -> (parent_node, edge_id)
        visited: Set[str] = set()

        while pq:
            current_f, _, current = heapq.heappop(pq)

            if current == goal_node:
                return self._reconstruct_path(start_node, goal_node, came_from)

            if current in visited:
                continue
            visited.add(current)

            for edge_id in self.adjacency.get(current, []):
                if edge_id in banned_edges:
                    continue

                edge = self.edges.get(edge_id)
                if not edge or edge.is_closed:
                    continue

                neighbor = edge.to_node
                if neighbor in visited:
                    continue

                traversal_cost = edge.compute_traversal_cost()
                if math.isinf(traversal_cost):
                    continue

                tentative_g = g_score[current] + traversal_cost

                if tentative_g < g_score[neighbor]:
                    came_from[neighbor] = (current, edge_id)
                    g_score[neighbor] = tentative_g
                    f_val = tentative_g + self.heuristic(neighbor, goal_node)
                    f_score[neighbor] = f_val
                    counter += 1
                    heapq.heappush(pq, (f_val, counter, neighbor))

        # No path found
        return {
            "ok": False,
            "error": "No viable path found between nodes. All corridors may be closed or graph disconnected.",
            "path_nodes": [],
            "edge_ids": [],
            "distance_km": 0.0,
            "duration_min": 0.0,
            "is_blocked": True
        }

    def _reconstruct_path(
        self,
        start_node: str,
        goal_node: str,
        came_from: Dict[str, Tuple[str, str]]
    ) -> Dict[str, Any]:
        path_nodes = [goal_node]
        edge_ids = []
        curr = goal_node

        while curr in came_from:
            parent, edge_id = came_from[curr]
            edge_ids.append(edge_id)
            path_nodes.append(parent)
            curr = parent

        path_nodes.reverse()
        edge_ids.reverse()

        total_distance_m = 0.0
        total_time_s = 0.0
        total_risk_score = 0.0
        hazards_on_path: List[Dict[str, Any]] = []
        full_coords: List[Tuple[float, float]] = []

        for e_id in edge_ids:
            edge = self.edges[e_id]
            total_distance_m += edge.length_m
            total_time_s += edge.compute_traversal_cost()
            if edge.active_hazards:
                hazards_on_path.extend(edge.active_hazards)
                total_risk_score += (edge.hazard_penalty_s / 10.0)

            n_from = self.nodes[edge.from_node]
            n_to = self.nodes[edge.to_node]

            if not full_coords:
                full_coords.append((n_from.lat, n_from.lng))

            if edge.geometry_coords:
                full_coords.extend(edge.geometry_coords)
            full_coords.append((n_to.lat, n_to.lng))

        geojson_coords = [[lng, lat] for lat, lng in full_coords]

        return {
            "ok": True,
            "path_nodes": path_nodes,
            "edge_ids": edge_ids,
            "distance_km": round(total_distance_m / 1000.0, 2),
            "duration_min": round(total_time_s / 60.0, 1),
            "coordinates": full_coords,
            "geometry_geojson": {
                "type": "LineString",
                "coordinates": geojson_coords
            },
            "hazard_count": len(hazards_on_path),
            "hazards": hazards_on_path,
            "risk_score": round(total_risk_score, 1),
            "engine": "A* Road-Graph Engine"
        }

    def plan_alternatives(
        self,
        start_node: str,
        goal_node: str,
        k: int = 3
    ) -> List[Dict[str, Any]]:
        """
        Finds up to k distinct alternative routes by selectively penalizing/banning
        bottleneck edges from prior shortest paths.
        """
        routes: List[Dict[str, Any]] = []
        banned: Set[str] = set()

        primary = self.plan_path(start_node, goal_node, banned_edges=banned)
        if not primary.get("ok"):
            return routes

        primary["id"] = 1
        primary["name"] = "Route 1: A* Optimal Path"
        primary["is_recommended"] = True
        routes.append(primary)

        # Generate K alternatives by penalizing edges of previously found paths
        for alt_idx in range(2, k + 1):
            if not primary.get("edge_ids"):
                break

            # Ban a critical intermediate edge from the primary or previous route
            edge_to_ban = None
            for e_id in reversed(primary["edge_ids"]):
                if e_id not in banned and self.edges[e_id].length_m > 150:
                    edge_to_ban = e_id
                    break

            if not edge_to_ban:
                break

            banned.add(edge_to_ban)
            alt = self.plan_path(start_node, goal_node, banned_edges=banned)
            if alt.get("ok"):
                # Ensure distinctly different path
                diff = abs(alt["distance_km"] - primary["distance_km"])
                if diff > 0.05 or alt["path_nodes"] != primary["path_nodes"]:
                    alt["id"] = alt_idx
                    alt["name"] = f"Route {alt_idx}: A* Risk-Aware Alternative"
                    alt["is_recommended"] = False
                    routes.append(alt)

        return routes

    def _build_default_urban_network(self):
        """
        Constructs a realistic, routable urban arterial network (Coimbatore Road Network)
        with connected nodes, intersections, one-way streets, ring road bypasses, and express corridors.
        """
        # Key Nodes
        nodes_def = [
            ("railway_stn", 10.9979, 76.9634, "Coimbatore Railway Station Junction"),
            ("collectorate", 11.0020, 76.9645, "District Collectorate Circle"),
            ("gandhipuram", 11.0183, 76.9644, "Gandhipuram Central Crossway"),
            ("crosscut", 11.0210, 76.9610, "Cross Cut Commercial Arterial"),
            ("rs_puram", 11.0090, 76.9510, "RS Puram West Hub"),
            ("thadagam_rd", 11.0145, 76.9420, "Thadagam Link Road"),
            ("race_course", 11.0040, 76.9730, "Race Course Promenade Ring"),
            ("avinashi_rd_hub", 11.0140, 76.9850, "Avinashi Road Arterial Corridor"),
            ("peelamedu", 11.0287, 77.0028, "Peelamedu Tech Hub"),
            ("singanallur", 10.9980, 77.0220, "Singanallur Junction"),
            ("saravanampatti", 11.0797, 76.9997, "Saravanampatti IT Corridor"),
            ("100_feet_rd", 11.0235, 76.9710, "100 Feet Arterial Express Road"),
            ("ring_road_east", 11.0190, 77.0150, "Eastern Ring Road Bypass")
        ]

        for nid, lat, lng, name in nodes_def:
            self.add_node(nid, lat, lng, name)

        # Primary Corridor 1: Railway Station -> Collectorate -> Gandhipuram (North-South Arterial)
        self.add_edge("e1_rail_coll", "railway_stn", "collectorate", "State Bank Road", speed_limit_kmh=45.0)
        self.add_edge("e2_coll_gandhi", "collectorate", "gandhipuram", "Dr. Nanjappa Road", speed_limit_kmh=45.0)

        # Corridor 2: West Bypass via RS Puram & Thadagam
        self.add_edge("e3_rail_rspuram", "railway_stn", "rs_puram", "Brooke Bond Road", speed_limit_kmh=40.0)
        self.add_edge("e4_rspuram_thadagam", "rs_puram", "thadagam_rd", "DB Road", speed_limit_kmh=40.0)
        self.add_edge("e5_thadagam_crosscut", "thadagam_rd", "crosscut", "100 Feet Link West", speed_limit_kmh=45.0)
        self.add_edge("e6_crosscut_gandhi", "crosscut", "gandhipuram", "Cross Cut Road", speed_limit_kmh=35.0, one_way=True) # One-way street!

        # Corridor 3: East Promenade & Avinashi Road Express
        self.add_edge("e7_coll_racecourse", "collectorate", "race_course", "Government Arts College Road", speed_limit_kmh=40.0)
        self.add_edge("e8_racecourse_avinashi", "race_course", "avinashi_rd_hub", "Old Post Office Road", speed_limit_kmh=50.0)
        self.add_edge("e9_gandhi_avinashi", "gandhipuram", "avinashi_rd_hub", "Avinashi Flyover Link", speed_limit_kmh=55.0)

        # Corridor 4: Gandhipuram -> 100 Feet Road -> Peelamedu -> Eastern Bypass
        self.add_edge("e10_gandhi_100ft", "gandhipuram", "100_feet_rd", "Sathy Road / 100 Ft Jn", speed_limit_kmh=45.0)
        self.add_edge("e11_100ft_peelamedu", "100_feet_rd", "peelamedu", "Bharathi Colony Link", speed_limit_kmh=50.0)
        self.add_edge("e12_avinashi_peelamedu", "avinashi_rd_hub", "peelamedu", "Avinashi Expressway NH-544", speed_limit_kmh=65.0)

        # Corridor 5: Ring Road Bypass to Singanallur & Tech Corridor
        self.add_edge("e13_peelamedu_ring", "peelamedu", "ring_road_east", "Hope College Bypass", speed_limit_kmh=60.0)
        self.add_edge("e14_ring_singanallur", "ring_road_east", "singanallur", "Trichy Road Bypass", speed_limit_kmh=55.0)
        self.add_edge("e15_peelamedu_saravanampatti", "peelamedu", "saravanampatti", "Tidel Park Express Arterial", speed_limit_kmh=55.0)


# Global singleton instance
astar_planner = AStarRoadPlanner()
