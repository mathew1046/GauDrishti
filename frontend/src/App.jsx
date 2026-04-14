import { useState, useEffect, useCallback } from 'react';
import {
  MapPin, Bell, Hexagon, Activity, Thermometer,
  Heart, BatteryMedium, Wifi, WifiOff, RefreshCw, Menu,
} from 'lucide-react';
import HerdMap from './components/HerdMap';
import AlertFeed from './components/AlertFeed';
import ZoneManager from './components/ZoneManager';
import AnimalModal from './components/AnimalModal';
import api from './api/client';
import './index.css';

const COOPERATIVE_ID = localStorage.getItem('cooperative_id') ||
  import.meta.env.VITE_COOPERATIVE_ID ||
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const TABS = [
  { id: 'herd', label: 'Herd Overview', icon: MapPin },
  { id: 'alerts', label: 'Alert Feed', icon: Bell },
  { id: 'zones', label: 'Zone Management', icon: Hexagon },
];

const STATE_PRIORITY = { EMERGENCY: 0, ALERT: 1, WATCH: 2, NORMAL: 3 };

function App() {
  const [activeTab, setActiveTab] = useState('herd');
  const [cattle, setCattle] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(true);
  const [selectedAnimal, setSelectedAnimal] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [cooperativeName, setCooperativeName] = useState('Kothamangalam Dairy Cooperative');

  // Save cooperative ID
  useEffect(() => {
    localStorage.setItem('cooperative_id', COOPERATIVE_ID);
  }, []);

  // Fetch herd data
  const fetchHerd = useCallback(async () => {
    try {
      const res = await api.getHerdStatus(COOPERATIVE_ID);
      const sorted = (res.data.cattle || []).sort(
        (a, b) => (STATE_PRIORITY[a.alert_state] ?? 9) - (STATE_PRIORITY[b.alert_state] ?? 9)
      );
      setCattle(sorted);
      setIsOnline(true);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Failed to fetch herd:', err);
      setIsOnline(false);
    }
  }, []);

  // Fetch alerts
  const fetchAlerts = useCallback(async () => {
    try {
      const res = await api.getAlerts(COOPERATIVE_ID);
      setAlerts(res.data.alerts || []);
    } catch (err) {
      console.error('Failed to fetch alerts:', err);
    }
  }, []);

  // Initial load
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await Promise.all([fetchHerd(), fetchAlerts()]);
      setLoading(false);
    };
    init();
  }, [fetchHerd, fetchAlerts]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchHerd();
      if (activeTab === 'alerts') fetchAlerts();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchHerd, fetchAlerts, activeTab]);

  const handleAnimalClick = (animal) => {
    setSelectedAnimal(animal);
  };

  const handleRefresh = async () => {
    setLoading(true);
    await Promise.all([fetchHerd(), fetchAlerts()]);
    setLoading(false);
  };

  // Count by state
  const stateCounts = cattle.reduce((acc, c) => {
    acc[c.alert_state] = (acc[c.alert_state] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="app-container">
      {/* Header */}
      <header className="header" id="main-header">
        <div className="header-left">
          <div className="logo">
            <div className="logo-icon">🐄</div>
            <span className="logo-text">GauDrishti</span>
          </div>
          <span className="header-coop-name">{cooperativeName}</span>
        </div>
        <div className="header-right">
          <div className="status-indicator">
            <div className={`status-dot ${isOnline ? 'online' : 'offline'}`} />
            <span>{isOnline ? 'Online' : 'Offline'}</span>
          </div>
          {lastRefresh && (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Updated {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={handleRefresh}
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              color: 'var(--text-secondary)',
              padding: '8px',
              cursor: 'pointer',
              display: 'flex',
            }}
            title="Refresh"
            id="refresh-btn"
          >
            <RefreshCw size={16} className={loading ? 'spinning' : ''} />
          </button>
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav className="nav-tabs" id="main-nav">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`nav-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            id={`tab-${tab.id}`}
          >
            <tab.icon size={16} />
            {tab.label}
            {tab.id === 'alerts' && alerts.length > 0 && (
              <span style={{
                background: 'rgba(231, 76, 60, 0.2)',
                color: '#E74C3C',
                padding: '2px 8px',
                borderRadius: '10px',
                fontSize: '11px',
                fontWeight: 600,
              }}>
                {alerts.filter(a => a.outcome === 'PENDING').length}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* Main Content */}
      <div className="main-content">
        {activeTab === 'herd' && (
          <>
            {/* Sidebar */}
            <aside className="sidebar" id="cattle-sidebar">
              <div className="sidebar-header">
                <span className="sidebar-title">Cattle</span>
                <span className="sidebar-count">{cattle.length} animals</span>
              </div>

              {/* State summary */}
              <div style={{
                display: 'flex', gap: '6px', padding: '12px 20px',
                borderBottom: '1px solid var(--border)',
              }}>
                {['NORMAL', 'WATCH', 'ALERT', 'EMERGENCY'].map(state => (
                  <div key={state} style={{
                    flex: 1, textAlign: 'center', padding: '6px',
                    borderRadius: '8px', background: 'var(--bg-elevated)',
                  }}>
                    <div style={{ fontSize: '18px', fontWeight: 700 }}>{stateCounts[state] || 0}</div>
                    <div style={{
                      fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.5px',
                      color: `var(--state-${state.toLowerCase()})`, fontWeight: 600,
                    }}>{state}</div>
                  </div>
                ))}
              </div>

              <div className="sidebar-list">
                {loading && cattle.length === 0 ? (
                  <div className="loading-container">
                    <div className="loading-spinner" />
                    <span className="loading-text">Loading cattle...</span>
                  </div>
                ) : cattle.length === 0 ? (
                  <div className="empty-state">
                    <span className="empty-icon">🐄</span>
                    <span>No cattle found</span>
                  </div>
                ) : (
                  cattle.map((animal) => (
                    <div
                      key={animal.device_id}
                      className={`cattle-card ${selectedAnimal?.device_id === animal.device_id ? 'selected' : ''}`}
                      onClick={() => handleAnimalClick(animal)}
                      id={`cattle-${animal.device_id}`}
                    >
                      <div className={`cattle-avatar ${animal.alert_state}`}>
                        {animal.breed === 'MURRAH_BUFFALO' ? '🐃' : '🐄'}
                      </div>
                      <div className="cattle-info">
                        <div className="cattle-name">{animal.animal_name}</div>
                        <div className="cattle-breed">
                          {animal.breed?.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}
                        </div>
                        <div className="cattle-vitals">
                          <span className="vital-mini">
                            <Thermometer size={11} /> {animal.last_temp?.toFixed(1) || '--'}°C
                          </span>
                          <span className="vital-mini">
                            <Heart size={11} /> {animal.last_hr?.toFixed(0) || '--'}
                          </span>
                          <span className="vital-mini">
                            <Activity size={11} /> {animal.last_activity?.toFixed(0) || '--'}
                          </span>
                        </div>
                      </div>
                      <div className="cattle-state">
                        <span className={`state-badge ${animal.alert_state}`}>
                          {animal.alert_state}
                        </span>
                        <span className="battery-mini">
                          <BatteryMedium size={11} /> {animal.battery_pct?.toFixed(0) || '--'}%
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </aside>

            {/* Map */}
            <div className="map-area" id="herd-map-area">
              <HerdMap
                cattle={cattle}
                onMarkerClick={handleAnimalClick}
                selectedAnimal={selectedAnimal}
              />
            </div>
          </>
        )}

        {activeTab === 'alerts' && (
          <AlertFeed
            alerts={alerts}
            onRefresh={fetchAlerts}
            loading={loading}
          />
        )}

        {activeTab === 'zones' && (
          <ZoneManager cooperativeId={COOPERATIVE_ID} />
        )}
      </div>

      {/* Animal Detail Modal */}
      {selectedAnimal && (
        <AnimalModal
          animal={selectedAnimal}
          onClose={() => setSelectedAnimal(null)}
        />
      )}
    </div>
  );
}

export default App;
