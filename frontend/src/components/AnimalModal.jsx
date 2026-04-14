import { useState, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  X, Thermometer, Heart, Activity, BatteryMedium,
  MapPin, Clock, AlertTriangle,
} from 'lucide-react';
import api from '../api/client';

const CHART_COLORS = {
  temp: '#E67E22',
  hr: '#E74C3C',
  activity: '#52B788',
};

function AnimalModal({ animal, onClose }) {
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchHistory = async () => {
      setLoading(true);
      try {
        const res = await api.getDeviceHistory(animal.device_id, 24);
        setHistory(res.data);
      } catch (err) {
        console.error('Failed to fetch history:', err);
        setHistory({ sensor_data: [], alerts: [] });
      }
      setLoading(false);
    };

    fetchHistory();
  }, [animal.device_id]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Format sensor data for charts
  const chartData = (history?.sensor_data || []).map((d) => ({
    time: new Date(d.timestamp).toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit',
    }),
    temp: d.temp_c,
    hr: d.hr_bpm,
    activity: d.activity_index,
  }));

  const formatTime = (ts) => {
    if (!ts) return '--';
    const date = new Date(ts);
    const now = new Date();
    const diff = (now - date) / 1000;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '10px 14px',
        fontSize: '12px',
      }}>
        <div style={{ marginBottom: '6px', color: 'var(--text-muted)' }}>{label}</div>
        {payload.map((p, i) => (
          <div key={i} style={{ color: p.color, marginBottom: '2px' }}>
            {p.name}: <strong>{p.value?.toFixed(1)}</strong>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="modal-overlay" onClick={onClose} id="animal-modal-overlay">
      <div className="modal-content" onClick={(e) => e.stopPropagation()} id="animal-modal">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-title">
            <span style={{ fontSize: '28px' }}>
              {animal.breed === 'MURRAH_BUFFALO' ? '🐃' : '🐄'}
            </span>
            <div>
              <h2>{animal.animal_name}</h2>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {animal.breed?.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}
                {' • '}{animal.device_id}
              </div>
            </div>
            <span className={`state-badge ${animal.alert_state}`} style={{ marginLeft: '12px' }}>
              {animal.alert_state}
            </span>
          </div>
          <button className="modal-close" onClick={onClose} id="modal-close-btn">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body">
          {/* Vitals Grid */}
          <div className="modal-vitals-grid">
            <div className="vital-card">
              <div className="vital-card-label">
                <Thermometer size={13} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                Temperature
              </div>
              <div className="vital-card-value">
                {animal.last_temp?.toFixed(1) || '--'}
                <span className="vital-card-unit">°C</span>
              </div>
            </div>
            <div className="vital-card">
              <div className="vital-card-label">
                <Heart size={13} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                Heart Rate
              </div>
              <div className="vital-card-value">
                {animal.last_hr?.toFixed(0) || '--'}
                <span className="vital-card-unit">BPM</span>
              </div>
            </div>
            <div className="vital-card">
              <div className="vital-card-label">
                <Activity size={13} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                Activity
              </div>
              <div className="vital-card-value">
                {animal.last_activity?.toFixed(0) || '--'}
              </div>
            </div>
            <div className="vital-card">
              <div className="vital-card-label">
                <BatteryMedium size={13} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                Battery
              </div>
              <div className="vital-card-value">
                {animal.battery_pct?.toFixed(0) || '--'}
                <span className="vital-card-unit">%</span>
              </div>
            </div>
          </div>

          {/* GPS Position */}
          {animal.lat && animal.lng && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              marginBottom: '24px', fontSize: '13px', color: 'var(--text-secondary)',
            }}>
              <MapPin size={14} />
              <span>
                {animal.lat?.toFixed(6)}, {animal.lng?.toFixed(6)}
              </span>
              {animal.last_seen && (
                <span style={{ color: 'var(--text-muted)', marginLeft: '8px' }}>
                  Last seen: {formatTime(animal.last_seen)}
                </span>
              )}
            </div>
          )}

          {/* Sparkline Charts */}
          {loading ? (
            <div className="loading-container" style={{ padding: '40px 0' }}>
              <div className="loading-spinner" />
              <span className="loading-text">Loading 24h history...</span>
            </div>
          ) : (
            <div className="modal-charts">
              {/* Temperature Chart */}
              <div className="chart-card">
                <div className="chart-title">
                  <Thermometer size={14} style={{ marginRight: '6px', verticalAlign: 'middle', color: CHART_COLORS.temp }} />
                  Temperature — 24h
                </div>
                <ResponsiveContainer width="100%" height={120}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(82,183,136,0.08)" />
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      domain={['dataMin - 0.5', 'dataMax + 0.5']}
                      tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                      tickLine={false}
                      axisLine={false}
                      width={40}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Line
                      type="monotone"
                      dataKey="temp"
                      name="Temp °C"
                      stroke={CHART_COLORS.temp}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: CHART_COLORS.temp }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Heart Rate Chart */}
              <div className="chart-card">
                <div className="chart-title">
                  <Heart size={14} style={{ marginRight: '6px', verticalAlign: 'middle', color: CHART_COLORS.hr }} />
                  Heart Rate — 24h
                </div>
                <ResponsiveContainer width="100%" height={120}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(82,183,136,0.08)" />
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      domain={['dataMin - 5', 'dataMax + 5']}
                      tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                      tickLine={false}
                      axisLine={false}
                      width={40}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Line
                      type="monotone"
                      dataKey="hr"
                      name="HR BPM"
                      stroke={CHART_COLORS.hr}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: CHART_COLORS.hr }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Activity Chart */}
              <div className="chart-card">
                <div className="chart-title">
                  <Activity size={14} style={{ marginRight: '6px', verticalAlign: 'middle', color: CHART_COLORS.activity }} />
                  Activity Index — 24h
                </div>
                <ResponsiveContainer width="100%" height={120}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(82,183,136,0.08)" />
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      domain={['dataMin - 50', 'dataMax + 50']}
                      tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                      tickLine={false}
                      axisLine={false}
                      width={40}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Line
                      type="monotone"
                      dataKey="activity"
                      name="Activity"
                      stroke={CHART_COLORS.activity}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: CHART_COLORS.activity }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Alert History */}
          {history?.alerts && history.alerts.length > 0 && (
            <div className="modal-alert-history">
              <h3>
                <AlertTriangle size={16} style={{ marginRight: '8px', verticalAlign: 'middle' }} />
                Recent Alerts
              </h3>
              <div className="mini-alert-list">
                {history.alerts.slice(0, 5).map((alert, idx) => (
                  <div key={alert.alert_id || idx} className="mini-alert">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span className={`severity-badge ${alert.severity}`}>
                        {alert.severity}
                      </span>
                      <span>{alert.alert_type}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span className={`outcome-badge ${alert.outcome}`}>
                        {alert.outcome}
                      </span>
                      <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                        {formatTime(alert.timestamp)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AnimalModal;
