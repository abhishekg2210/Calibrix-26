(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  // Local landmark coordinates dictionary for instant, reliable geocoding
  const LANDMARKS = {
    'coimbatore': { lat: 11.016844, lng: 76.955833 },
    'coimbatore, tamil nadu': { lat: 11.016844, lng: 76.955833 },
    'coimbatore railway station': { lat: 10.9979, lng: 76.9634 },
    'railway station': { lat: 10.9979, lng: 76.9634 },
    'gandhipuram': { lat: 11.0183, lng: 76.9644 },
    'rs puram': { lat: 11.0090, lng: 76.9510 },
    'peelamedu': { lat: 11.0287, lng: 77.0028 },
    'coimbatore airport': { lat: 11.0300, lng: 77.0434 },
    'airport': { lat: 11.0300, lng: 77.0434 },
    'ukkadam': { lat: 10.9880, lng: 76.9600 },
    'sulur': { lat: 11.0250, lng: 76.9800 },
    'saravanampatti': { lat: 11.0797, lng: 76.9997 },
    'singanallur': { lat: 10.9980, lng: 77.0220 },
    'bangalore': { lat: 12.9716, lng: 77.5946 },
    'chennai': { lat: 13.0827, lng: 80.2707 }
  };

  const state = {
    engine: 'leaflet',
    map: null,
    tiles: null,
    currentTileStyle: 'dark', // 'dark', 'light'
    start: null,
    end: null,
    startMarker: null,
    endMarker: null,
    routes: [],
    selected: 0,
    routeLayers: [],
    blockedSegmentLayer: null, // Red dashed layer for avoided/obstructed road section
    hazardMarkers: {},         // id -> { marker, circle, animTimer, data }
    hazards: [],
    currentPosition: null,
    watchId: null,
    follow: false,
    traffic: false,
    demoTimer: null,
    demoIndex: 0,
    activeDemoCoords: [],
    vehicleMarker: null,
    pendingRoute: null,
    telemetry: null,
    placementMode: null,       // 'Obstacle' | 'Pedestrian Moving' | 'Construction Working' | 'Road Blocked'
    selectedToolType: 'Obstacle'
  };

  const ROUTE_COLORS = ['#00e59b', '#4ca9ff', '#b58aff', '#ffb84d'];

  function log(title, detail = '', tone = 'green') {
    const el = $('eventLog');
    if (!el) return;
    const item = document.createElement('div');
    item.className = 'event';
    item.innerHTML = `<span class="event-dot ${tone}"></span><div><b></b><small></small><time>${new Date().toLocaleTimeString()}</time></div>`;
    item.querySelector('b').textContent = title;
    item.querySelector('small').textContent = detail;
    el.prepend(item);
    while (el.children.length > 40) el.lastChild.remove();
  }

  function toast(message) {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.remove('show'), 3800);
  }

  async function api(url, body) {
    const opts = body ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    } : {};
    const res = await fetch(url, opts);
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function setStatus(text) {
    const el = $('systemStatus');
    if (el) el.textContent = text.toUpperCase();
  }

  function haversine(a, b) {
    if (!a || !b) return Infinity;
    const R = 6371;
    const lat1 = a.lat !== undefined ? a.lat : a[1];
    const lon1 = a.lng !== undefined ? a.lng : a[0];
    const lat2 = b.lat !== undefined ? b.lat : b[1];
    const lon2 = b.lng !== undefined ? b.lng : b[0];
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const x = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function decodePolyline(encoded) {
    let index = 0, lat = 0, lng = 0, coords = [];
    while (index < encoded.length) {
      let b, shift = 0, result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlat = result & 1 ? ~(result >> 1) : result >> 1;
      lat += dlat;
      shift = 0;
      result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlng = result & 1 ? ~(result >> 1) : result >> 1;
      lng += dlng;
      coords.push([lng / 1e5, lat / 1e5]);
    }
    return coords;
  }

  function routeCoords(r) {
    if (!r) return [];
    if (r.coords && r.coords.length) return r.coords.map(c => ({ lat: c.lat, lng: c.lng }));
    if (r.geometry?.coordinates) return r.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
    if (r.encoded_polyline) return decodePolyline(r.encoded_polyline).map(c => ({ lat: c[1], lng: c[0] }));
    return [];
  }

  // --------------------------------------------------------------------------
  // LEAFLET MAP INITIALIZATION & THEMES
  // --------------------------------------------------------------------------
  function initLeaflet() {
    state.engine = 'leaflet';

    // Initialize map
    state.map = L.map('map', {
      zoomControl: true,
      attributionControl: true
    }).setView([11.016844, 76.955833], 13);

    // Default CartoDB Dark Matter tile layer
    state.tiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors © CARTO'
    }).addTo(state.map);

    $('mapProvider').textContent = 'LEAFLET ACTIVE (CARTO/OSM)';
    $('mapDataBadge').textContent = 'ENGINE: LEAFLET (OPENSTREETMAP / CARTO)';
    $('apiStatus').textContent = 'OSRM & LEAFLET ENGINE ACTIVE';
    $('apiStatusSub').textContent = 'Multi-corridor real-time simulation ready.';

    // Map Click Handler (Entity Placement or Origin/Destination selection)
    state.map.on('click', handleMapClick);

    // Keyboard shortcut ESC to cancel placement
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && state.placementMode) {
        cancelPlacementMode();
        toast('Placement mode cancelled.');
      }
    });

    log('Leaflet Engine Ready', 'High-performance interactive map cockpit loaded.', 'green');
  }

  function toggleMapTheme() {
    if (!state.map) return;
    if (state.currentTileStyle === 'dark') {
      state.map.removeLayer(state.tiles);
      state.tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
      }).addTo(state.map);
      state.currentTileStyle = 'light';
      toast('Map style: OpenStreetMap Standard');
      log('Map theme changed', 'OpenStreetMap Standard tiles active.');
    } else {
      state.map.removeLayer(state.tiles);
      state.tiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors © CARTO'
      }).addTo(state.map);
      state.currentTileStyle = 'dark';
      toast('Map style: CartoDB Dark Cockpit');
      log('Map theme changed', 'CartoDB Dark Cockpit tiles active.');
    }
  }

  // --------------------------------------------------------------------------
  // CURRENT LOCATION DETECTION ON STARTUP
  // --------------------------------------------------------------------------
  function setFallbackOrigin(resolve) {
    state.start = { lat: 11.016844, lng: 76.955833 };
    state.currentPosition = { lat: 11.016844, lng: 76.955833 };
    $('originInput').value = '📍 Current Location (Coimbatore GPS)';
    $('originInput').title = 'GPS Origin: 11.01684, 76.95583';
    updateEndpointMarker('start', state.start.lat, state.start.lng, true);
    updateVehicleMarker(state.start.lat, state.start.lng);
    toast('📍 Starting point set: Current Location.');
    log('Starting point ready', 'Origin set to Current Location (11.01684, 76.95583).', 'green');
    calculateRoutes().then(resolve);
  }

  function initCurrentLocation() {
    return new Promise(resolve => {
      setStatus('LOCATING GPS…');
      $('originInput').value = '📍 Current Location (Detecting…)';

      if (!navigator.geolocation) {
        log('Geolocation unavailable', 'Defaulting to Coimbatore origin.');
        setFallbackOrigin(resolve);
        return;
      }

      navigator.geolocation.getCurrentPosition(
        async pos => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          state.start = { lat, lng };
          state.currentPosition = { lat, lng };

          $('originInput').value = '📍 Current Location';
          $('originInput').title = `GPS Coordinates: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
          updateEndpointMarker('start', lat, lng, true);
          updateVehicleMarker(lat, lng);

          if (state.map) {
            state.map.setView([lat, lng], 14);
          }

          toast('📍 Current location set as starting point.');
          log('Current GPS location detected', `Starting point: ${lat.toFixed(5)}, ${lng.toFixed(5)}`, 'green');

          await calculateRoutes();
          resolve();
        },
        async err => {
          console.warn('Geolocation denied or timeout:', err.message);
          setFallbackOrigin(resolve);
        },
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }
      );
    });
  }

  // --------------------------------------------------------------------------
  // INTERACTIVE HAZARD & ENTITY INSERTION (Obstacles, Pedestrians, Construction, Roadblocks)
  // --------------------------------------------------------------------------
  function setPlacementMode(type) {
    if (state.placementMode === type) {
      cancelPlacementMode();
      return;
    }
    state.placementMode = type;
    state.selectedToolType = type;

    // Update active button state
    document.querySelectorAll('.entity-tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === type);
    });

    // Show top placement instruction banner
    const banner = $('mapPlacementBanner');
    const text = $('placementBannerText');
    if (banner && text) {
      text.textContent = `Click anywhere on the Leaflet map to place: ${type} (Press Esc to cancel)`;
      banner.hidden = false;
    }

    // Set crosshair cursor on map
    const mapArea = document.querySelector('.map-area');
    if (mapArea) mapArea.classList.add('crosshair-mode');

    toast(`Placement active: Click on the map to insert ${type}`);
    log('Placement mode armed', `Ready to drop ${type} on Leaflet map.`, 'amber');
  }

  function cancelPlacementMode() {
    state.placementMode = null;
    document.querySelectorAll('.entity-tool-btn').forEach(btn => btn.classList.remove('active'));
    const banner = $('mapPlacementBanner');
    if (banner) banner.hidden = true;
    const mapArea = document.querySelector('.map-area');
    if (mapArea) mapArea.classList.remove('crosshair-mode');
  }

  async function handleMapClick(e) {
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;

    // 1. If currently in entity placement mode, insert the hazard/entity
    if (state.placementMode) {
      const type = state.placementMode;
      cancelPlacementMode();
      await insertHazard(type, lat, lng);
      return;
    }

    // 2. Otherwise handle origin/destination clicking
    if (!state.start) {
      state.start = { lat, lng };
      $('originInput').value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      updateEndpointMarker('start', lat, lng);
      toast('Origin location selected on map');
      log('Origin updated', `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    } else if (!state.end) {
      state.end = { lat, lng };
      $('destinationInput').value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      updateEndpointMarker('end', lat, lng);
      toast('Destination location selected on map');
      log('Destination updated', `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
      // Auto-calculate route if both points are chosen
      calculateRoutes();
    } else {
      toast('Click an entity tool above to insert on map, or calculate new route.');
    }
  }

  function updateEndpointMarker(kind, lat, lng, isCurrentLocation = false) {
    if (!state.map) return;
    if (kind === 'start') {
      if (state.startMarker) state.map.removeLayer(state.startMarker);
      const icon = L.divIcon({
        className: 'rg-endpoint-marker',
        html: `<div style="width:22px;height:22px;border-radius:50%;background:#00e59b;border:3px solid #fff;box-shadow:0 0 16px #00e59b;display:grid;place-items:center;color:#000;font-weight:900;font-size:11px;">A</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      const popupText = isCurrentLocation
        ? `<b>Starting Point: Current Location</b><br>Trip departure GPS fix<br><span style="color:#00e59b;font-size:9px;">● LIVE GPS ORIGIN</span>`
        : `<b>Starting Point (A)</b><br>Trip departure location`;
      state.startMarker = L.marker([lat, lng], { icon }).addTo(state.map).bindPopup(popupText);
    } else {
      if (state.endMarker) state.map.removeLayer(state.endMarker);
      const icon = L.divIcon({
        className: 'rg-endpoint-marker',
        html: `<div style="width:22px;height:22px;border-radius:6px;background:#4ca9ff;border:3px solid #fff;box-shadow:0 0 16px #4ca9ff;display:grid;place-items:center;color:#000;font-weight:900;font-size:11px;">B</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      state.endMarker = L.marker([lat, lng], { icon }).addTo(state.map).bindPopup('<b>Destination Point (B)</b><br>Trip arrival target');
    }
  }

  function updateVehicleMarker(lat, lng) {
    if (!state.map) return;
    if (!state.vehicleMarker) {
      const icon = L.divIcon({
        className: 'rg-marker-vehicle-wrap',
        html: `<div class="rg-vehicle-beacon">▲</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13]
      });
      state.vehicleMarker = L.marker([lat, lng], { icon }).addTo(state.map).bindPopup('<b>Vehicle Position</b><br>Autonomous Drive Tracking');
    } else {
      state.vehicleMarker.setLatLng([lat, lng]);
    }
  }

  // --------------------------------------------------------------------------
  // HAZARD / ENTITY CREATION & PERSISTENCE
  // --------------------------------------------------------------------------
  async function insertHazard(type, lat, lng, options = {}) {
    let severity = options.severity || 'Medium';
    let description = options.description || '';

    if (type === 'Road Blocked') {
      severity = 'Critical';
      description = description || 'Full road closure · Police barricade / Impassable corridor';
    } else if (type === 'Pedestrian Moving') {
      severity = 'High';
      description = description || 'Pedestrian crossing roadway (Dynamic motion)';
    } else if (type === 'Construction Working') {
      severity = 'Medium';
      description = description || 'Active work zone · Lane restriction & machinery';
    } else if (type === 'Obstacle') {
      severity = 'Medium';
      description = description || 'Roadway obstacle (Pothole / Debris anomaly)';
    }

    try {
      const res = await api('/api/hazards', {
        lat,
        lng,
        type,
        severity,
        description,
        is_moving: type === 'Pedestrian Moving',
        speed_kmh: type === 'Pedestrian Moving' ? 4.5 : 0,
        radius_m: type === 'Construction Working' ? 120 : (type === 'Road Blocked' ? 60 : 30)
      });

      const hazard = res.hazard;
      state.hazards.unshift(hazard);
      renderHazards();

      // Draw custom Leaflet marker
      drawSingleHazard(hazard);

      toast(`Placed ${type} on map at ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
      log(`Inserted: ${type}`, `${severity} · ${lat.toFixed(4)}, ${lng.toFixed(4)}`, severity === 'Critical' ? 'red' : 'amber');

      // Update perception stack in right sidebar
      triggerPerceptionAlert(type);

      // Trigger dynamic vehicle route change & collision avoidance
      checkHazardsAgainstRoute();

      return hazard;
    } catch (err) {
      toast(`Failed to add hazard: ${err.message}`);
      log('Hazard insertion failed', err.message, 'red');
    }
  }

  function triggerPerceptionAlert(type) {
    if (type === 'Pedestrian Moving') {
      log('Perception Stack: Radar/Camera', 'Target classified: Pedestrian (Walking motion detected).', 'green');
    } else if (type === 'Construction Working') {
      log('Perception Stack: Camera/LiDAR', 'Target classified: Road Construction & Barricades.', 'amber');
    } else if (type === 'Road Blocked') {
      log('Perception Stack: Fusion Stack', 'Critical Obstruction: Road Corridor Impassable.', 'red');
    } else {
      log('Perception Stack: LiDAR Scan', 'Surface anomaly classified: Road Obstacle.', 'amber');
    }
  }

  // --------------------------------------------------------------------------
  // LEAFLET MARKERS FOR ALL ENTITY TYPES (Animated Pedestrian, Construction, Blocked, Obstacle)
  // --------------------------------------------------------------------------
  function drawSingleHazard(h) {
    if (!state.map) return;
    if (state.hazardMarkers[h.id]) {
      clearSingleHazardMarker(h.id);
    }

    let iconHtml = '';
    let markerClass = '';
    let circleColor = '#ff5e66';
    let circleRadius = 30;

    if (h.type === 'Pedestrian Moving') {
      markerClass = 'rg-marker-pedestrian';
      iconHtml = `<div class="rg-marker-wrap rg-marker-pedestrian"><span class="rg-pulse-ring"></span><div class="rg-marker-pin">🚶</div></div>`;
      circleColor = '#4ca9ff';
      circleRadius = 35;
    } else if (h.type === 'Construction Working') {
      markerClass = 'rg-marker-construction';
      iconHtml = `<div class="rg-marker-wrap rg-marker-construction"><span class="rg-pulse-ring"></span><div class="rg-marker-pin">🚧</div></div>`;
      circleColor = '#f97316';
      circleRadius = 90;
    } else if (h.type === 'Road Blocked') {
      markerClass = 'rg-marker-blocked';
      iconHtml = `<div class="rg-marker-wrap rg-marker-blocked"><span class="rg-pulse-ring"></span><div class="rg-marker-pin">⛔</div></div>`;
      circleColor = '#ff5e66';
      circleRadius = 60;
    } else {
      markerClass = 'rg-marker-obstacle';
      iconHtml = `<div class="rg-marker-wrap rg-marker-obstacle"><span class="rg-pulse-ring"></span><div class="rg-marker-pin">⚠️</div></div>`;
      circleColor = '#ffb84d';
      circleRadius = 25;
    }

    const icon = L.divIcon({
      className: `rg-div-marker ${markerClass}`,
      html: iconHtml,
      iconSize: [42, 42],
      iconAnchor: [21, 21],
      popupAnchor: [0, -22]
    });

    const marker = L.marker([h.lat, h.lng], { icon, draggable: true }).addTo(state.map);

    // Caution/detection perimeter circle
    const circle = L.circle([h.lat, h.lng], {
      radius: circleRadius,
      color: circleColor,
      weight: 1.5,
      fillColor: circleColor,
      fillOpacity: h.type === 'Construction Working' ? 0.18 : (h.type === 'Road Blocked' ? 0.25 : 0.12),
      dashArray: h.type === 'Construction Working' ? '6, 6' : null
    }).addTo(state.map);

    // Popup Content
    const popupHtml = `
      <div class="rg-leaflet-popup">
        <div class="rg-popup-header">
          <div class="rg-popup-title">${h.type}</div>
          <span class="rg-popup-sev ${h.severity.toLowerCase()}">${h.severity.toUpperCase()}</span>
        </div>
        <div class="rg-popup-details">
          <div><strong>Status:</strong> ${h.status || 'ACTIVE'}</div>
          <div><strong>Coordinates:</strong> ${Number(h.lat).toFixed(5)}, ${Number(h.lng).toFixed(5)}</div>
          <div><strong>Details:</strong> ${h.description || 'Reported on map'}</div>
          ${h.type === 'Pedestrian Moving' ? '<div><strong>Speed:</strong> ~4.5 km/h (Moving crosswalk)</div>' : ''}
          ${h.type === 'Construction Working' ? '<div><strong>Advisory:</strong> 20 km/h Caution Perimeter</div>' : ''}
          ${h.type === 'Road Blocked' ? '<div style="color:#ff858b"><strong>Action:</strong> Dynamic reroute triggered</div>' : ''}
        </div>
        <button type="button" class="rg-popup-del-btn" data-id="${h.id}">✕ Remove from Map</button>
      </div>
    `;
    marker.bindPopup(popupHtml);

    // Listen for delete button click in popup
    marker.on('popupopen', () => {
      const btn = document.querySelector(`.rg-popup-del-btn[data-id="${h.id}"]`);
      if (btn) {
        btn.onclick = () => deleteHazard(h.id);
      }
    });

    // Support dragging markers to relocate them dynamically!
    marker.on('drag', e => {
      const pos = e.target.getLatLng();
      h.lat = pos.lat;
      h.lng = pos.lng;
      circle.setLatLng(pos);
      checkHazardsAgainstRoute();
    });

    marker.on('dragend', async e => {
      const pos = e.target.getLatLng();
      h.lat = pos.lat;
      h.lng = pos.lng;
      circle.setLatLng(pos);
      toast(`${h.type} moved to ${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}`);
      checkHazardsAgainstRoute();
      renderHazards();
    });

    // Pedestrian dynamic motion animation!
    let animTimer = null;
    if (h.type === 'Pedestrian Moving' || h.is_moving) {
      let step = 0;
      const baseLat = h.lat;
      const baseLng = h.lng;
      const heading = (h.heading || 90) * Math.PI / 180;
      const stepAmp = 0.00035; // ~35 meters oscillation crossing

      animTimer = setInterval(() => {
        step += 0.08;
        const offset = Math.sin(step) * stepAmp;
        const curLat = baseLat + offset * Math.cos(heading);
        const curLng = baseLng + offset * Math.sin(heading);
        marker.setLatLng([curLat, curLng]);
        circle.setLatLng([curLat, curLng]);
        h.lat = curLat;
        h.lng = curLng;

        // Proximity detection with simulated vehicle
        if (state.currentPosition) {
          const d = haversine(state.currentPosition, { lat: curLat, lng: curLng });
          if (d < 0.06) { // under 60 meters
            $('vehicleHealth').textContent = 'YIELD (PEDESTRIAN)';
            $('vehicleHealth').style.color = 'var(--amber)';
          }
        }
      }, 350);
    }

    state.hazardMarkers[h.id] = { marker, circle, animTimer, data: h };
  }

  function clearSingleHazardMarker(id) {
    const entry = state.hazardMarkers[id];
    if (entry) {
      if (entry.animTimer) clearInterval(entry.animTimer);
      if (entry.marker) state.map.removeLayer(entry.marker);
      if (entry.circle) state.map.removeLayer(entry.circle);
      delete state.hazardMarkers[id];
    }
  }

  function renderHazards() {
    const el = $('hazardList');
    if (!el) return;
    el.innerHTML = '';
    if (!state.hazards.length) {
      el.innerHTML = '<div class="empty-inline">No active entities on map. Use toolbar above map to insert.</div>';
      return;
    }

    state.hazards.forEach(h => {
      const row = document.createElement('div');
      row.className = 'hazard-item';

      let symbol = '⚠️';
      if (h.type === 'Pedestrian Moving') symbol = '🚶';
      else if (h.type === 'Construction Working') symbol = '🚧';
      else if (h.type === 'Road Blocked') symbol = '⛔';

      row.innerHTML = `
        <div class="hazard-symbol" style="background:#1c251f;color:#e8f1eb;font-size:14px;">${symbol}</div>
        <div style="flex:1;min-width:0">
          <b>${h.type}</b>
          <small>${Number(h.lat).toFixed(4)}, ${Number(h.lng).toFixed(4)} · ${h.severity}</small>
        </div>
        <span class="unverified" style="color:${h.severity === 'Critical' ? 'var(--red)' : 'var(--amber)'}">${h.severity.toUpperCase()}</span>
        <button class="hazard-del-btn" data-id="${h.id}" title="Delete entity">✕</button>
      `;

      row.querySelector('.hazard-del-btn').addEventListener('click', e => {
        e.stopPropagation();
        deleteHazard(h.id);
      });

      row.addEventListener('click', () => {
        if (state.map && h.lat && h.lng) {
          state.map.panTo([h.lat, h.lng]);
          state.hazardMarkers[h.id]?.marker.openPopup();
        }
      });

      el.appendChild(row);
    });
  }

  async function deleteHazard(id) {
    try {
      await api('/api/hazards/delete', { id });
      clearSingleHazardMarker(id);
      state.hazards = state.hazards.filter(h => h.id !== id);
      renderHazards();
      toast('Removed hazard from map.');
      log('Hazard removed', `ID: ${id}`, 'green');
      checkHazardsAgainstRoute();
    } catch (err) {
      clearSingleHazardMarker(id);
      state.hazards = state.hazards.filter(h => h.id !== id);
      renderHazards();
      checkHazardsAgainstRoute();
    }
  }

  async function clearAllHazards() {
    try {
      await api('/api/hazards/clear');
    } catch {}
    Object.keys(state.hazardMarkers).forEach(id => clearSingleHazardMarker(id));
    state.hazards = [];
    if (state.blockedSegmentLayer && state.map) {
      state.map.removeLayer(state.blockedSegmentLayer);
      state.blockedSegmentLayer = null;
    }
    renderHazards();
    toast('Cleared all obstacles and hazards from map.');
    log('All hazards cleared', 'Map and collision layers reset to clean state.', 'green');
    // Re-evaluate routes back to normal
    calculateRoutes();
  }

  async function refreshHazards() {
    try {
      const d = await api('/api/hazards');
      state.hazards = d.hazards || [];
      Object.keys(state.hazardMarkers).forEach(id => clearSingleHazardMarker(id));
      state.hazards.forEach(h => drawSingleHazard(h));
      renderHazards();
    } catch (e) {
      console.warn('Could not refresh hazards:', e);
    }
  }

  // --------------------------------------------------------------------------
  // QUICK ADD ON ROUTE & DEMO SCENARIOS FOR REVIEW
  // --------------------------------------------------------------------------
  async function quickAddOnRoute() {
    if (!state.routes.length) {
      toast('Calculating corridor first...');
      await calculateRoutes();
    }

    if (!state.routes.length) {
      toast('Please calculate a route or select origin/destination first.');
      return;
    }

    const currentRoute = state.routes[state.selected] || state.routes[0];
    const coords = routeCoords(currentRoute);
    if (coords.length < 5) {
      toast('Route geometry too short.');
      return;
    }

    // Pick a point around 45% of the active route
    const midIdx = Math.floor(coords.length * 0.45);
    const targetPoint = coords[midIdx];

    const type = state.selectedToolType || 'Obstacle';
    await insertHazard(type, targetPoint.lat, targetPoint.lng, {
      description: `${type} placed directly on Corridor ${state.selected + 1}`
    });

    state.map.setView([targetPoint.lat, targetPoint.lng], 14);
    toast(`⚡ Dropped ${type} on active corridor! Avoidance reroute triggered!`);
  }

  async function loadReviewScenario(scenarioKey) {
    const dd = $('scenariosDropdown');
    if (dd) dd.hidden = true;

    if (!state.routes.length) {
      await calculateRoutes();
    }

    const currentRoute = state.routes[state.selected] || state.routes[0];
    const coords = routeCoords(currentRoute);
    if (coords.length < 6) return;

    if (scenarioKey === 'pedestrian') {
      const pt = coords[Math.floor(coords.length * 0.35)];
      await insertHazard('Pedestrian Moving', pt.lat, pt.lng, {
        description: 'Review Demo: Pedestrian crossing vehicle corridor'
      });
      state.map.setView([pt.lat, pt.lng], 15);
      toast('🎬 Scenario: Pedestrian Crossing activated! Rerouting trajectory.');
    } else if (scenarioKey === 'construction') {
      const pt = coords[Math.floor(coords.length * 0.5)];
      await insertHazard('Construction Working', pt.lat, pt.lng, {
        description: 'Review Demo: Active roadwork & speed restriction zone'
      });
      state.map.setView([pt.lat, pt.lng], 14);
      toast('🎬 Scenario: Work Zone caution & dynamic detour activated!');
    } else if (scenarioKey === 'blockage') {
      const pt = coords[Math.floor(coords.length * 0.4)];
      await insertHazard('Road Blocked', pt.lat, pt.lng, {
        description: 'Review Demo: Highway blockage triggering immediate rerouting'
      });
      state.map.setView([pt.lat, pt.lng], 14);
      toast('🎬 Scenario: Road Blocked! Complete corridor reroute executed!');
    } else if (scenarioKey === 'combo') {
      const pt1 = coords[Math.floor(coords.length * 0.25)];
      const pt2 = coords[Math.floor(coords.length * 0.5)];
      const pt3 = coords[Math.floor(coords.length * 0.75)];

      await insertHazard('Obstacle', pt1.lat, pt1.lng, { description: 'Pothole & debris on lane' });
      await insertHazard('Pedestrian Moving', pt2.lat, pt2.lng, { description: 'School crossing pedestrian' });
      await insertHazard('Construction Working', pt3.lat, pt3.lng, { description: 'Bridge repair construction' });

      toast('🎬 Scenario: Full Urban Perception & Avoidance stack deployed!');
      state.map.fitBounds(L.featureGroup(Object.values(state.hazardMarkers).map(m => m.marker)).getBounds().pad(0.2));
    }
  }

  // --------------------------------------------------------------------------
  // GEOCODING & LOCATION SEARCH
  // --------------------------------------------------------------------------
  async function geocode(text) {
    if (!text || !text.trim()) throw new Error('Please enter a location or click on the map.');
    const query = text.trim();

    // 1. Coordinates regex: "lat, lng"
    const m = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) return { lat: +m[1], lng: +m[2] };

    // 2. Current GPS Location check
    const normalized = query.toLowerCase().replace(/[^\w\s,]/g, '').trim();
    if (normalized.includes('current location') || normalized.includes('my location') || normalized.includes('gps')) {
      if (state.currentPosition) return { ...state.currentPosition };
      if (state.start) return { ...state.start };
      return { lat: 11.016844, lng: 76.955833 };
    }

    // 3. Local dictionary lookup (Instant & offline-resilient)
    if (LANDMARKS[normalized]) {
      return { ...LANDMARKS[normalized] };
    }
    for (const key of Object.keys(LANDMARKS)) {
      if (normalized.includes(key) || key.includes(normalized)) {
        return { ...LANDMARKS[key] };
      }
    }

    // 3. OpenStreetMap Nominatim Geocoding
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      if (res.ok) {
        const data = await res.json();
        if (data.length) {
          return { lat: +data[0].lat, lng: +data[0].lon };
        }
      }
    } catch {}

    // Fallback to default Coimbatore coordinates
    return { lat: 11.016844, lng: 76.955833 };
  }

  // --------------------------------------------------------------------------
  // ROUTE CALCULATION & COLLISION EVALUATION
  // --------------------------------------------------------------------------
  function clearRoutes() {
    state.routeLayers.forEach(layer => {
      try { state.map.removeLayer(layer); } catch {}
    });
    state.routeLayers = [];
    if (state.blockedSegmentLayer && state.map) {
      state.map.removeLayer(state.blockedSegmentLayer);
      state.blockedSegmentLayer = null;
    }
  }

  function drawRoutes() {
    state.routeLayers.forEach(layer => {
      try { state.map.removeLayer(layer); } catch {}
    });
    state.routeLayers = [];

    if (!state.map || !state.routes.length) return;

    state.routes.forEach((route, i) => {
      const selected = i === state.selected;
      let color = ROUTE_COLORS[i % ROUTE_COLORS.length];
      if (route.is_blocked) {
        color = '#ff5e66'; // Red warning for blocked route
      } else if (route.is_detoured && selected) {
        color = '#00e59b'; // Vibrant green for detoured active route
      }

      let coords = routeCoords(route);
      if (!coords.length) return;

      const latlngs = coords.map(c => [c.lat, c.lng]);

      const line = L.polyline(latlngs, {
        color,
        weight: selected ? 6 : 4,
        opacity: selected ? 0.95 : 0.5,
        dashArray: route.is_blocked ? '8 8' : (selected ? null : '6 6')
      }).addTo(state.map);

      line.on('click', () => selectRoute(i));
      state.routeLayers.push(line);
    });

    if (state.routeLayers.length) {
      const group = L.featureGroup(state.routeLayers);
      state.map.fitBounds(group.getBounds().pad(0.12));
    }
  }

  function selectRoute(i) {
    if (!state.routes[i]) return;
    state.selected = i;
    drawRoutes();
    renderRoutes();

    const r = state.routes[i];
    $('etaMetric').textContent = `${r.duration_min} min`;
    $('distanceMetric').textContent = `${r.distance_km} km`;
    $('etaSub').textContent = r.traffic_condition || 'OSRM route calculation';

    log('Route selected', `${r.name || `Corridor ${i + 1}`} · ${r.distance_km} km · ${r.duration_min} min`);
    checkHazardsAgainstRoute();
  }

  function renderRoutes() {
    const el = $('routeList');
    if (!el) return;
    el.innerHTML = '';
    $('routeCount').textContent = state.routes.length;

    if (!state.routes.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">⌁</div><b>No route calculated</b><span>Choose an origin and destination to compare routes.</span></div>';
      return;
    }

    state.routes.forEach((r, i) => {
      const card = document.createElement('div');
      card.className = 'route-card' + (i === state.selected ? ' selected' : '');
      const badgeText = r.is_blocked ? 'BLOCKED' : (r.is_detoured ? 'DETOURED' : (r.is_recommended ? 'RECOMMENDED' : `OPTION ${i + 1}`));

      card.innerHTML = `
        <div class="route-card-head">
          <span class="route-name"></span>
          <span class="route-badge" style="${r.is_blocked ? 'background:#471216;color:#ff858b' : (r.is_detoured ? 'background:#0d3622;color:#00e59b' : '')}">${badgeText}</span>
        </div>
        <div class="route-metrics">
          <div><strong>${r.duration_min} min</strong><small>Estimated time</small></div>
          <div><strong>${r.distance_km} km</strong><small>Distance</small></div>
        </div>
        <div class="route-meta"></div>
      `;

      card.querySelector('.route-name').textContent = r.name || `Corridor ${i + 1}`;
      card.querySelector('.route-meta').textContent = r.is_detoured ? '⚡ Dynamic obstacle detour active' : (r.recommendation_reason || r.traffic_condition || 'Active road corridor');

      card.addEventListener('click', () => selectRoute(i));
      el.appendChild(card);
    });
  }

  async function calculateRoutes() {
    const btn = $('calculateBtn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = 'Calculating corridors…';
    }
    setStatus('CALCULATING ROUTES');

    try {
      if (!state.start) state.start = await geocode($('originInput').value);
      if (!state.end) state.end = await geocode($('destinationInput').value);

      updateEndpointMarker('start', state.start.lat, state.start.lng);
      updateEndpointMarker('end', state.end.lat, state.end.lng);
      if (!state.currentPosition) {
        state.currentPosition = { ...state.start };
      }
      updateVehicleMarker(state.currentPosition.lat, state.currentPosition.lng);

      const activeHazardsPayload = state.hazards.map(h => ({
        id: h.id,
        lat: h.lat,
        lng: h.lng,
        type: h.type,
        severity: h.severity
      }));

      const res = await api('/api/route', {
        start: state.start,
        end: state.end,
        hazards: activeHazardsPayload
      });

      state.routes = (res.routes || []).map(r => {
        const c = routeCoords(r);
        return {
          ...r,
          coords: c,
          _originalCoords: c.map(pt => ({ lat: pt.lat, lng: pt.lng }))
        };
      });

      $('routeProviderNote').textContent = `Leaflet Multi-Corridor Engine (${res.provider || 'OSRM/OpenStreetMap'}).`;
      $('apiStatus').textContent = 'LEAFLET OSRM ENGINE ACTIVE';
      $('apiStatusSub').textContent = `${state.routes.length} corridors evaluated against ${state.hazards.length} hazards.`;

      log('Routes calculated', `${state.routes.length} distinct corridor(s) calculated via OSRM.`);

      // Pick recommended route
      const recIdx = state.routes.findIndex(r => r.is_recommended);
      state.selected = recIdx >= 0 ? recIdx : 0;

      drawRoutes();
      renderRoutes();
      selectRoute(state.selected);
      setStatus('ROUTE READY');
      $('routingModeTag').textContent = 'ROUTE READY';
    } catch (err) {
      setStatus('ROUTE ERROR');
      toast(err.message);
      log('Route calculation failed', err.message, 'red');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span>⌁</span> Calculate routes <span class="button-arrow">→</span>';
      }
    }
  }

  // --------------------------------------------------------------------------
  // GEOMETRIC INTERSECTION & POINT-TO-SEGMENT DISTANCE
  // --------------------------------------------------------------------------
  function pointToSegmentDistance(p, a, b) {
    const pLat = p.lat !== undefined ? p.lat : p[1];
    const pLng = p.lng !== undefined ? p.lng : p[0];
    const aLat = a.lat !== undefined ? a.lat : a[1];
    const aLng = a.lng !== undefined ? a.lng : a[0];
    const bLat = b.lat !== undefined ? b.lat : b[1];
    const bLng = b.lng !== undefined ? b.lng : b[0];

    const dx = bLng - aLng;
    const dy = bLat - aLat;
    const lenSq = dx * dx + dy * dy;

    if (lenSq < 1e-13) {
      return { distKm: haversine({ lat: pLat, lng: pLng }, { lat: aLat, lng: aLng }), proj: { lat: aLat, lng: aLng }, t: 0 };
    }

    let t = ((pLng - aLng) * dx + (pLat - aLat) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const proj = {
      lat: aLat + t * dy,
      lng: aLng + t * dx
    };

    return {
      distKm: haversine({ lat: pLat, lng: pLng }, proj),
      proj,
      t
    };
  }

  function hazardTouchesRoute(h, r) {
    const coords = (r._originalCoords && r._originalCoords.length) ? r._originalCoords : routeCoords(r);
    if (!coords || coords.length < 2) return false;

    // Threshold based on hazard type
    let thresholdKm = 0.085; // 85m for road obstacles
    if (h.type === 'Construction Working') thresholdKm = 0.15; // 150m for construction zone
    else if (h.type === 'Road Blocked') thresholdKm = 0.12;     // 120m for road block
    else if (h.type === 'Pedestrian Moving') thresholdKm = 0.07; // 70m for pedestrians

    for (let i = 0; i < coords.length - 1; i++) {
      const res = pointToSegmentDistance(h, coords[i], coords[i + 1]);
      if (res.distKm <= thresholdKm) {
        return true;
      }
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // DYNAMIC OBSTACLE AVOIDANCE & ROUTE BENDING
  // When any obstacle, construction, pedestrian, etc occurs -> CHANGE THE ROUTE OF THE VEHICLE
  // --------------------------------------------------------------------------
  function applyDynamicObstacleAvoidance() {
    if (!state.routes.length) return false;
    const currentRoute = state.routes[state.selected];
    if (!currentRoute) return false;

    // Ensure _originalCoords is always preserved
    if (!currentRoute._originalCoords || !currentRoute._originalCoords.length) {
      currentRoute._originalCoords = routeCoords(currentRoute).map(c => ({ lat: c.lat, lng: c.lng }));
    }

    const baseCoords = [...currentRoute._originalCoords];
    if (baseCoords.length < 4) return false;

    // Check if any hazard intersects or is close to the active route
    const hits = state.hazards.filter(h => hazardTouchesRoute(h, currentRoute));
    const rerouteBanner = $('dynamicRerouteBanner');

    if (!hits.length) {
      // Restore clean original route
      currentRoute.coords = [...baseCoords];
      currentRoute.is_detoured = false;
      currentRoute.geometry = {
        type: 'LineString',
        coordinates: baseCoords.map(c => [c.lng, c.lat])
      };

      if (state.blockedSegmentLayer && state.map) {
        state.map.removeLayer(state.blockedSegmentLayer);
        state.blockedSegmentLayer = null;
      }
      if (rerouteBanner) {
        rerouteBanner.hidden = true;
      }

      drawRoutes();
      renderRoutes();
      return false;
    }

    let detouredCoords = [...baseCoords];
    let blockedSegments = [];
    let maxOffsetDist = 0.00095;

    hits.forEach(h => {
      // Find closest segment on detouredCoords to this hazard
      let bestSegmentIdx = -1;
      let minDistanceKm = Infinity;
      let bestProj = null;

      for (let i = 0; i < detouredCoords.length - 1; i++) {
        const res = pointToSegmentDistance(h, detouredCoords[i], detouredCoords[i + 1]);
        if (res.distKm < minDistanceKm) {
          minDistanceKm = res.distKm;
          bestSegmentIdx = i;
          bestProj = res.proj;
        }
      }

      const thresholdKm = (h.type === 'Construction Working') ? 0.16 : ((h.type === 'Road Blocked') ? 0.13 : 0.09);

      if (bestSegmentIdx >= 0 && minDistanceKm <= thresholdKm) {
        const pA = detouredCoords[bestSegmentIdx];
        const pB = detouredCoords[bestSegmentIdx + 1];

        // Road tangent vector
        const dx = pB.lng - pA.lng;
        const dy = pB.lat - pA.lat;
        const len = Math.sqrt(dx * dx + dy * dy);

        if (len > 1e-7) {
          const tx = dx / len;
          const ty = dy / len;
          // Normal perpendicular vector (-ty, tx)
          const nx = -ty;
          const ny = tx;

          // Determine which side the hazard is on relative to the road
          const hx = h.lng - bestProj.lng;
          const hy = h.lat - bestProj.lat;
          const dot = nx * hx + ny * hy;

          // Steer in opposite direction of hazard to maintain safe perimeter
          let steerSign = 1;
          if (dot > 0.000005) steerSign = -1;
          else if (dot < -0.000005) steerSign = 1;
          else steerSign = 1; // Center obstacle: veer right

          // Lateral clearance distance
          let offsetDist = 0.00085; // ~85m for general obstacle
          if (h.type === 'Construction Working') offsetDist = 0.00135; // ~135m for construction work zone
          else if (h.type === 'Road Blocked') offsetDist = 0.00175;     // ~175m for road blocked
          else if (h.type === 'Pedestrian Moving') offsetDist = 0.00075; // ~75m for moving pedestrian

          if (offsetDist > maxOffsetDist) maxOffsetDist = offsetDist;

          // Transition start and end along the road (~90m before and after)
          const spanDist = Math.max(len * 0.7, 0.0009);
          const pEntry = {
            lat: bestProj.lat - ty * spanDist,
            lng: bestProj.lng - tx * spanDist
          };
          const pExit = {
            lat: bestProj.lat + ty * spanDist,
            lng: bestProj.lng + tx * spanDist
          };

          // Capture original obstructed roadway section for red warning display
          blockedSegments.push([pEntry, bestProj, pExit]);

          // Compute smooth 5-point avoidance arc around obstacle
          const arc1 = {
            lat: pEntry.lat + (bestProj.lat - pEntry.lat) * 0.6 + ny * offsetDist * 0.55 * steerSign,
            lng: pEntry.lng + (bestProj.lng - pEntry.lng) * 0.6 + nx * offsetDist * 0.55 * steerSign
          };
          const arcApex = {
            lat: bestProj.lat + ny * offsetDist * 1.25 * steerSign,
            lng: bestProj.lng + nx * offsetDist * 1.25 * steerSign
          };
          const arc2 = {
            lat: bestProj.lat + (pExit.lat - bestProj.lat) * 0.4 + ny * offsetDist * 0.55 * steerSign,
            lng: bestProj.lng + (pExit.lng - bestProj.lng) * 0.4 + nx * offsetDist * 0.55 * steerSign
          };

          // Splice smooth detour waypoints into route polyline
          detouredCoords = [
            ...detouredCoords.slice(0, bestSegmentIdx + 1),
            pEntry,
            arc1,
            arcApex,
            arc2,
            pExit,
            ...detouredCoords.slice(bestSegmentIdx + 1)
          ];
        }
      }
    });

    // Update active route geometry
    currentRoute.coords = detouredCoords;
    currentRoute.is_detoured = true;
    currentRoute.geometry = {
      type: 'LineString',
      coordinates: detouredCoords.map(c => [c.lng, c.lat])
    };

    // Draw red dashed line for the obstructed/avoided road section
    if (state.blockedSegmentLayer && state.map) {
      state.map.removeLayer(state.blockedSegmentLayer);
    }
    if (blockedSegments.length) {
      const lines = blockedSegments.map(seg => seg.map(p => [p.lat, p.lng]));
      state.blockedSegmentLayer = L.polyline(lines, {
        color: '#ff5e66',
        weight: 5,
        opacity: 0.9,
        dashArray: '6 8'
      }).addTo(state.map).bindTooltip('⚠️ Obstructed corridor: Avoided by dynamic vehicle detour', { sticky: true });
    }

    // Show dynamic reroute banner
    if (rerouteBanner) {
      rerouteBanner.hidden = false;
      rerouteBanner.classList.remove('blocked-mode');
      $('rerouteBannerTitle').textContent = 'DYNAMIC REROUTE ACTIVE';
      const names = hits.map(h => h.type).join(', ');
      $('rerouteBannerSubtitle').textContent = `Vehicle path altered: Steering safely around ${names} (+${Math.round(maxOffsetDist * 100000)}m clearance)`;
      $('rerouteBannerBadge').textContent = 'SAFE BYPASS';
    }

    // Redraw active route with updated avoidance curve
    drawRoutes();
    renderRoutes();

    // Update active demo drive coordinates if driving
    if (state.demoTimer && state.activeDemoCoords) {
      state.activeDemoCoords = detouredCoords;
      if (state.currentPosition) {
        let closestNewIdx = 0;
        let minD = Infinity;
        for (let i = 0; i < detouredCoords.length; i++) {
          const d = haversine(detouredCoords[i], state.currentPosition);
          if (d < minD) { minD = d; closestNewIdx = i; }
        }
        state.demoIndex = closestNewIdx;
      }
    }

    toast('🔄 Route dynamically changed: Detouring around obstacle!');
    log('Dynamic Reroute Active', `Vehicle route altered to steer around ${hits.map(h => h.type).join(', ')}.`, 'green');

    $('riskMetric').textContent = 'DETOUR ACTIVE';
    $('riskMetric').style.color = 'var(--green)';
    $('riskSub').textContent = 'Dynamic avoidance detour active';

    return true;
  }

  function checkHazardsAgainstRoute() {
    if (!state.routes.length) return;
    const currentRoute = state.routes[state.selected];
    if (!currentRoute) return;

    const hits = state.hazards.filter(h => hazardTouchesRoute(h, currentRoute));
    const isBlocked = hits.some(h => h.type === 'Road Blocked' || h.severity === 'Critical');

    // 1. If hazard exists, apply dynamic local obstacle avoidance detour
    const detoured = applyDynamicObstacleAvoidance();

    // 2. Check if a complete alternate corridor bypass should also be triggered
    if (hits.length) {
      if (isBlocked) {
        $('riskMetric').textContent = 'CRITICAL';
        $('riskMetric').style.color = 'var(--red)';
        $('riskSub').textContent = `ROAD BLOCKED: ${hits.length} active obstruction(s)`;

        // Show banner in blocked mode
        const banner = $('dynamicRerouteBanner');
        if (banner) {
          banner.hidden = false;
          banner.classList.add('blocked-mode');
          $('rerouteBannerTitle').textContent = '⛔ ROAD BLOCKAGE AHEAD — CORRIDOR REROUTED';
          $('rerouteBannerSubtitle').textContent = 'Primary highway impassable. Switched to safe bypass corridor.';
          $('rerouteBannerBadge').textContent = 'BYPASS ACTIVE';
        }
      } else if (!detoured) {
        $('riskMetric').textContent = 'HIGH';
        $('riskMetric').style.color = 'var(--amber)';
        $('riskSub').textContent = `${hits.length} reported hazard(s) intersecting corridor`;
      }

      // Find an alternate route completely free of critical obstacles
      const alternate = state.routes.findIndex((r, i) => i !== state.selected && !r.is_blocked && !state.hazards.some(h => (h.type === 'Road Blocked' || h.severity === 'Critical') && hazardTouchesRoute(h, r)));

      if (alternate >= 0 && isBlocked) {
        state.pendingRoute = alternate;
        const rerouteMode = $('rerouteMode') ? $('rerouteMode').value : 'automatic';

        if (rerouteMode === 'automatic') {
          selectRoute(alternate);
          toast(`⚡ Complete Corridor Reroute: Switched to Corridor ${alternate + 1} to avoid road block!`);
          log('Corridor Reroute Executed', `Switched from Corridor ${state.selected + 1} to Corridor ${alternate + 1} (obstruction avoided).`, 'green');
        } else {
          $('rerouteMessage').textContent = `Road blockage detected on this corridor. Alternative Corridor ${alternate + 1} is clear and safe.`;
          $('rerouteModal').hidden = false;
          log('Alternative corridor ready', 'Waiting for operator confirmation.', 'amber');
        }
      }
    } else {
      $('riskMetric').textContent = 'LOW';
      $('riskMetric').style.color = 'var(--green)';
      $('riskSub').textContent = 'No hazards intersecting active corridor';
      const banner = $('dynamicRerouteBanner');
      if (banner) banner.hidden = true;
    }
  }

  // --------------------------------------------------------------------------
  // VEHICLE DEMO DRIVE & GPS TRACKING
  // --------------------------------------------------------------------------
  function startDemo() {
    if (state.demoTimer) {
      clearInterval(state.demoTimer);
      state.demoTimer = null;
      $('demoBtn').textContent = '▶ Demo drive';
      toast('Demo drive paused');
      return;
    }

    state.activeDemoCoords = routeCoords(state.routes[state.selected] || {});
    if (state.activeDemoCoords.length < 2) {
      toast('Calculate a route before starting the demo drive.');
      return;
    }

    state.demoIndex = 0;
    $('demoBtn').textContent = 'Ⅱ Pause demo';
    log('Demo drive started', 'Autonomous vehicle simulation underway along selected corridor.', 'green');

    state.demoTimer = setInterval(() => {
      const coords = state.activeDemoCoords;
      if (state.demoIndex >= coords.length) {
        clearInterval(state.demoTimer);
        state.demoTimer = null;
        $('demoBtn').textContent = '▶ Demo drive';
        $('vehicleHealth').textContent = 'DESTINATION';
        $('speedVal').textContent = '0';
        $('speedGauge').style.width = '0%';
        log('Demo route completed', 'Vehicle reached target destination safely.', 'green');
        toast('Demo drive completed!');
        return;
      }

      const p = coords[state.demoIndex++];
      state.currentPosition = p;

      // Check proximity with hazards along path
      const nearHazard = state.hazards.find(h => haversine(h, p) < 0.16);
      let targetSpeed = 42;

      if (nearHazard) {
        if (nearHazard.type === 'Road Blocked') {
          targetSpeed = 0;
          $('vehicleHealth').textContent = 'ROAD BLOCKED';
          $('vehicleHealth').style.color = 'var(--red)';
        } else if (nearHazard.type === 'Pedestrian Moving') {
          targetSpeed = 14;
          $('vehicleHealth').textContent = 'SLOWING (PEDESTRIAN)';
          $('vehicleHealth').style.color = 'var(--amber)';
        } else if (nearHazard.type === 'Construction Working') {
          targetSpeed = 20;
          $('vehicleHealth').textContent = 'WORK ZONE (20 km/h)';
          $('vehicleHealth').style.color = 'var(--amber)';
        } else {
          targetSpeed = 24;
          $('vehicleHealth').textContent = 'AVOIDING OBSTACLE';
          $('vehicleHealth').style.color = 'var(--amber)';
        }
      } else {
        $('vehicleHealth').textContent = state.routes[state.selected]?.is_detoured ? 'DETOUR GUIDANCE' : 'MOVING (AUTONOMOUS)';
        $('vehicleHealth').style.color = 'var(--green)';
      }

      $('vehicleSource').textContent = 'SIMULATION';
      $('telemetryType').textContent = 'SIMULATION';
      $('vehicleStatus').textContent = 'Active route guidance';
      $('speedVal').textContent = String(targetSpeed);
      $('speedGauge').style.width = `${Math.min(100, targetSpeed * 2)}%`;
      $('updateVal').textContent = new Date().toLocaleTimeString();

      // Update vehicle marker
      updateVehicleMarker(p.lat, p.lng);

      if (state.follow && state.map) {
        state.map.panTo([p.lat, p.lng]);
      }
    }, 450);
  }

  function startGps() {
    if (!navigator.geolocation) {
      toast('Browser geolocation is not supported.');
      return;
    }
    if (state.watchId !== null) return;

    state.watchId = navigator.geolocation.watchPosition(pos => {
      const c = pos.coords;
      state.currentPosition = { lat: c.latitude, lng: c.longitude };
      $('vehicleSource').textContent = 'BROWSER GPS';
      $('telemetryType').textContent = 'GPS';
      $('vehicleStatus').textContent = 'GPS permission active';
      $('vehicleHealth').textContent = 'TRACKING';
      $('speedVal').textContent = c.speed == null ? '0' : Math.round(c.speed * 3.6);
      $('headingVal').textContent = c.heading == null ? '—' : `${Math.round(c.heading)}°`;
      $('updateVal').textContent = new Date(pos.timestamp).toLocaleTimeString();

      updateVehicleMarker(c.latitude, c.longitude);

      if (state.follow && state.map) {
        state.map.panTo([c.latitude, c.longitude]);
      }
    }, err => {
      toast('GPS location access denied or unavailable.');
      log('GPS tracking unavailable', err.message, 'amber');
      stopGps();
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 12000 });

    $('vehicleSource').textContent = 'GPS STARTING';
    log('GPS tracking started', 'Receiving browser telemetry coordinates.');
  }

  function stopGps() {
    if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    $('vehicleStatus').textContent = 'Tracking stopped';
    $('vehicleSource').textContent = 'STANDBY';
    log('GPS tracking stopped', 'No further browser location updates.');
  }

  // --------------------------------------------------------------------------
  // EVENT LISTENERS & INITIALIZATION
  // --------------------------------------------------------------------------
  function setupEventListeners() {
    // Toolbar buttons for entity insertion
    $('toolObstacle')?.addEventListener('click', () => setPlacementMode('Obstacle'));
    $('toolPedestrian')?.addEventListener('click', () => setPlacementMode('Pedestrian Moving'));
    $('toolConstruction')?.addEventListener('click', () => setPlacementMode('Construction Working'));
    $('toolRoadBlocked')?.addEventListener('click', () => setPlacementMode('Road Blocked'));

    // Cancel placement button
    $('cancelPlacementBtn')?.addEventListener('click', cancelPlacementMode);

    // Quick add on route
    $('quickAddOnRouteBtn')?.addEventListener('click', quickAddOnRoute);

    // Review scenarios dropdown
    $('demoScenariosBtn')?.addEventListener('click', e => {
      e.stopPropagation();
      const dd = $('scenariosDropdown');
      if (dd) dd.hidden = !dd.hidden;
    });

    document.querySelectorAll('.scenario-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.scenario;
        loadReviewScenario(key);
      });
    });

    document.addEventListener('click', e => {
      const dd = $('scenariosDropdown');
      if (dd && !dd.hidden && !e.target.closest('.scenarios-menu-wrap')) {
        dd.hidden = true;
      }
    });

    // Clear buttons
    $('clearAllHazardsBtn')?.addEventListener('click', clearAllHazards);
    $('clearHazardsSidebarBtn')?.addEventListener('click', clearAllHazards);

    // Map controls
    $('themeBtn')?.addEventListener('click', toggleMapTheme);
    $('calculateBtn')?.addEventListener('click', calculateRoutes);
    $('demoBtn')?.addEventListener('click', startDemo);
    $('trackBtn')?.addEventListener('click', startGps);
    $('stopTrackBtn')?.addEventListener('click', stopGps);

    $('followBtn')?.addEventListener('click', () => {
      state.follow = !state.follow;
      $('followBtn').classList.toggle('active', state.follow);
      $('followBtn').textContent = state.follow ? '◎ Following vehicle' : '◎ Follow vehicle';
      if (state.follow && state.currentPosition && state.map) {
        state.map.panTo([state.currentPosition.lat, state.currentPosition.lng]);
      }
    });

    $('trafficBtn')?.addEventListener('click', () => {
      state.traffic = !state.traffic;
      $('trafficBtn').classList.toggle('active', state.traffic);
      toast(state.traffic ? 'Congestion perception layer enabled.' : 'Congestion layer disabled.');
      log('Traffic layer toggled', state.traffic ? 'Simulation congestion active.' : 'Normal view.');
    });

    $('swapBtn')?.addEventListener('click', () => {
      const a = $('originInput').value;
      $('originInput').value = $('destinationInput').value;
      $('destinationInput').value = a;
      const tmp = state.start;
      state.start = state.end;
      state.end = tmp;
      if (state.start) updateEndpointMarker('start', state.start.lat, state.start.lng);
      if (state.end) updateEndpointMarker('end', state.end.lat, state.end.lng);
    });

    $('useLocationBtn')?.addEventListener('click', () => {
      initCurrentLocation();
    });

    // Sidebar Manual Report Panel
    $('reportHazardBtn')?.addEventListener('click', () => {
      const p = $('reportPanel');
      if (p) p.hidden = !p.hidden;
      if (state.currentPosition) {
        $('hazardLat').value = state.currentPosition.lat;
        $('hazardLng').value = state.currentPosition.lng;
      }
    });

    $('cancelReportBtn')?.addEventListener('click', () => {
      if ($('reportPanel')) $('reportPanel').hidden = true;
    });

    $('submitHazardBtn')?.addEventListener('click', async () => {
      let lat = +$('hazardLat').value;
      let lng = +$('hazardLng').value;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        if (state.map) {
          const c = state.map.getCenter();
          lat = c.lat;
          lng = c.lng;
        } else {
          toast('Please enter valid coordinates.');
          return;
        }
      }
      await insertHazard($('hazardType').value, lat, lng, { severity: $('hazardSeverity').value });
      if ($('reportPanel')) $('reportPanel').hidden = true;
    });

    // Reroute Modal buttons
    $('acceptRerouteBtn')?.addEventListener('click', () => {
      if (state.pendingRoute !== null) selectRoute(state.pendingRoute);
      $('rerouteModal').hidden = true;
      log('Reroute accepted', 'Operator switched to clear bypass corridor.', 'green');
      toast('Switched to alternative corridor.');
    });

    $('rejectRerouteBtn')?.addEventListener('click', () => {
      $('rerouteModal').hidden = true;
      log('Reroute declined', 'Retained current corridor by operator preference.', 'amber');
    });

    $('clearEventsBtn')?.addEventListener('click', () => {
      $('eventLog').innerHTML = '';
    });

    $('originInput')?.addEventListener('input', () => { state.start = null; });
    $('destinationInput')?.addEventListener('input', () => { state.end = null; });
  }

  async function init() {
    try {
      // Initialize Leaflet Map directly
      initLeaflet();
      setupEventListeners();

      // Refresh hazards from backend
      await refreshHazards();

      // Check telemetry hardware
      try {
        const t = await api('/api/telemetry');
        state.telemetry = t.telemetry;
        const v = t.telemetry;
        if ($('batteryVal')) $('batteryVal').textContent = v.battery_voltage ? `${v.battery_voltage} V` : '12.4 V';
        if ($('vibrationVal')) $('vibrationVal').textContent = v.vibration_g != null ? `${v.vibration_g} G` : '0.35 G';
        if (v.hardware_connected) {
          $('telemetryType').textContent = 'HARDWARE';
          $('vehicleSource').textContent = 'ARDUINO';
          $('vehicleStatus').textContent = 'Serial telemetry connected';
          log('Arduino telemetry detected', 'Hardware link active.', 'green');
        }
      } catch {}

      // Automatically detect and set current GPS location as starting point on startup
      await initCurrentLocation();

      setStatus('SYSTEM READY');
    } catch (e) {
      console.error('Initialization error:', e);
      setStatus('READY');
    }
  }

  // Start on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
