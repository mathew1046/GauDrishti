import { useState, useEffect, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, GeoJSON, FeatureGroup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix for leaflet-draw bug: ReferenceError: type is not defined
window.type = '';

import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';
import { Save, MapPin, Calendar, Plus, Edit2, Check, X, Trash2 } from 'lucide-react';
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
  const [loading, setLoading] = useState(false);
  const [newZoneGeoJSON, setNewZoneGeoJSON] = useState(null);
  const [newSchedule, setNewSchedule] = useState(
    DAY_KEYS.reduce((acc, d) => ({ ...acc, [d]: true }), {})
  );
  const [villages, setVillages] = useState([
    { id: 'VLG_KOTHM_01', name: 'Kothamangalam Zone 1' },
    { id: 'VLG_KOTHM_02', name: 'Kothamangalam Zone 2' },
    { id: 'VLG_MNDY_01', name: 'Mandya Zone 1' }
  ]);
  const [villageId, setVillageId] = useState('VLG_KOTHM_01');
  const [saving, setSaving] = useState(false);

  const [editingVillageId, setEditingVillageId] = useState(null);
  const [editingVillageName, setEditingVillageName] = useState('');
  const [creatingVillage, setCreatingVillage] = useState(false);
  const [newVillageName, setNewVillageName] = useState('');
  const [newZoneName, setNewZoneName] = useState('');
  
  const [editingZoneId, setEditingZoneId] = useState(null);
  const [editingZoneName, setEditingZoneName] = useState('');

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
      const geoJsonWithProps = {
        ...newZoneGeoJSON,
        properties: {
          ...newZoneGeoJSON.properties,
          name: newZoneName || `New Zone`,
          color: ZONE_COLORS[zones.length % ZONE_COLORS.length]
        }
      };
      await api.updateZone({
        village_id: villageId,
        zone_geojson: geoJsonWithProps,
        schedule: newSchedule,
      });
      await fetchZones();
      setNewZoneGeoJSON(null);
      setNewZoneName('');
      setNewSchedule(DAY_KEYS.reduce((acc, d) => ({ ...acc, [d]: true }), {}));
    } catch (err) {
      console.error('Failed to save zone:', err);
    }
    setSaving(false);
  };

  const handleCreateVillage = () => {
    if (newVillageName.trim()) {
      const newId = `VLG_${newVillageName.replace(/\s+/g, '_').toUpperCase()}_${Date.now()}`;
      setVillages([...villages, { id: newId, name: newVillageName }]);
      setVillageId(newId);
      setCreatingVillage(false);
      setNewVillageName('');
    }
  };

  const handleEditVillage = (id) => {
    const village = villages.find(v => v.id === id);
    if (village) {
      setEditingVillageId(id);
      setEditingVillageName(village.name);
    }
  };

  const handleSaveVillageName = () => {
    if (editingVillageName.trim()) {
      setVillages(villages.map(v => 
        v.id === editingVillageId ? { ...v, name: editingVillageName } : v
      ));
    }
    setEditingVillageId(null);
  };

  const handleDeleteVillage = (id) => {
    if (villages.length <= 1) {
      alert("Cannot delete the last village.");
      return;
    }
    if (window.confirm("Are you sure you want to delete this village and all its zones?")) {
      const updatedVillages = villages.filter(v => v.id !== id);
      setVillages(updatedVillages);
      if (villageId === id) {
        setVillageId(updatedVillages[0].id);
      }
      setEditingVillageId(null);
    }
  };

  const handleDeleteZone = async (zone, name) => {
    if (window.confirm(`Are you sure you want to delete "${name}"?`)) {
      const zoneIdToDelete = zone.properties?.zone_id || zone.id;
      
      if (zoneIdToDelete) {
        try {
          await api.deleteZone(zoneIdToDelete);
        } catch (err) {
          console.error('Failed to delete zone in DB:', err);
        }
      }
      
      // Update local state
      const updatedZones = zones.filter((z, i) => {
        const currId = z.properties?.zone_id || z.id;
        if (zoneIdToDelete) return currId !== zoneIdToDelete;
        // Fallback for newly created zones without IDs during session
        return (z.properties?.name || `Zone ${i + 1}`) !== name;
      });
      setZones(updatedZones);
    }
  };
  
  const handleEditZoneStart = (zone, name) => {
    setEditingZoneId(zone.properties?.zone_id || zone.id || name); // fallback to name
    setEditingZoneName(name);
  };
  
  const handleSaveZoneName = async (zoneRaw, idx) => {
    if (!editingZoneName.trim()) return;
    
    const zoneIdToUpdate = editingZoneId;
    let zoneToUpdate = null;
    
    const updatedZones = zones.map((z, i) => {
      const currId = z.properties?.zone_id || z.id || (z.properties?.name || `Zone ${i + 1}`);
      if (currId === zoneIdToUpdate) {
        zoneToUpdate = {
          ...z,
          properties: {
            ...z.properties,
            name: editingZoneName
          }
        };
        return zoneToUpdate;
      }
      return z;
    });
    
    if (zoneToUpdate && zoneToUpdate.properties?.zone_id) {
      try {
        await api.updateZone({
          village_id: villageId,
          zone_geojson: zoneToUpdate,
          schedule: zoneToUpdate.properties.schedule || DAY_KEYS.reduce((acc, d) => ({ ...acc, [d]: true }), {})
        });
      } catch (err) {
        console.error('Failed to update zone name in DB', err);
        return;
      }
    }
    
    setZones(updatedZones);
    setEditingZoneId(null);
    setEditingZoneName('');
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Village Name</label>
            {!creatingVillage && !editingVillageId && (
              <button 
                onClick={() => setCreatingVillage(true)}
                style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: '0', display: 'flex', alignItems: 'center', fontSize: '12px' }}
              >
                <Plus size={12} style={{ marginRight: '2px' }} /> New
              </button>
            )}
          </div>
          
          {creatingVillage ? (
            <div style={{ display: 'flex', gap: '4px' }}>
              <input
                type="text"
                autoFocus
                className="filter-select"
                style={{ width: '100%', padding: '4px 8px' }}
                value={newVillageName}
                onChange={(e) => setNewVillageName(e.target.value)}
                placeholder="Enter village name..."
                id="new-village-input"
              />
              <button 
                onClick={handleCreateVillage}
                style={{ background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: '4px', padding: '0 8px', cursor: 'pointer' }}
              >
                <Check size={14} />
              </button>
              <button 
                onClick={() => { setCreatingVillage(false); setNewVillageName(''); }}
                style={{ background: 'var(--surface-color)', color: 'var(--text-color)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0 8px', cursor: 'pointer' }}
              >
                <X size={14} />
              </button>
            </div>
          ) : editingVillageId ? (
            <div style={{ display: 'flex', gap: '4px' }}>
              <input
                type="text"
                autoFocus
                className="filter-select"
                style={{ width: '100%', padding: '4px 8px' }}
                value={editingVillageName}
                onChange={(e) => setEditingVillageName(e.target.value)}
                id="edit-village-input"
              />
              <button 
                onClick={handleSaveVillageName}
                style={{ background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: '4px', padding: '0 8px', cursor: 'pointer' }}
              >
                <Check size={14} />
              </button>
              <button 
                onClick={() => setEditingVillageId(null)}
                style={{ background: 'var(--surface-color)', color: 'var(--text-color)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0 8px', cursor: 'pointer' }}
              >
                <X size={14} />
              </button>
              <button 
                onClick={() => handleDeleteVillage(editingVillageId)}
                style={{ background: '#FF4D4D', color: '#fff', border: 'none', borderRadius: '4px', padding: '0 8px', cursor: 'pointer' }}
                title="Delete village"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '4px' }}>
              <select
                className="filter-select"
                style={{ width: '100%' }}
                value={villageId}
                onChange={(e) => setVillageId(e.target.value)}
                id="village-select"
              >
                {villages.map(v => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              <button 
                onClick={() => handleEditVillage(villageId)}
                style={{ background: 'var(--surface-color)', color: 'var(--text-color)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0 8px', cursor: 'pointer' }}
                title="Edit village name"
              >
                <Edit2 size={14} />
              </button>
            </div>
          )}
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
                    {editingZoneId === (zone.properties?.zone_id || zone.id || name) ? (
                      <div className="zone-name" style={{ display: 'flex', alignItems: 'center', gap: '4px', width: '100% '}}>
                        <div className="zone-color-dot" style={{ background: color }} />
                        <input 
                          type="text" 
                          value={editingZoneName} 
                          onChange={(e) => setEditingZoneName(e.target.value)}
                          className="filter-select"
                          style={{ padding: '2px 4px', fontSize: '13px', flex: 1 }}
                          autoFocus
                          onKeyDown={(e) => e.key === 'Enter' && handleSaveZoneName(zone, idx)}
                        />
                        <button 
                          onClick={() => handleSaveZoneName(zone, idx)} 
                          style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: '0 2px' }}
                        >
                          <Check size={14} />
                        </button>
                        <button 
                          onClick={() => setEditingZoneId(null)} 
                          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0 2px' }}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="zone-name" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <div className="zone-color-dot" style={{ background: color }} />
                        <span style={{ fontWeight: '500', marginRight: '4px' }}>{name}</span>
                        <button 
                          onClick={() => handleEditZoneStart(zone, name)} 
                          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0' }}
                          title="Edit zone name"
                        >
                          <Edit2 size={12} />
                        </button>
                        <button 
                          onClick={() => handleDeleteZone(zone, name)} 
                          style={{ background: 'none', border: 'none', color: '#FF4D4D', cursor: 'pointer', padding: '0', marginLeft: 'auto' }}
                          title="Delete zone"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
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
            <div style={{ marginBottom: '12px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px', display: 'block' }}>Zone Name</label>
              <input
                type="text"
                className="filter-select"
                style={{ width: '100%', padding: '6px 8px' }}
                value={newZoneName}
                onChange={(e) => setNewZoneName(e.target.value)}
                placeholder="e.g. Morning Grazing Area"
                id="new-zone-name-input"
              />
            </div>
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
