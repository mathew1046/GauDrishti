import { useState, useMemo } from 'react';
import {
  AlertTriangle, Thermometer, Heart, Activity,
  Clock, CheckCircle, Phone, XCircle, HelpCircle,
} from 'lucide-react';

const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

const OUTCOME_ICONS = {
  TREATED: CheckCircle,
  VET_CALLED: Phone,
  FALSE_ALARM: XCircle,
  PENDING: HelpCircle,
};

const OUTCOME_LABELS = {
  TREATED: 'Treated',
  VET_CALLED: 'Vet Called',
  FALSE_ALARM: 'False Alarm',
  PENDING: 'Pending',
};

function AlertFeed({ alerts, onRefresh, loading }) {
  const [severityFilter, setSeverityFilter] = useState('ALL');
  const [outcomeFilter, setOutcomeFilter] = useState('ALL');

  const filteredAlerts = useMemo(() => {
    let filtered = [...alerts];
    if (severityFilter !== 'ALL') {
      filtered = filtered.filter(a => a.severity === severityFilter);
    }
    if (outcomeFilter !== 'ALL') {
      filtered = filtered.filter(a => a.outcome === outcomeFilter);
    }
    return filtered.sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    );
  }, [alerts, severityFilter, outcomeFilter]);

  const formatTime = (ts) => {
    if (!ts) return '--';
    const date = new Date(ts);
    const now = new Date();
    const diff = (now - date) / 1000;

    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return date.toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  };

  return (
    <div className="alert-feed" id="alert-feed">
      <div className="alert-feed-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <AlertTriangle size={20} style={{ color: 'var(--state-alert)' }} />
          <h2 style={{ fontSize: '18px', fontWeight: 700 }}>Alert Feed</h2>
          <span style={{
            fontSize: '12px', color: 'var(--text-muted)',
            background: 'var(--bg-elevated)',
            padding: '3px 10px', borderRadius: '12px',
          }}>
            {filteredAlerts.length} alerts
          </span>
        </div>

        <div className="filter-bar">
          <select
            className="filter-select"
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            id="severity-filter"
          >
            <option value="ALL">All Severity</option>
            <option value="CRITICAL">Critical</option>
            <option value="HIGH">High</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
          </select>

          <select
            className="filter-select"
            value={outcomeFilter}
            onChange={(e) => setOutcomeFilter(e.target.value)}
            id="outcome-filter"
          >
            <option value="ALL">All Outcomes</option>
            <option value="PENDING">Pending</option>
            <option value="TREATED">Treated</option>
            <option value="VET_CALLED">Vet Called</option>
            <option value="FALSE_ALARM">False Alarm</option>
          </select>
        </div>
      </div>

      <div className="alert-list">
        {loading && alerts.length === 0 ? (
          <div className="loading-container">
            <div className="loading-spinner" />
            <span className="loading-text">Loading alerts...</span>
          </div>
        ) : filteredAlerts.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">🔔</span>
            <span>No alerts found</span>
            <span style={{ fontSize: '13px' }}>
              {severityFilter !== 'ALL' || outcomeFilter !== 'ALL'
                ? 'Try adjusting your filters'
                : 'All cattle are healthy'}
            </span>
          </div>
        ) : (
          filteredAlerts.map((alert, idx) => {
            const OutcomeIcon = OUTCOME_ICONS[alert.outcome] || HelpCircle;

            return (
              <div
                key={alert.alert_id || idx}
                className="alert-card"
                id={`alert-card-${alert.alert_id || idx}`}
              >
                <div className="alert-card-header">
                  <div className="alert-card-title">
                    <span style={{ fontSize: '18px' }}>
                      {alert.breed === 'MURRAH_BUFFALO' ? '🐃' : '🐄'}
                    </span>
                    <div>
                      <div className="alert-card-animal">{alert.animal_name || 'Unknown'}</div>
                      <div className="alert-card-type">{alert.alert_type}</div>
                    </div>
                  </div>
                  <span className={`severity-badge ${alert.severity}`}>
                    {alert.severity}
                  </span>
                </div>

                <div className="alert-card-body">
                  <div className="alert-card-vitals">
                    {alert.temp_c != null && (
                      <span className="alert-vital">
                        <Thermometer size={13} style={{ color: 'var(--state-alert)' }} />
                        {alert.temp_c.toFixed(1)}°C
                      </span>
                    )}
                    {alert.hr_bpm != null && (
                      <span className="alert-vital">
                        <Heart size={13} style={{ color: 'var(--state-emergency)' }} />
                        {alert.hr_bpm.toFixed(0)} BPM
                      </span>
                    )}
                    {alert.activity_delta != null && (
                      <span className="alert-vital">
                        <Activity size={13} style={{ color: 'var(--state-watch)' }} />
                        {alert.activity_delta > 0 ? '+' : ''}{alert.activity_delta.toFixed(0)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="alert-card-footer">
                  <span className="alert-time">
                    <Clock size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                    {formatTime(alert.timestamp)}
                  </span>
                  <span className={`outcome-badge ${alert.outcome}`}>
                    <OutcomeIcon size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                    {OUTCOME_LABELS[alert.outcome] || alert.outcome}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default AlertFeed;
