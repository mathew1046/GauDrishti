import { useEffect } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import { Thermometer, Heart, Activity, BatteryMedium } from 'lucide-react';
import 'leaflet/dist/leaflet.css';

const STATE_COLORS = {
  NORMAL: '#2D6A4F',
  WATCH: '#E6B422',
  ALERT: '#E67E22',
  EMERGENCY: '#E74C3C',
};

const KERALA_CENTER = [10.8505, 76.2711];

// Component to fly to selected animal
function FlyToAnimal({ animal }) {
  const map = useMap();
  useEffect(() => {
    if (animal?.lat && animal?.lng) {
      map.flyTo([animal.lat, animal.lng], 15, { duration: 1.0 });
    }
  }, [animal, map]);
  return null;
}

function HerdMap({ cattle, onMarkerClick, selectedAnimal }) {
  // Find center from cattle positions, default to Kerala
  const center = cattle.length > 0 && cattle[0]?.lat
    ? [cattle[0].lat, cattle[0].lng]
    : KERALA_CENTER;

  return (
    <MapContainer
      center={center}
      zoom={13}
      className="map-container"
      zoomControl={true}
      attributionControl={false}
      id="herd-map"
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        attribution='&copy; <a href="https://carto.com/">CARTO</a>'
      />

      {selectedAnimal && <FlyToAnimal animal={selectedAnimal} />}

      {cattle.map((animal) => {
        if (!animal.lat || !animal.lng) return null;

        const color = STATE_COLORS[animal.alert_state] || STATE_COLORS.NORMAL;
        const isSelected = selectedAnimal?.device_id === animal.device_id;
        const isEmergency = animal.alert_state === 'EMERGENCY';

        return (
          <CircleMarker
            key={animal.device_id}
            center={[animal.lat, animal.lng]}
            radius={isSelected ? 14 : isEmergency ? 12 : 9}
            pathOptions={{
              fillColor: color,
              fillOpacity: isSelected ? 0.9 : 0.7,
              color: isSelected ? '#ffffff' : color,
              weight: isSelected ? 3 : 2,
              opacity: 1,
            }}
            eventHandlers={{
              click: () => onMarkerClick(animal),
            }}
          >
            <Popup>
              <div style={{ minWidth: '200px' }}>
                <div className="popup-title">
                  {animal.breed === 'MURRAH_BUFFALO' ? '🐃' : '🐄'} {animal.animal_name}
                </div>
                <div className="popup-breed">
                  {animal.breed?.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}
                  {' • '}{animal.device_id}
                </div>
                <div style={{ marginBottom: '10px' }}>
                  <span className={`state-badge ${animal.alert_state}`}>
                    {animal.alert_state}
                  </span>
                </div>
                <div className="popup-vitals">
                  <div className="popup-vital">
                    <span className="popup-vital-label">Temperature</span>
                    <span className="popup-vital-value">{animal.last_temp?.toFixed(1) || '--'}°C</span>
                  </div>
                  <div className="popup-vital">
                    <span className="popup-vital-label">Heart Rate</span>
                    <span className="popup-vital-value">{animal.last_hr?.toFixed(0) || '--'} BPM</span>
                  </div>
                  <div className="popup-vital">
                    <span className="popup-vital-label">Activity</span>
                    <span className="popup-vital-value">{animal.last_activity?.toFixed(0) || '--'}</span>
                  </div>
                  <div className="popup-vital">
                    <span className="popup-vital-label">Battery</span>
                    <span className="popup-vital-value">{animal.battery_pct?.toFixed(0) || '--'}%</span>
                  </div>
                </div>
              </div>
            </Popup>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}

export default HerdMap;
