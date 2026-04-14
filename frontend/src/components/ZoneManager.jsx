import { useState, useEffect, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, GeoJSON, FeatureGroup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';
import { Save, MapPin, Calendar } from 'lucide-react';
import api from '../api/client';

// Custom EditControl component since react-leaflet-draw is incompatible with modern Vite/React 19
function EditControl({ onCreated, onDeleted }) {
  const map = useMap();
  const featureGroupRef = useRef(null);
  const drawControlRef = useRef(null);

  useEffect(() => {
    if (!map) return;

    // Create a feature group to store drawn shapes
    featureGroupRef.current = new L.FeatureGroup();
    map.addLayer(featureGroupRef.current);

    // Initialize Draw Control
    const drawControl = new L.Control.Draw({
      edit: {
        featureGroup: featureGroupRef.current,
        remove: true
      },
      draw: {
        polyline: false,
        rectangle: false,
        circle: false,
        marker: false,
        circlemarker: false,
        polygon: {
          allowIntersection: false,
          showArea: true,
          shapeOptions: {
            color: '#52B788',
            fillColor: '#2D6A4F',
            fillOpacity: 0.2
          }
        }
      }
    });

    drawControlRef.current = drawControl;
    map.addControl(drawControl);

    // Handle creation
    const handleCreated = (e) => {
      const layer = e.layer;
      featureGroupRef.current.addLayer(layer);
      if (onCreated) onCreated(e);
    };

    // Handle deletion
    const handleDeleted = (e) => {
      if (onDeleted) onDeleted(e);
    };

    map.on(L.Draw.Event.CREATED, handleCreated);
    map.on(L.Draw.Event.DELETED, handleDeleted);

    return () => {
      map.off(L.Draw.Event.CREATED, handleCreated);
      map.off(L.Draw.Event.DELETED, handleDeleted);
      map.removeControl(drawControl);
      if (featureGroupRef.current) {
        map.removeLayer(featureGroupRef.current);
      }
    };
  }, [map, onCreated, onDeleted]);

  return null;
}

const KERALA_CENTER = [10.0530, 76.9210];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const ZONE_COLORS = ['#2D6A4F', '#40916C', '#52B788', '#74C69D', '#95D5B2', '#B7E4C7'];

function ZoneManager({ cooperativeId }) {
  const [zones, setZones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newZoneGeoJSON, setNewZoneGeoJSON] = useState(null);
  const [newSchedule, setNewSchedule] = useState(
    DAY_KEYS.reduce((acc, d) => ({ ...acc, [d]: true }), {})
  );
  const [villageId, setVillageId] = useState('VLG_KOTHM_01');
  const [saving, setSaving] = useState(false);

  // Fetch existing zones
  const fetchZones = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getZones(villageId);
      setZones(res.data.features || []);
    } catch (err) {
      console.error('Failed to fetch zones:', err);
      setZones([]);
    }
    setLoading(false);
  }, [villageId]);

  useEffect(() => {
    fetchZones();
  }, [fetchZones]);

  // Handle draw create
  const onCreated = (e) => {
    const layer = e.layer;
    const geoJson = layer.toGeoJSON();
    setNewZoneGeoJSON(geoJson);
  };

  // Handle draw deleted
  const onDeleted = () => {
    setNewZoneGeoJSON(null);
  };

  // Toggle schedule day
  const toggleDay = (dayKey) => {
    setNewSchedule(prev => ({ ...prev, [dayKey]: !prev[dayKey] }));
  };

  // Save new zone
  const handleSave = async () => {
    if (!newZoneGeoJSON) return;

    setSaving(true);
    try {
      await api.updateZone({
        village_id: villageId,
        zone_geojson: newZoneGeoJSON,
        schedule: newSchedule,
      });
      await fetchZones();
      setNewZoneGeoJSON(null);
    } catch (err) {
      console.error('Failed to save zone:', err);
    }
    setSaving(false);
  };

  // Style function for zones
  const getZoneStyle = (feature, index) => {
    const color = feature?.properties?.color || ZONE_COLORS[index % ZONE_COLORS.length];
    return {
      fillColor: color,
      fillOpacity: 0.2,
      color: color,
      weight: 2,
      opacity: 0.8,
    };
  };

  return (
    <div className="zone-manager" id="zone-manager">
      {/* Zone Sidebar */}
      <div className="zone-sidebar">
        <div className="zone-sidebar-header">
          <div className="zone-sidebar-title">
            <MapPin size={18} style={{ verticalAlign: 'middle', marginRight: '8px' }} />
            Virtual Zones
          </div>
          <div className="zone-sidebar-subtitle">
            Draw and manage grazing boundaries
          </div>
        </div>

        {/* Village selector */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block' }}>
            Village
          </label>
          <select
            className="filter-select"
            style={{ width: '100%' }}
            value={villageId}
            onChange={(e) => setVillageId(e.target.value)}
            id="village-select"
          >
            <option value="VLG_KOTHM_01">Kothamangalam Zone 1</option>
            <option value="VLG_KOTHM_02">Kothamangalam Zone 2</option>
            <option value="VLG_MNDY_01">Mandya Zone 1</option>
          </select>
        </div>

        {/* Zone list */}
        <div className="zone-list">
          {loading ? (
            <div className="loading-container" style={{ padding: '40px 0' }}>
              <div className="loading-spinner" />
              <span className="loading-text">Loading zones...</span>
            </div>
          ) : zones.length === 0 ? (
            <div className="empty-state" style={{ padding: '40px 0' }}>
              <span className="empty-icon">📍</span>
              <span>No zones defined</span>
              <span style={{ fontSize: '12px' }}>Draw a zone on the map</span>
            </div>
          ) : (
            zones.map((zone, idx) => {
              const color = zone.properties?.color || ZONE_COLORS[idx % ZONE_COLORS.length];
              const schedule = zone.properties?.schedule || {};
              const name = zone.properties?.name || `Zone ${idx + 1}`;

              return (
                <div key={zone.properties?.zone_id || idx} className="zone-card">
                  <div className="zone-card-header">
                    <div className="zone-name">
                      <div className="zone-color-dot" style={{ background: color }} />
                      {name}
                    </div>
                    <span className="zone-active-badge">Active</span>
                  </div>

                  <div className="zone-schedule">
                    {DAYS.map((day, dayIdx) => (
                      <div
                        key={day}
                        className={`day-chip ${schedule[DAY_KEYS[dayIdx]] ? 'active' : ''}`}
                      >
                        {day.charAt(0)}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* New Zone Schedule Editor */}
        {newZoneGeoJSON && (
          <div className="schedule-editor">
            <h4>
              <Calendar size={14} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
              New Zone Schedule
            </h4>
            <div className="zone-schedule">
              {DAYS.map((day, idx) => (
                <div
                  key={day}
                  className={`day-chip ${newSchedule[DAY_KEYS[idx]] ? 'active' : ''}`}
                  onClick={() => toggleDay(DAY_KEYS[idx])}
                  style={{ cursor: 'pointer' }}
                >
                  {day.charAt(0)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Zone Map */}
      <div className="zone-map-area">
        <MapContainer
          center={KERALA_CENTER}
          zoom={14}
          className="map-container"
          zoomControl={true}
          attributionControl={false}
          id="zone-map"
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            attribution='&copy; CARTO'
          />

          {/* Existing zones */}
          {zones.map((zone, idx) => (
            <GeoJSON
              key={zone.properties?.zone_id || idx}
              data={zone}
              style={() => getZoneStyle(zone, idx)}
            />
          ))}

          {/* Manual Draw controls */}
          <EditControl onCreated={onCreated} onDeleted={onDeleted} />
        </MapContainer>

        {/* Save button */}
        {newZoneGeoJSON && (
          <button
            className="zone-save-btn"
            onClick={handleSave}
            disabled={saving}
            id="save-zone-btn"
          >
            <Save size={16} style={{ marginRight: '8px', verticalAlign: 'middle' }} />
            {saving ? 'Saving...' : 'Save Zone'}
          </button>
        )}
      </div>
    </div>
  );
}

export default ZoneManager;
