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
    placementModeArmed: false,  // If true, map clicks drop the entity
    selectedToolType: 'Obstacle',
    isYieldingWait: false,
    yieldCountdown: 0,
    clearedHazardIds: new Set(),
    trafficLayerGroup: null,
    lastHeading: null
  };

  const ROUTE_COLORS = ['#00e59b', '#4ca9ff', '#b58aff', '#ffb84d'];

  // --------------------------------------------------------------------------
  // PEDESTRIAN SAFETY STATE MACHINE (Hysteresis, Debounce, Stale Sensor Timeout)
  // --------------------------------------------------------------------------
  const PedestrianSafety = {
    CONFIDENCE_THRESHOLD: 0.70,        // 70% min confidence
    SAFETY_CLEAR_INTERVAL_MS: 2500,    // 2.5s clear confirmation debounce
    SENSOR_TIMEOUT_MS: 4000,           // 4s timeout
    
    state: 'CLEAR',                    // 'CLEAR' | 'APPROACHING' | 'STOPPED' | 'CLEARING' | 'SENSOR_UNAVAILABLE'
    clearConfirmationStartTime: 0,
    lastSensorHeartbeat: Date.now(),
    isSensorUnavailable: false,
    sensorSource: 'SIMULATED',          // 'SIMULATED' or 'REAL_VISION'
    reportedStoppedAlert: false,
    reportedResumedAlert: false,

    updateHeartbeat(source = 'SIMULATED') {
      this.lastSensorHeartbeat = Date.now();
      this.isSensorUnavailable = false;
      this.sensorSource = source;
      const badge = $('simSensorSourceBadge');
      if (badge) {
        badge.textContent = source === 'REAL_VISION' ? '[REAL SENSOR/VISION]' : '[SIMULATED SENSOR]';
        badge.className = `sim-test-badge ${source === 'REAL_VISION' ? 'source-real' : 'source-simulated'}`;
      }
    },

    setSensorUnavailable(unavailable = true) {
      this.isSensorUnavailable = unavailable;
      if (unavailable) {
        this.state = 'SENSOR_UNAVAILABLE';
        toast('⚠️ SENSOR UNAVAILABLE — PATH CLEARANCE UNCONFIRMED');
        log('Sensor Feed Timeout', 'Perception sensor offline. Retaining safe stopped state (0 km/h) in simulation.', 'red');
      } else {
        this.updateHeartbeat('SIMULATED');
        toast('✅ SENSOR FEED RESTORED');
        log('Sensor Restored', 'Perception sensor stream nominal.', 'green');
      }
    },

    isStale() {
      if (this.isSensorUnavailable) return true;
      return (Date.now() - this.lastSensorHeartbeat > this.SENSOR_TIMEOUT_MS);
    }
  };

  // --------------------------------------------------------------------------
  // ROAD BLOCKAGE & AUTOMATIC REROUTING SYSTEM
  // --------------------------------------------------------------------------
  const BlockageReroute = {
    COOLDOWN_MS: 4000,
    lastRerouteTime: 0,
    lastBlockedKeys: '',
    isRerouting: false,
    allCorridorsBlocked: false,

    async triggerReroute(reason = 'Road blockage / construction') {
      const now = Date.now();
      if (this.isRerouting) return;
      if (now - this.lastRerouteTime < this.COOLDOWN_MS) {
        return; // Cooldown to avoid reroute loops
      }

      this.isRerouting = true;
      this.lastRerouteTime = now;

      const banner = $('dynamicRerouteBanner');
      if (banner) {
        banner.hidden = false;
        banner.className = 'dynamic-reroute-banner blocked-mode';
        $('rerouteBannerTitle').textContent = 'ROAD BLOCKED — FINDING A SAFER ROUTE';
        $('rerouteBannerSubtitle').textContent = `Confirmed blockage intersecting active corridor. Recalculating route avoiding blocked segments...`;
        $('rerouteBannerBadge').textContent = 'SEARCHING BYPASS';
        if ($('retryRouteBtn')) $('retryRouteBtn').hidden = true;
      }
      toast('ROAD BLOCKED — FINDING A SAFER ROUTE');
      log('ROAD BLOCKED — FINDING A SAFER ROUTE', `${reason} on active route corridor. Initiating automatic alternative bypass search.`, 'amber');

      try {
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

        if (res.routes && res.routes.length) {
          state.routes = res.routes.map(r => {
            const c = routeCoords(r);
            return {
              ...r,
              coords: c,
              _originalCoords: c.map(pt => ({ lat: pt.lat, lng: pt.lng }))
            };
          });

          // Check if any corridor is unblocked
          const openRouteIdx = state.routes.findIndex(r => !r.is_blocked);
          if (openRouteIdx >= 0) {
            this.allCorridorsBlocked = false;
            state.selected = openRouteIdx;
            const openRoute = state.routes[openRouteIdx];

            drawRoutes(false);
            renderRoutes();
            selectRoute(openRouteIdx, false);

            if (banner) {
              banner.hidden = false;
              banner.className = 'dynamic-reroute-banner bypass-mode';
              $('rerouteBannerTitle').textContent = 'ALTERNATIVE ROUTE UPDATED';
              $('rerouteBannerSubtitle').textContent = `Switched to ${openRoute.name || `Corridor ${openRouteIdx + 1}`} avoiding blocked road segment. (${openRoute.distance_km} km · ${openRoute.duration_min} min)`;
              $('rerouteBannerBadge').textContent = 'ALTERNATIVE READY';
              if ($('retryRouteBtn')) $('retryRouteBtn').hidden = true;
            }

            // Transfer vehicle simulation coordinates
            if (state.demoTimer) {
              state.activeDemoCoords = routeCoords(openRoute);
              if (state.currentPosition) {
                let closestIdx = 0, minD = Infinity;
                for (let k = 0; k < state.activeDemoCoords.length; k++) {
                  const d = haversine(state.activeDemoCoords[k], state.currentPosition);
                  if (d < minD) { minD = d; closestIdx = k; }
                }
                state.demoIndex = closestIdx;
              }
            }

            toast('ALTERNATIVE ROUTE UPDATED');
            log('ALTERNATIVE ROUTE UPDATED', `Vehicle automatically rerouted to ${openRoute.name || `Corridor ${openRouteIdx + 1}`}.`, 'green');
          } else {
            // ALL corridors blocked!
            this.handleAllCorridorsBlocked();
          }
        } else {
          this.handleAllCorridorsBlocked();
        }
      } catch (err) {
        log('Reroute Error', err.message, 'red');
        this.handleAllCorridorsBlocked();
      } finally {
        this.isRerouting = false;
      }
    },

    handleAllCorridorsBlocked() {
      this.allCorridorsBlocked = true;
      const banner = $('dynamicRerouteBanner');
      if (banner) {
        banner.hidden = false;
        banner.className = 'dynamic-reroute-banner blocked-mode';
        $('rerouteBannerTitle').textContent = 'ROAD BLOCKED — NO ALTERNATIVE ROUTE AVAILABLE';
        $('rerouteBannerSubtitle').textContent = 'All known corridors intersect closures or construction zones. Vehicle halted at 0 km/h for safety.';
        $('rerouteBannerBadge').textContent = 'HALTED FOR SAFETY';
        if ($('retryRouteBtn')) $('retryRouteBtn').hidden = false;
      }

      $('vehicleHealth').textContent = '🛑 ALL CORRIDORS BLOCKED — VEHICLE HALTED';
      $('vehicleHealth').style.color = 'var(--red)';
      $('speedVal').textContent = '0';
      $('speedGauge').style.width = '0%';
      $('updateVal').textContent = 'ALL BLOCKED';
      $('updateVal').style.color = 'var(--red)';
      $('vehicleStatus').textContent = 'All corridors blocked. Continuing would be unsafe. Vehicle halted in simulation.';

      toast('⚠️ All corridors blocked. Vehicle halted for safety. Click "Retry Route" or clear blockages.');
      log('All Corridors Blocked', 'No safe unblocked alternative exists. Vehicle simulation halted at 0 km/h.', 'red');
    }
  };


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

    // Default: OpenStreetMap Standard (Crisp, accurate, 100% free, zero watermark)
    state.currentTileStyle = 'osm-standard';
    state.tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors'
    }).addTo(state.map);

    $('mapProvider').textContent = 'LEAFLET ACTIVE (OPENSTREETMAP NATIVE)';
    $('mapDataBadge').textContent = 'ENGINE: LEAFLET (OPENSTREETMAP NATIVE - ONLINE)';
    $('apiStatus').textContent = 'OSRM & LEAFLET ENGINE ACTIVE';
    $('apiStatusSub').textContent = 'Zero-watermark high-resolution road corridors loaded.';

    // Map Click Handler (Entity Placement or Origin/Destination selection)
    state.map.on('click', handleMapClick);

    // Keyboard shortcut ESC to cancel placement
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && state.placementMode) {
        cancelPlacementMode();
        toast('Placement mode cancelled.');
      }
    });

    window.roadguardMapInstance = state.map;
    log('Leaflet Engine Ready', 'High-performance OpenStreetMap interactive map cockpit loaded.', 'green');
  }

  const MAP_STYLES = [
    {
      id: 'osm-standard',
      name: 'OpenStreetMap Standard (Clear)',
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      className: '',
      attr: '© OpenStreetMap contributors'
    },
    {
      id: 'osm-dark',
      name: 'Tactical Dark Cockpit (OSM Dark)',
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      className: 'dark-tactical-tiles',
      attr: '© OpenStreetMap contributors'
    },
    {
      id: 'satellite',
      name: 'Esri Satellite Aerial Imagery',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      className: '',
      attr: 'Tiles © Esri, Maxar, Earthstar Geographics'
    }
  ];

  let currentStyleIdx = 0;

  function toggleMapTheme() {
    if (!state.map) return;
    currentStyleIdx = (currentStyleIdx + 1) % MAP_STYLES.length;
    const style = MAP_STYLES[currentStyleIdx];
    if (state.tiles) {
      state.map.removeLayer(state.tiles);
    }
    state.tiles = L.tileLayer(style.url, {
      maxZoom: 19,
      className: style.className,
      attribution: style.attr
    }).addTo(state.map);
    state.currentTileStyle = style.id;
    toast(`Map style: ${style.name}`);
    log('Map theme changed', `${style.name} active with zero watermark.`);
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
    state.placementModeArmed = true;

    // Update active button state across toolbar and sidebar
    document.querySelectorAll('.entity-tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === type);
    });
    document.querySelectorAll('.sidebar-entity-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === type);
    });

    const toggleLabel = $('placementToggleLabel');
    if (toggleLabel) toggleLabel.textContent = `Placing: ${type}`;
    $('sidebarTogglePlacement')?.classList.add('active');

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
    state.placementModeArmed = false;
    document.querySelectorAll('.entity-tool-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.sidebar-entity-btn').forEach(btn => btn.classList.remove('active'));
    const banner = $('mapPlacementBanner');
    if (banner) banner.hidden = true;
    const mapArea = document.querySelector('.map-area');
    if (mapArea) mapArea.classList.remove('crosshair-mode');
    const toggleLabel = $('placementToggleLabel');
    if (toggleLabel) toggleLabel.textContent = 'Click Map to Place';
    $('sidebarTogglePlacement')?.classList.remove('active');
  }

  async function quickAddEntity(type) {
    state.selectedToolType = type;

    // If routes are not calculated yet, calculate first
    if (!state.routes.length) {
      toast('Calculating road corridor first...');
      await calculateRoutes();
    }

    if (!state.routes.length) {
      toast('Please enter origin and destination or calculate a route.');
      return;
    }

    const currentRoute = state.routes[state.selected] || state.routes[0];
    const coords = (currentRoute._originalCoords && currentRoute._originalCoords.length)
      ? currentRoute._originalCoords
      : routeCoords(currentRoute);

    if (coords.length < 4) {
      toast('Route corridor geometry too short.');
      return;
    }

    // Determine target location along corridor:
    // If vehicle is driving, place 120m-220m ahead; otherwise place at ~38% along route!
    let targetIdx = Math.floor(coords.length * 0.38);
    if (state.demoTimer && state.demoIndex > 0) {
      targetIdx = Math.min(coords.length - 2, state.demoIndex + 14);
    }

    const targetPoint = coords[targetIdx];
    const lat = targetPoint.lat;
    const lng = targetPoint.lng;

    const hazard = await insertHazard(type, lat, lng, {
      description: `${type} placed on ${currentRoute.name || `Corridor ${state.selected + 1}`}`
    });

    if (state.map && hazard) {
      state.map.setView([lat, lng], 15);
      if (state.hazardMarkers[hazard.id]?.marker) {
        state.hazardMarkers[hazard.id].marker.openPopup();
      }
    }

    if (type === 'Obstacle') {
      toast('⚠️ Obstacle placed: Vehicle will slow to 32 km/h for safe passage (no reroute needed).');
    } else if (type === 'Pedestrian Moving') {
      toast('🚶 Moving Pedestrian placed: Vehicle will decelerate to 0 km/h, stop and wait until crossed!');
    } else if (type === 'Animal Crossing') {
      toast('🐕 Stray Animal placed: Vehicle will come to a complete stop (0 km/h) and wait.');
    } else if (type === 'Construction Working') {
      toast('🚧 Construction Work Zone placed: Corridor blocked -> Automatic reroute switching to bypass!');
    } else if (type === 'Road Blocked') {
      toast('⛔ Road Blockage placed: Corridor impassable -> Automatic reroute switching to bypass!');
    }

    return hazard;
  }

  async function handleMapClick(e) {
    let lat = e.latlng.lat;
    let lng = e.latlng.lng;

    // 1. If currently in entity placement mode, snap accurately to nearest road corridor point
    if (state.placementMode) {
      const type = state.placementMode;
      cancelPlacementMode();

      // Snap accurately onto active route if clicked within 350m of roadway corridor
      if (state.routes.length && state.routes[state.selected]) {
        const coords = (state.routes[state.selected]._originalCoords && state.routes[state.selected]._originalCoords.length)
          ? state.routes[state.selected]._originalCoords
          : routeCoords(state.routes[state.selected]);
        let minD = Infinity;
        let snapPoint = null;
        for (let i = 0; i < coords.length - 1; i++) {
          const res = pointToSegmentDistance({ lat, lng }, coords[i], coords[i + 1]);
          if (res.distKm < minD) {
            minD = res.distKm;
            snapPoint = res.proj;
          }
        }
        if (minD < 0.35 && snapPoint) {
          lat = snapPoint.lat;
          lng = snapPoint.lng;
        }
      }

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
      description = description || 'Pedestrian crossing roadway (Dynamic motion - Vehicle yields)';
    } else if (type === 'Animal Crossing' || type === 'Stray Animal') {
      severity = 'High';
      description = description || 'Stray animal / cattle crossing roadway (Vehicle stops & waits)';
    } else if (type === 'Construction Working') {
      severity = 'Medium';
      description = description || 'Active work zone · Lane restriction & machinery';
    } else if (type === 'Obstacle') {
      severity = 'Medium';
      description = description || 'Roadway obstacle (Pothole / Debris anomaly)';
    }

    const isMoving = (type === 'Pedestrian Moving' || type === 'Animal Crossing' || type === 'Stray Animal');

    try {
      let res;
      try {
        res = await api('/api/hazards', {
          lat,
          lng,
          type,
          severity,
          description,
          is_moving: isMoving,
          speed_kmh: isMoving ? (type === 'Pedestrian Moving' ? 4.5 : 3.0) : 0,
          radius_m: type === 'Construction Working' ? 120 : (type === 'Road Blocked' ? 60 : 35)
        });
      } catch (e) {
        res = {
          hazard: {
            id: `h-${Date.now()}`,
            lat,
            lng,
            type,
            severity,
            description: description || `${type} active on corridor`,
            is_moving: isMoving,
            speed_kmh: isMoving ? 4.5 : 0,
            radius_m: type === 'Construction Working' ? 120 : (type === 'Road Blocked' ? 60 : 35),
            status: 'ACTIVE'
          }
        };
      }

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
      log('Perception Stack: Radar/Camera', 'Target classified: Pedestrian (Walking motion detected - Vehicle will yield).', 'green');
    } else if (type === 'Animal Crossing' || type === 'Stray Animal') {
      log('Perception Stack: Camera/LiDAR', 'Target classified: Stray Animal / Cattle Crossing (Vehicle will stop & wait).', 'amber');
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
    } else if (h.type === 'Animal Crossing' || h.type === 'Stray Animal') {
      markerClass = 'rg-marker-animal';
      iconHtml = `<div class="rg-marker-wrap rg-marker-animal"><span class="rg-pulse-ring"></span><div class="rg-marker-pin">🐕</div></div>`;
      circleColor = '#a78bfa';
      circleRadius = 40;
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
          ${h.type === 'Pedestrian Moving' ? '<div><strong>Speed:</strong> ~4.5 km/h (Moving crosswalk - Vehicle yields)</div>' : ''}
          ${(h.type === 'Animal Crossing' || h.type === 'Stray Animal') ? '<div><strong>Speed:</strong> ~3.0 km/h (Stray Animal - Vehicle stops & waits)</div>' : ''}
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

    // Pedestrian and Stray Animal dynamic motion animation!
    let animTimer = null;
    if (h.type === 'Pedestrian Moving' || h.type === 'Animal Crossing' || h.type === 'Stray Animal' || h.is_moving) {
      h.isCrossingNow = true;
      h.hasClearedRoad = false;
      let step = 0;
      const baseLat = h.lat;
      const baseLng = h.lng;
      let heading = (h.heading || 90) * Math.PI / 180;

      // Compute perpendicular crossing heading relative to closest road segment if on route
      if (state.routes.length && state.routes[state.selected]) {
        const coords = routeCoords(state.routes[state.selected]);
        let minD = Infinity;
        let segIdx = -1;
        for (let i = 0; i < coords.length - 1; i++) {
          const res = pointToSegmentDistance(h, coords[i], coords[i + 1]);
          if (res.distKm < minD) { minD = res.distKm; segIdx = i; }
        }
        if (segIdx >= 0 && minD < 0.25) {
          const dx = coords[segIdx + 1].lng - coords[segIdx].lng;
          const dy = coords[segIdx + 1].lat - coords[segIdx].lat;
          const roadAngle = Math.atan2(dy, dx);
          heading = roadAngle + Math.PI / 2; // Perpendicular across road
        }
      }

      const stepAmp = 0.00032; // ~32 meters crosswalk width

      animTimer = setInterval(() => {
        step += 0.07;
        const wave = Math.sin(step);
        // When wave reaches peak sidewalk (> 0.65) or trough sidewalk (< -0.65), pedestrian has cleared road
        if (Math.abs(wave) > 0.65) {
          h.hasClearedRoad = true;
          h.isCrossingNow = false;
        } else {
          h.hasClearedRoad = false;
          h.isCrossingNow = true;
        }

        const offset = wave * stepAmp;
        const curLat = baseLat + offset * Math.cos(heading);
        const curLng = baseLng + offset * Math.sin(heading);
        marker.setLatLng([curLat, curLng]);
        circle.setLatLng([curLat, curLng]);
        h.lat = curLat;
        h.lng = curLng;

        // Proximity detection with simulated vehicle
        if (state.currentPosition && state.demoTimer) {
          const d = haversine(state.currentPosition, { lat: curLat, lng: curLng });
          if (d < 0.09) { // under 90 meters
            if (h.isCrossingNow) {
              $('vehicleHealth').textContent = `🛑 STOPPED (0 km/h) — WAITING FOR ${h.type.toUpperCase()} TO CROSS`;
              $('vehicleHealth').style.color = 'var(--red)';
              $('speedVal').textContent = '0';
              $('speedGauge').style.width = '0%';
            } else if (h.hasClearedRoad && !state.isYieldingWait) {
              $('vehicleHealth').textContent = `✅ ${h.type.toUpperCase()} ON SIDEWALK (ROAD CLEAR)`;
              $('vehicleHealth').style.color = 'var(--green)';
            }
          }
        }
      }, 300);
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
      else if (h.type === 'Animal Crossing' || h.type === 'Stray Animal') symbol = '🐕';
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
    } else if (scenarioKey === 'animal') {
      const pt = coords[Math.floor(coords.length * 0.42)];
      await insertHazard('Animal Crossing', pt.lat, pt.lng, {
        description: 'Review Demo: Stray cattle / dog crossing corridor (Vehicle stops & waits)'
      });
      state.map.setView([pt.lat, pt.lng], 15);
      toast('🎬 Scenario: Stray Animal Crossing activated! Vehicle will stop & wait.');
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

  function drawRoutes(fitBounds = false) {
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

      line.on('click', e => {
        if (state.placementMode) {
          handleMapClick(e);
        } else {
          selectRoute(i, false);
        }
      });
      state.routeLayers.push(line);
    });

    if (state.routeLayers.length && fitBounds) {
      const group = L.featureGroup(state.routeLayers);
      state.map.fitBounds(group.getBounds().pad(0.12));
    }
  }

  function selectRoute(i, fitBounds = false) {
    if (!state.routes[i]) return;
    state.selected = i;
    drawRoutes(fitBounds);
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
      const otherBlocked = state.routes.some((other, oi) => oi !== i && other.is_blocked);
      const isBypassActive = (i === state.selected && otherBlocked && !r.is_blocked);

      let badgeText = `OPTION ${i + 1}`;
      let badgeStyle = '';
      if (r.is_blocked) {
        badgeText = 'BLOCKED';
        badgeStyle = 'background:#471216;color:#ff858b;border:1px solid #ff5e66;';
      } else if (isBypassActive) {
        badgeText = 'ACTIVE BYPASS';
        badgeStyle = 'background:#0d3622;color:#00e59b;border:1px solid #00e59b;';
      } else if (r.is_detoured) {
        badgeText = 'DETOURED';
        badgeStyle = 'background:#0d3622;color:#00e59b;';
      } else if (r.is_recommended) {
        badgeText = 'RECOMMENDED';
      }

      card.innerHTML = `
        <div class="route-card-head">
          <span class="route-name"></span>
          <span class="route-badge" style="${badgeStyle}">${badgeText}</span>
        </div>
        <div class="route-metrics">
          <div><strong>${r.duration_min} min</strong><small>Estimated time</small></div>
          <div><strong>${r.distance_km} km</strong><small>Distance</small></div>
        </div>
        <div class="route-meta"></div>
      `;

      card.querySelector('.route-name').textContent = r.name || `Corridor ${i + 1}`;
      
      let metaText = r.recommendation_reason || r.traffic_condition || 'Active road corridor';
      if (r.is_blocked) {
        metaText = '⛔ Obstructed: Construction / obstacle on corridor (Rerouted)';
      } else if (isBypassActive) {
        metaText = '✅ Active Bypass: Safe corridor avoiding road obstruction';
      } else if (r.is_detoured) {
        metaText = '⚡ Dynamic obstacle detour active';
      }
      card.querySelector('.route-meta').textContent = metaText;

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

      drawRoutes(true);
      renderRoutes();
      selectRoute(state.selected, false);
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
    let thresholdKm = 0.15; // 150m for road obstacles
    if (h.type === 'Construction Working') thresholdKm = 0.22; // 220m for construction zone
    else if (h.type === 'Road Blocked') thresholdKm = 0.20;     // 200m for road block
    else if (h.type === 'Pedestrian Moving') thresholdKm = 0.09; // 90m for pedestrians
    else if (h.type === 'Animal Crossing' || h.type === 'Stray Animal') thresholdKm = 0.10; // 100m for animals

    for (let i = 0; i < coords.length - 1; i++) {
      const res = pointToSegmentDistance(h, coords[i], coords[i + 1]);
      if (res.distKm <= thresholdKm) {
        return true;
      }
    }
    return false;
  }

  function isCorridorBlockage(h) {
    if (!h || !h.type) return false;
    const t = String(h.type).toLowerCase();
    return t.includes('construction') || t.includes('road blocked') || t.includes('road closure') || t.includes('barricade');
  }

  // --------------------------------------------------------------------------
  // DYNAMIC OBSTACLE AVOIDANCE & ROUTE BENDING
  // When physical road obstruction occurs and no alternative corridor exists -> Detour around obstacle
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

    // Only physical static blockages (Construction, Road Blocked) cause lane geometry deflection
    const hits = state.hazards.filter(h => 
      isCorridorBlockage(h) && hazardTouchesRoute(h, currentRoute)
    );
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

      drawRoutes(false);
      renderRoutes();
      return false;
    }

    let detouredCoords = baseCoords.map(c => ({ lat: c.lat, lng: c.lng }));
    let blockedSegments = [];
    let maxClearanceMeters = 8.0;

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

      const thresholdKm = (h.type === 'Construction Working') ? 0.08 : ((h.type === 'Road Blocked') ? 0.07 : 0.05);

      if (bestSegmentIdx >= 0 && minDistanceKm <= thresholdKm && bestProj) {
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

          // Determine which side the hazard is on relative to the road centerline
          const hx = h.lng - bestProj.lng;
          const hy = h.lat - bestProj.lat;
          const dot = nx * hx + ny * hy;

          // Steer in opposite direction of hazard into adjacent open lane/shoulder
          const steerSign = dot >= 0 ? -1 : 1;

          // Realistic lateral lane bypass in degrees (~6m to 9m on roadway)
          let lateralOffsetDeg = 0.000065; // ~7.2 meters
          if (h.type === 'Construction Working') {
            lateralOffsetDeg = 0.000080; // ~8.9 meters
            maxClearanceMeters = 8.9;
          } else if (h.type === 'Road Blocked') {
            lateralOffsetDeg = 0.000090; // ~10.0 meters
            maxClearanceMeters = 10.0;
          } else {
            lateralOffsetDeg = 0.000055; // ~6.1 meters
            maxClearanceMeters = 6.1;
          }

          // Capture the exact obstructed 25m span for red warning visualization
          const spanDeg = 0.00028; // ~30m along roadway
          const pEntry = { lat: bestProj.lat - ty * spanDeg, lng: bestProj.lng - tx * spanDeg };
          const pExit = { lat: bestProj.lat + ty * spanDeg, lng: bestProj.lng + tx * spanDeg };
          blockedSegments.push([pEntry, bestProj, pExit]);

          // Smoothly deflect vertices within influence zone using a Gaussian bell curve
          const influenceRadiusKm = 0.035; // 35 meters along road
          for (let k = 0; k < detouredCoords.length; k++) {
            const ptDistKm = haversine(detouredCoords[k], bestProj);
            if (ptDistKm < influenceRadiusKm) {
              const u = ptDistKm / influenceRadiusKm;
              // Smooth bell curve envelope: 1 at center, tapering smoothly to 0 at edges
              const bellFactor = Math.cos(u * Math.PI * 0.5) ** 2;
              detouredCoords[k].lat += ny * lateralOffsetDeg * bellFactor * steerSign;
              detouredCoords[k].lng += nx * lateralOffsetDeg * bellFactor * steerSign;
            }
          }
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

    // Draw red dashed line for the obstructed roadway section
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
      }).addTo(state.map).bindTooltip('⚠️ Obstructed lane: Vehicle steered into adjacent lane', { sticky: true });
    }

    // Show dynamic reroute banner
    if (rerouteBanner) {
      rerouteBanner.hidden = false;
      rerouteBanner.classList.remove('blocked-mode');
      $('rerouteBannerTitle').textContent = 'DYNAMIC REROUTE ACTIVE';
      const names = hits.map(h => h.type).join(', ');
      $('rerouteBannerSubtitle').textContent = `Vehicle path altered: Steering safely around ${names} (+${maxClearanceMeters.toFixed(1)}m lateral lane clearance)`;
      $('rerouteBannerBadge').textContent = 'SAFE BYPASS';
    }

    // Redraw active route WITHOUT changing map zoom or viewport bounds
    drawRoutes(false);
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

    // 1. Evaluate obstruction status across all available corridors:
    // CORRIDOR REROUTING APPLIES ONLY TO CONSTRUCTION OR ROAD BLOCKED!
    state.routes.forEach((r, idx) => {
      const touchesObstruction = state.hazards.some(h => 
        isCorridorBlockage(h) && hazardTouchesRoute(h, r)
      );
      r.is_blocked = touchesObstruction;
    });

    const hits = state.hazards.filter(h => hazardTouchesRoute(h, currentRoute));
    const hasBlockage = hits.some(h => isCorridorBlockage(h));

    // 2. If current corridor is obstructed by construction or road blockage -> TRIGGER REROUTE!
    if (hasBlockage) {
      $('riskMetric').textContent = 'BLOCKED';
      $('riskMetric').style.color = 'var(--red)';
      $('riskSub').textContent = `${hits.filter(isCorridorBlockage).map(h => h.type).join(', ')} on active route`;

      const rerouteMode = $('rerouteMode') ? $('rerouteMode').value : 'automatic';
      if (rerouteMode === 'automatic') {
        BlockageReroute.triggerReroute(hits.filter(isCorridorBlockage).map(h => h.type).join(', '));
      } else {
        const alternate = state.routes.findIndex((r, i) => i !== state.selected && !r.is_blocked);
        if (alternate >= 0) {
          state.pendingRoute = alternate;
          $('rerouteMessage').textContent = `Construction / road blockage detected on ${currentRoute.name || 'this corridor'}. Alternative corridor ${state.routes[alternate].name || `Corridor ${alternate + 1}`} is clear and safe. Switch route?`;
          $('rerouteModal').hidden = false;
          log('Alternative corridor ready', 'Waiting for operator confirmation.', 'amber');
        } else {
          BlockageReroute.handleAllCorridorsBlocked();
        }
      }
      return;
    } else {
      // Current route has NO construction or road blocks -> NO REROUTE!
      currentRoute.is_blocked = false;
      BlockageReroute.allCorridorsBlocked = false;

      // Restore route geometry if previously detoured
      if (currentRoute.is_detoured) {
        applyDynamicObstacleAvoidance();
      }

      const banner = $('dynamicRerouteBanner');

      // Check if pedestrian or animal is crossing on current corridor
      const pedCrossing = hits.find(h => h.type === 'Pedestrian Moving' || h.type === 'Animal Crossing' || h.type === 'Stray Animal');
      const roadObstacle = hits.find(h => h.type === 'Obstacle' || h.type === 'Pothole' || h.type === 'Road crack');

      if (pedCrossing) {
        $('riskMetric').textContent = 'CROSSWALK ACTIVE';
        $('riskMetric').style.color = '#38bdf8';
        $('riskSub').textContent = `${pedCrossing.type} ahead · Vehicle stops (0 km/h) & yields · No corridor reroute`;
        if (banner) banner.hidden = true;
      } else if (roadObstacle) {
        $('riskMetric').textContent = 'ROAD OBSTACLE';
        $('riskMetric').style.color = 'var(--amber)';
        $('riskSub').textContent = `${roadObstacle.type} detected · Safe slowdown (32 km/h) · Corridor retained`;
        if (banner) banner.hidden = true;
      } else {
        // Check if another corridor is blocked (meaning vehicle is operating safely on bypass)
        const blockedOther = state.routes.find((r, i) => i !== state.selected && r.is_blocked);
        if (blockedOther) {
          $('riskMetric').textContent = 'SAFE BYPASS';
          $('riskMetric').style.color = 'var(--green)';
          $('riskSub').textContent = `Bypassing obstruction on ${blockedOther.name || 'other corridor'}`;
          if (banner) {
            banner.hidden = false;
            banner.className = 'dynamic-reroute-banner bypass-mode';
            $('rerouteBannerTitle').textContent = `ALTERNATIVE ROUTE UPDATED`;
            $('rerouteBannerSubtitle').textContent = `Vehicle operating on ${currentRoute.name || 'clear corridor'} to safely circumvent road construction/obstacles.`;
            $('rerouteBannerBadge').textContent = 'SAFE BYPASS ACTIVE';
            if ($('retryRouteBtn')) $('retryRouteBtn').hidden = true;
          }
        } else {
          $('riskMetric').textContent = 'LOW';
          $('riskMetric').style.color = 'var(--green)';
          $('riskSub').textContent = 'No hazards intersecting active corridor';
          if (banner) banner.hidden = true;
        }
      }
    }
  }


  // --------------------------------------------------------------------------
  // KINEMATICS & AUTONOMOUS VEHICLE DRIVE CONTROLLER
  // --------------------------------------------------------------------------
  function calculateBearing(p1, p2) {
    if (!p1 || !p2) return 0;
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const lat1 = p1.lat * Math.PI / 180;
    const lat2 = p2.lat * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(dLng);
    let brng = Math.atan2(y, x) * 180 / Math.PI;
    return (brng + 360) % 360;
  }

  function toggleAutonomousDrive() {
    if (state.demoTimer) {
      pauseAutonomousDrive();
    } else {
      startAutonomousDrive();
    }
  }

  function pauseAutonomousDrive() {
    if (state.demoTimer) {
      clearInterval(state.demoTimer);
      state.demoTimer = null;
    }
    updateDriveButtonLabels(false);
    toast('Autonomous drive paused.');
    log('Drive paused', 'Vehicle paused along active corridor.', 'amber');
  }

  function stopAutonomousDrive() {
    if (state.demoTimer) {
      clearInterval(state.demoTimer);
      state.demoTimer = null;
    }
    state.demoIndex = 0;
    state.isYieldingWait = false;
    state.clearedHazardIds.clear();
    state.lastHeading = null;
    updateDriveButtonLabels(false);

    // Reset vehicle to route start
    if (state.routes.length && state.routes[state.selected]) {
      const coords = routeCoords(state.routes[state.selected]);
      if (coords.length) {
        state.currentPosition = coords[0];
        updateVehicleMarker(coords[0].lat, coords[0].lng);
        if (state.map) state.map.panTo([coords[0].lat, coords[0].lng]);
      }
    }

    $('speedVal').textContent = '0';
    $('speedGauge').style.width = '0%';
    $('headingVal').textContent = '0.0°';
    $('batteryVal').textContent = '0.0°';
    $('vibrationVal').textContent = '0.0 m/s²';
    $('updateVal').textContent = 'STANDBY';
    $('updateVal').style.color = 'var(--text-primary)';
    $('vehicleHealth').textContent = 'AUTONOMOUS STANDBY';
    $('vehicleHealth').style.color = 'var(--text-primary)';
    $('vehicleStatus').textContent = 'Drive stopped';

    toast('Autonomous drive stopped and reset to origin.');
    log('Drive reset', 'Vehicle returned to departure origin.', 'green');
  }

  function updateDriveButtonLabels(isRunning) {
    const demoBtn = $('demoBtn');
    const trackBtn = $('trackBtn');
    if (demoBtn) {
      demoBtn.textContent = isRunning ? '⏸ Pause Drive' : '▶ Start Drive';
      demoBtn.classList.toggle('active-drive', isRunning);
    }
    if (trackBtn) {
      trackBtn.textContent = isRunning ? '⏸ Pause Route' : '▶ Start GPS Route';
      trackBtn.classList.toggle('active-drive', isRunning);
    }
  }

  function startAutonomousDrive() {
    if (state.demoTimer) return;

    if (!state.routes.length) {
      toast('Calculate a route first before starting autonomous drive.');
      calculateRoutes();
      return;
    }

    const currentRoute = state.routes[state.selected] || state.routes[0];
    state.activeDemoCoords = routeCoords(currentRoute);
    if (state.activeDemoCoords.length < 2) {
      toast('Active route corridor has insufficient coordinates.');
      return;
    }

    if (!state.demoIndex || state.demoIndex >= state.activeDemoCoords.length) {
      state.demoIndex = 0;
      state.clearedHazardIds.clear();
      state.isYieldingWait = false;
    }

    updateDriveButtonLabels(true);
    toast('▶ Autonomous drive started along corridor.');
    log('Autonomous drive started', `Simulation driving along ${currentRoute.name || `Corridor ${state.selected + 1}`}.`, 'green');

    state.demoTimer = setInterval(() => {
      const coords = state.activeDemoCoords;
      if (state.demoIndex >= coords.length) {
        clearInterval(state.demoTimer);
        state.demoTimer = null;
        updateDriveButtonLabels(false);
        $('vehicleHealth').textContent = 'DESTINATION REACHED';
        $('vehicleHealth').style.color = 'var(--green)';
        $('speedVal').textContent = '0';
        $('speedGauge').style.width = '0%';
        $('vibrationVal').textContent = '0.0 m/s²';
        $('updateVal').textContent = 'ARRIVED';
        $('updateVal').style.color = 'var(--green)';
        $('batteryVal').textContent = '0.0°';
        log('Route completed', 'Vehicle reached target destination safely.', 'green');
        toast('🏁 Autonomous drive completed! Destination reached.');
        return;
      }

      const p = coords[state.demoIndex];
      const nextP = coords[state.demoIndex + 1] || p;
      state.currentPosition = p;

      // Compute heading bearing & steering angle delta
      const heading = calculateBearing(p, nextP);
      let steerAngle = 0;
      if (state.lastHeading !== null) {
        let diff = heading - state.lastHeading;
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;
        steerAngle = Math.max(-28, Math.min(28, diff * 1.5));
      }
      state.lastHeading = heading;

      let targetSpeed = 42;
      let accel = 0.2;

      // 0A. Check if all corridors are blocked
      if (BlockageReroute.allCorridorsBlocked) {
        $('vehicleHealth').textContent = '🛑 ALL CORRIDORS BLOCKED — VEHICLE HALTED';
        $('vehicleHealth').style.color = 'var(--red)';
        $('speedVal').textContent = '0';
        $('speedGauge').style.width = '0%';
        $('updateVal').textContent = 'ALL BLOCKED';
        $('updateVal').style.color = 'var(--red)';
        $('vehicleStatus').textContent = 'All route corridors blocked. Vehicle simulation halted safely.';
        updateVehicleMarker(p.lat, p.lng);
        return;
      }

      // 0B. Check sensor liveness / timeout
      if (PedestrianSafety.isStale()) {
        $('vehicleHealth').textContent = '🛑 SENSOR TIMEOUT / STALE — VEHICLE HALTED SAFELY';
        $('vehicleHealth').style.color = 'var(--red)';
        $('speedVal').textContent = '0';
        $('speedGauge').style.width = '0%';
        $('batteryVal').textContent = '0.0°';
        $('vibrationVal').textContent = '0.0 m/s²';
        $('updateVal').textContent = 'SENSOR TIMEOUT';
        $('updateVal').style.color = 'var(--red)';
        $('vehicleStatus').textContent = 'Sensor feed stale/unavailable: Retaining safe stop (0 km/h). Road clearance unverified.';
        updateVehicleMarker(p.lat, p.lng);
        return;
      }

      // 1. High-priority safety check: Crossing pedestrian or animal in path ahead of vehicle
      const crossingHazard = state.hazards.find(h => {
        const isPedOrAnimal = (h.type === 'Pedestrian Moving' || h.type === 'Animal Crossing' || h.type === 'Stray Animal');
        if (!isPedOrAnimal) return false;
        if (state.clearedHazardIds && state.clearedHazardIds.has(h.id)) return false;
        const distKm = haversine(h, p);
        return distKm < 0.12; // within 120 meters ahead
      });

      if (crossingHazard) {
        const confidence = crossingHazard.confidence !== undefined ? crossingHazard.confidence : 0.95;
        const isOccupied = (!crossingHazard.hasClearedRoad || crossingHazard.isCrossingNow);

        if (confidence < PedestrianSafety.CONFIDENCE_THRESHOLD || isOccupied) {
          // PEDESTRIAN DETECTED IN CROSSING ZONE -> COMMAND DECELERATION & 0 km/h STOP!
          targetSpeed = 0;
          accel = -2.5;
          state.isYieldingWait = true;
          PedestrianSafety.clearConfirmationStartTime = 0; // Reset debounce timer
          PedestrianSafety.reportedResumedAlert = false;

          $('vehicleHealth').textContent = `🛑 PEDESTRIAN DETECTED — VEHICLE STOPPED`;
          $('vehicleHealth').style.color = 'var(--red)';
          $('speedVal').textContent = '0';
          $('speedGauge').style.width = '0%';
          $('batteryVal').textContent = '0.0°';
          $('vibrationVal').textContent = '0.0 m/s²';
          $('headingVal').textContent = `${heading.toFixed(1)}°`;
          $('updateVal').textContent = 'YIELDING (CROSSWALK)';
          $('updateVal').style.color = '#38bdf8';
          $('vehicleStatus').textContent = `PEDESTRIAN DETECTED — VEHICLE STOPPED (0 km/h) [${PedestrianSafety.sensorSource}]`;

          if (!PedestrianSafety.reportedStoppedAlert) {
            PedestrianSafety.reportedStoppedAlert = true;
            toast(`🛑 PEDESTRIAN DETECTED — VEHICLE STOPPED`);
            log('PEDESTRIAN DETECTED — VEHICLE STOPPED', `Pedestrian detected in crossing zone. Decelerated to 0 km/h stop before crossing. [${PedestrianSafety.sensorSource}]`, 'red');
          }

          updateVehicleMarker(p.lat, p.lng);
          return; // DO NOT ADVANCE VEHICLE POSITION WHILE CROSSING ZONE IS OCCUPIED!
        } else if (state.isYieldingWait) {
          // Pedestrian has cleared roadway! Enforce 2.5s hysteresis / debounce safety interval
          const now = Date.now();
          if (!PedestrianSafety.clearConfirmationStartTime) {
            PedestrianSafety.clearConfirmationStartTime = now;
          }

          const elapsedClearTime = now - PedestrianSafety.clearConfirmationStartTime;
          if (elapsedClearTime < PedestrianSafety.SAFETY_CLEAR_INTERVAL_MS) {
            // Still in safety confirmation interval — HOLD 0 km/h STOP!
            targetSpeed = 0;
            accel = 0.0;
            const remainingSec = ((PedestrianSafety.SAFETY_CLEAR_INTERVAL_MS - elapsedClearTime) / 1000).toFixed(1);
            $('vehicleHealth').textContent = `⏳ CONFIRMING CROSSING CLEAR (${remainingSec}s)`;
            $('vehicleHealth').style.color = 'var(--amber)';
            $('speedVal').textContent = '0';
            $('speedGauge').style.width = '0%';
            $('updateVal').textContent = 'SAFETY CONFIRMATION';
            $('updateVal').style.color = 'var(--amber)';
            $('vehicleStatus').textContent = `Crossing zone clear: Confirming safety interval (${remainingSec}s remaining) before resume.`;
            updateVehicleMarker(p.lat, p.lng);
            return;
          } else {
            // Confirmed clear for full safety interval! Safe to resume!
            state.isYieldingWait = false;
            PedestrianSafety.clearConfirmationStartTime = 0;
            PedestrianSafety.reportedStoppedAlert = false;
            state.clearedHazardIds.add(crossingHazard.id);
            targetSpeed = 42;
            accel = 1.6; // Gentle resume acceleration

            if (!PedestrianSafety.reportedResumedAlert) {
              PedestrianSafety.reportedResumedAlert = true;
              toast(`✅ CROSSING CLEAR — RESUMING`);
              log('CROSSING CLEAR — RESUMING', `Crossing zone confirmed clear for ${PedestrianSafety.SAFETY_CLEAR_INTERVAL_MS/1000}s safety interval. Resuming corridor drive at 42 km/h.`, 'green');
            }
          }
        }
      }


      // 2. Check for nearby road obstacles (potholes, debris, road anomalies)
      const nearObstacle = state.hazards.find(h => {
        const isObs = (h.type === 'Obstacle' || h.type === 'Pothole' || h.type === 'Road crack' || h.type === 'Slow Vehicle');
        return isObs && haversine(h, p) < 0.15;
      });

      if (nearObstacle) {
        // VEHICLE SLOWS DOWN TO SAFE PASSING SPEED (32 km/h) — CORRIDOR IS NOT CHANGED!
        targetSpeed = 32;
        accel = -0.8;
        $('vehicleHealth').textContent = 'TRAVELLING (SAFE OBSTACLE CLEARANCE 32 km/h)';
        $('vehicleHealth').style.color = 'var(--amber)';
        $('updateVal').textContent = 'SLOWDOWN (OBSTACLE)';
        $('updateVal').style.color = 'var(--amber)';
        $('vehicleStatus').textContent = `Approaching road obstacle. Speed moderated to 32 km/h for safe clearance.`;
      } else {
        targetSpeed = 42;
        accel = 0.2;
        $('vehicleHealth').textContent = state.routes[state.selected]?.is_detoured ? 'DETOUR GUIDANCE (42 km/h)' : 'MOVING (AUTONOMOUS 42 km/h)';
        $('vehicleHealth').style.color = 'var(--green)';
        $('updateVal').textContent = 'NOMINAL (CRUISE)';
        $('updateVal').style.color = 'var(--green)';
        $('vehicleStatus').textContent = 'Active route corridor nominal';
      }

      // Advance vehicle to next waypoint
      state.demoIndex++;

      // Update telemetry readouts in Cockpit right rail
      $('speedVal').textContent = String(targetSpeed);
      $('speedGauge').style.width = `${Math.min(100, targetSpeed * 2.2)}%`;
      $('headingVal').textContent = `${heading.toFixed(1)}°`;
      $('batteryVal').textContent = `${steerAngle >= 0 ? '+' : ''}${steerAngle.toFixed(1)}°`;
      $('vibrationVal').textContent = `${accel >= 0 ? '+' : ''}${accel.toFixed(1)} m/s²`;
      $('vehicleSource').textContent = 'AUTONOMOUS DRIVE';
      $('telemetryType').textContent = 'SOFTWARE ACTIVE';

      // Update vehicle marker on Leaflet map
      updateVehicleMarker(p.lat, p.lng);

      if (state.follow && state.map) {
        state.map.panTo([p.lat, p.lng]);
      }
    }, 420);
  }

  // --------------------------------------------------------------------------
  // CONGESTION TRAFFIC LAYER (Visual colored polylines)
  // --------------------------------------------------------------------------
  function toggleTrafficLayer() {
    state.traffic = !state.traffic;
    $('trafficBtn')?.classList.toggle('active', state.traffic);

    if (!state.trafficLayerGroup && state.map) {
      state.trafficLayerGroup = L.layerGroup().addTo(state.map);
    }

    if (!state.traffic) {
      if (state.trafficLayerGroup) state.trafficLayerGroup.clearLayers();
      toast('Congestion perception layer disabled.');
      log('Traffic layer toggled', 'Congestion overlay removed from map.', 'amber');
      return;
    }

    if (!state.routes.length || !state.routes[state.selected]) {
      toast('Calculate a corridor first to view traffic congestion overlay.');
      return;
    }

    renderTrafficPolylines();
    toast('🚦 Congestion perception layer active: Flow speeds overlaid along corridor.');
    log('Traffic Layer Active', 'Rendering real-time congestion segments (Green=Free, Orange=Moderate, Red=Heavy).', 'green');
  }

  function renderTrafficPolylines() {
    if (!state.trafficLayerGroup || !state.map) return;
    state.trafficLayerGroup.clearLayers();

    const currentRoute = state.routes[state.selected];
    if (!currentRoute) return;
    const coords = routeCoords(currentRoute);
    if (coords.length < 4) return;

    const numChunks = Math.min(10, Math.max(3, Math.floor(coords.length / 8)));
    const chunkSize = Math.floor(coords.length / numChunks);

    const trafficStyles = [
      { color: '#00e59b', weight: 7, opacity: 0.7, label: 'Free Flow (60 km/h)' },
      { color: '#f59e0b', weight: 8, opacity: 0.8, label: 'Moderate Traffic (35 km/h)' },
      { color: '#ef4444', weight: 9, opacity: 0.9, label: 'Heavy Congestion (14 km/h)' }
    ];

    for (let c = 0; c < numChunks; c++) {
      const startI = c * chunkSize;
      const endI = (c === numChunks - 1) ? coords.length : (c + 1) * chunkSize + 1;
      const segmentCoords = coords.slice(startI, endI).map(pt => [pt.lat, pt.lng]);

      let tIdx = 0;
      if (c === Math.floor(numChunks * 0.45)) tIdx = 2; // red segment
      else if (c % 2 === 1) tIdx = 1; // orange segment

      const style = trafficStyles[tIdx];
      const poly = L.polyline(segmentCoords, {
        color: style.color,
        weight: style.weight,
        opacity: style.opacity,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(state.trafficLayerGroup);

      poly.bindTooltip(`🚦 Corridor Traffic: ${style.label}`, { sticky: true });
    }
  }

  // --------------------------------------------------------------------------
  // SENSOR STACK DIAGNOSTIC TESTING
  // --------------------------------------------------------------------------
  function runSensorDiagnostic(sensor) {
    if (sensor === 'camera') {
      const row = $('sensorCameraRow');
      if (row) { row.classList.add('sensor-pulse'); setTimeout(() => row.classList.remove('sensor-pulse'), 1400); }
      toast('📷 Camera Perception: 1080p stream online · 0 latency · Pedestrian & Obstacle classification 99.4%');
      log('Sensor Diagnostic: Camera', 'Neural vision object detection verified (Pedestrians, Animals, Road Obstacles online).', 'green');
    } else if (sensor === 'lidar') {
      const row = $('sensorLidarRow');
      if (row) { row.classList.add('sensor-pulse'); setTimeout(() => row.classList.remove('sensor-pulse'), 1400); }
      toast('⌁ LiDAR Scanner: 16-beam range cloud active · 120m corridor scan · 0 obstacles in blind spot');
      log('Sensor Diagnostic: LiDAR', 'Virtual range point cloud scan nominal (360° vehicle clearance verified).', 'green');
    } else if (sensor === 'radar') {
      const row = $('sensorRadarRow');
      if (row) { row.classList.add('sensor-pulse'); setTimeout(() => row.classList.remove('sensor-pulse'), 1400); }
      toast('⌖ Doppler Radar: 77GHz velocity tracking online · Dynamic moving targets locked');
      log('Sensor Diagnostic: Radar', 'Target doppler velocity tracking online (Moving pedestrian kinematics tracked).', 'green');
    }
  }

  // --------------------------------------------------------------------------
  // ENTITY BUTTON INTERACTION HANDLERS
  // --------------------------------------------------------------------------
  async function onEntityBtnClick(type) {
    state.selectedToolType = type;
    if (state.placementModeArmed) {
      setPlacementMode(type);
    } else {
      await quickAddEntity(type);
    }
  }

  function togglePlacementMode() {
    state.placementModeArmed = !state.placementModeArmed;
    if (state.placementModeArmed) {
      setPlacementMode(state.selectedToolType || 'Obstacle');
      const toggleLabel = $('placementToggleLabel');
      if (toggleLabel) toggleLabel.textContent = `Armed: Click Map`;
      $('sidebarTogglePlacement')?.classList.add('active');
      toast(`Placement armed: Click anywhere on Leaflet map to place ${state.selectedToolType || 'Obstacle'}`);
    } else {
      cancelPlacementMode();
      toast('Map click placement disarmed. Entity buttons will spawn directly onto active route.');
    }
  }

  function toggleFollowVehicle() {
    state.follow = !state.follow;
    $('followBtn')?.classList.toggle('active', state.follow);
    $('followBtn').textContent = state.follow ? '◎ Following vehicle' : '◎ Follow vehicle';
    if (state.follow && state.currentPosition && state.map) {
      state.map.panTo([state.currentPosition.lat, state.currentPosition.lng]);
    }
  }

  async function handleSwapOriginDestination() {
    const a = $('originInput').value;
    $('originInput').value = $('destinationInput').value;
    $('destinationInput').value = a;
    const tmp = state.start;
    state.start = state.end;
    state.end = tmp;
    if (state.start) updateEndpointMarker('start', state.start.lat, state.start.lng);
    if (state.end) updateEndpointMarker('end', state.end.lat, state.end.lng);
    toast('Swapped origin and destination. Recalculating routes…');
    log('Corridor reversed', 'Origin and destination swapped.', 'green');
    await calculateRoutes();
  }

  function startGps() {
    toggleAutonomousDrive();
  }

  function stopGps() {
    stopAutonomousDrive();
  }

  // --------------------------------------------------------------------------
  // EVENT LISTENERS & INITIALIZATION
  // --------------------------------------------------------------------------
  function setupEventListeners() {
    // 1. Sidebar Entity Buttons
    $('sidebarAddObstacle')?.addEventListener('click', () => onEntityBtnClick('Obstacle'));
    $('sidebarAddPedestrian')?.addEventListener('click', () => onEntityBtnClick('Pedestrian Moving'));
    $('sidebarAddAnimal')?.addEventListener('click', () => onEntityBtnClick('Animal Crossing'));
    $('sidebarAddConstruction')?.addEventListener('click', () => onEntityBtnClick('Construction Working'));
    $('sidebarAddRoadBlocked')?.addEventListener('click', () => onEntityBtnClick('Road Blocked'));

    // Sidebar placement toolbar
    $('sidebarTogglePlacement')?.addEventListener('click', togglePlacementMode);
    $('sidebarQuickAddRoute')?.addEventListener('click', () => quickAddEntity(state.selectedToolType || 'Obstacle'));

    // 2. Map Entity Toolbar buttons
    $('toolObstacle')?.addEventListener('click', () => onEntityBtnClick('Obstacle'));
    $('toolPedestrian')?.addEventListener('click', () => onEntityBtnClick('Pedestrian Moving'));
    $('toolAnimal')?.addEventListener('click', () => onEntityBtnClick('Animal Crossing'));
    $('toolConstruction')?.addEventListener('click', () => onEntityBtnClick('Construction Working'));
    $('toolRoadBlocked')?.addEventListener('click', () => onEntityBtnClick('Road Blocked'));
    $('quickAddOnRouteBtn')?.addEventListener('click', () => quickAddEntity(state.selectedToolType || 'Obstacle'));
    $('cancelPlacementBtn')?.addEventListener('click', cancelPlacementMode);

    // 3. Review scenarios dropdown
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

    // 4. Clear buttons
    $('clearAllHazardsBtn')?.addEventListener('click', clearAllHazards);
    $('clearHazardsSidebarBtn')?.addEventListener('click', clearAllHazards);

    // 5. Map & Vehicle controls
    $('themeBtn')?.addEventListener('click', toggleMapTheme);
    $('calculateBtn')?.addEventListener('click', calculateRoutes);
    $('demoBtn')?.addEventListener('click', toggleAutonomousDrive);
    $('trackBtn')?.addEventListener('click', toggleAutonomousDrive);
    $('stopTrackBtn')?.addEventListener('click', stopAutonomousDrive);
    $('trafficBtn')?.addEventListener('click', toggleTrafficLayer);
    $('followBtn')?.addEventListener('click', toggleFollowVehicle);
    $('swapBtn')?.addEventListener('click', handleSwapOriginDestination);
    $('useLocationBtn')?.addEventListener('click', () => initCurrentLocation());

    // 6. Sensor rows diagnostics
    $('sensorCameraRow')?.addEventListener('click', () => runSensorDiagnostic('camera'));
    $('sensorLidarRow')?.addEventListener('click', () => runSensorDiagnostic('lidar'));
    $('sensorRadarRow')?.addEventListener('click', () => runSensorDiagnostic('radar'));

    // 7. Sidebar Manual Report Panel
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

    // 8. Reroute Modal buttons
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

    // 9. Retry Route Button (in Dynamic Reroute Banner)
    $('retryRouteBtn')?.addEventListener('click', () => {
      BlockageReroute.allCorridorsBlocked = false;
      $('retryRouteBtn').hidden = true;
      BlockageReroute.triggerReroute('Manual retry requested by operator');
    });

    // 10. Simulation Safety Controls & Sensor Modes Test Harness
    $('simPedestrianDetectBtn')?.addEventListener('click', async () => {
      PedestrianSafety.setSensorUnavailable(false);
      PedestrianSafety.recordHeartbeat();
      if (!state.routes.length) await calculateRoutes();
      if (!state.routes.length) { toast('Please set route first.'); return; }
      const coords = routeCoords(state.routes[state.selected]);
      const vehicleIdx = state.demoIndex || 0;
      const targetIdx = Math.min(coords.length - 1, vehicleIdx + 8);
      const pt = coords[targetIdx] || coords[Math.floor(coords.length * 0.4)];
      await insertHazard('Pedestrian Moving', pt.lat, pt.lng, {
        description: 'Simulated Crossing Zone Pedestrian (Yield & Stop Test)',
        confidence: 0.95
      });
      if (state.map) state.map.setView([pt.lat, pt.lng], 15);
      toast('🚶 Simulated Pedestrian placed ahead! Vehicle commanded to 0 km/h stop.');
      log('SIMULATION TEST: Pedestrian Detected', 'Simulated pedestrian entered crossing zone. Vehicle decelerating to 0 km/h stop.', 'red');
    });

    $('simPedestrianClearBtn')?.addEventListener('click', () => {
      PedestrianSafety.recordHeartbeat();
      let clearedCount = 0;
      state.hazards.forEach(h => {
        if (h.type === 'Pedestrian Moving' || h.type === 'Animal Crossing' || h.type === 'Stray Animal') {
          h.hasClearedRoad = true;
          h.isCrossingNow = false;
          clearedCount++;
        }
      });
      if (clearedCount > 0) {
        toast('✅ Pedestrian marked clear! 2.5s safety interval started before vehicle resumes.');
        log('SIMULATION TEST: Crossing Zone Clear', 'Pedestrian reached sidewalk. Starting 2.5s debounce before resuming.', 'green');
      } else {
        toast('No active pedestrian crossing detected.');
      }
    });

    $('simBlockRouteBtn')?.addEventListener('click', async () => {
      if (!state.routes.length) await calculateRoutes();
      if (!state.routes.length) { toast('Please set route first.'); return; }
      const coords = routeCoords(state.routes[state.selected]);
      const vehicleIdx = state.demoIndex || 0;
      const targetIdx = Math.min(coords.length - 1, vehicleIdx + 12);
      const pt = coords[targetIdx] || coords[Math.floor(coords.length * 0.45)];
      await insertHazard('Road Blocked', pt.lat, pt.lng, {
        description: 'Simulated Road Closure / Blocked Highway',
        severity: 'Critical'
      });
      if (state.map) state.map.setView([pt.lat, pt.lng], 14);
      toast('⛔ Simulated Road Blockage deployed! Automatic rerouting requested.');
      log('SIMULATION TEST: Road Blocked', 'Critical road closure simulated. Auto-rerouting initiated.', 'red');
    });

    $('simClearBlockBtn')?.addEventListener('click', async () => {
      const blockedHazards = state.hazards.filter(h => h.type === 'Road Blocked');
      for (const h of blockedHazards) {
        await deleteHazard(h.id);
      }
      BlockageReroute.allCorridorsBlocked = false;
      if ($('retryRouteBtn')) $('retryRouteBtn').hidden = true;
      toast('✓ Road blockages cleared. Recalculating corridors...');
      log('SIMULATION TEST: Blockage Cleared', 'Road closures removed. Restoring route corridor.', 'green');
      await calculateRoutes();
    });

    $('simConstructionBtn')?.addEventListener('click', async () => {
      if (!state.routes.length) await calculateRoutes();
      if (!state.routes.length) { toast('Please set route first.'); return; }
      const coords = routeCoords(state.routes[state.selected]);
      const vehicleIdx = state.demoIndex || 0;
      const targetIdx = Math.min(coords.length - 1, vehicleIdx + 10);
      const pt = coords[targetIdx] || coords[Math.floor(coords.length * 0.5)];
      await insertHazard('Construction Working', pt.lat, pt.lng, {
        description: 'Simulated Active Construction Zone (Roadwork Ahead)',
        severity: 'Moderate'
      });
      if (state.map) state.map.setView([pt.lat, pt.lng], 14);
      toast('🚧 Simulated Construction Zone deployed! Auto-rerouting detour requested.');
      log('SIMULATION TEST: Construction Zone', 'Work zone simulated. Auto-rerouting around roadwork.', 'amber');
    });

    $('simClearConstructionBtn')?.addEventListener('click', async () => {
      const constHazards = state.hazards.filter(h => h.type === 'Construction Working');
      for (const h of constHazards) {
        await deleteHazard(h.id);
      }
      toast('✓ Construction zones cleared. Recalculating corridors...');
      log('SIMULATION TEST: Construction Cleared', 'Work zones cleared. Restoring cruising corridors.', 'green');
      await calculateRoutes();
    });

    $('simSensorTimeoutBtn')?.addEventListener('click', () => {
      PedestrianSafety.setSensorUnavailable(true);
      const badge = $('simSensorSourceBadge');
      if (badge) {
        badge.textContent = '[SENSOR TIMEOUT / OFFLINE]';
        badge.style.color = 'var(--red)';
        badge.style.borderColor = 'var(--red)';
      }
      toast('⚠️ Simulated sensor feed unavailable / timed out! Vehicle holding safe 0 km/h stop.');
      log('SIMULATION TEST: Sensor Timeout', 'Sensor feed set to unavailable/stale. Vehicle will hold 0 km/h safe stop; road clearance cannot be assumed.', 'red');
    });

    $('simSensorRestoreBtn')?.addEventListener('click', () => {
      PedestrianSafety.setSensorUnavailable(false);
      PedestrianSafety.recordHeartbeat();
      const badge = $('simSensorSourceBadge');
      if (badge) {
        badge.textContent = '[SIMULATED SENSOR]';
        badge.style.color = '#38bdf8';
        badge.style.borderColor = 'rgba(56,189,248,0.3)';
      }
      toast('🔄 Sensor stream restored! Heartbeat online.');
      log('SIMULATION TEST: Sensor Restored', 'Perception sensor stream restored to nominal online state.', 'green');
    });
  }

  async function init() {
    try {
      // Initialize Leaflet Map directly
      initLeaflet();
      setupEventListeners();

      // Refresh hazards from backend
      await refreshHazards();

      // Autonomous software controller telemetry
      try {
        const t = await api('/api/telemetry');
        state.telemetry = t.telemetry;
        if ($('telemetryType')) $('telemetryType').textContent = 'AUTONOMOUS';
        if ($('vehicleSource')) $('vehicleSource').textContent = 'SOFTWARE STACK';
        if ($('vehicleStatus')) $('vehicleStatus').textContent = 'Autonomous Software Stack Active';
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
