import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

const client = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Response interceptor for error handling
client.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error('[API Error]', error.response?.status, error.message);
    return Promise.reject(error);
  }
);

export const api = {
  // Health check
  health: () => client.get('/health'),

  // Dashboard endpoints
  getHerdStatus: (cooperativeId) =>
    client.get(`/dashboard/herd/${cooperativeId}`),

  getAlerts: (cooperativeId) =>
    client.get(`/dashboard/alerts/${cooperativeId}`),

  getDeviceHistory: (deviceId, hours = 24) =>
    client.get(`/dashboard/device/${deviceId}/history`, { params: { hours } }),

  // Zone endpoints
  getZones: (villageId) =>
    client.get('/zone-update', { params: { village_id: villageId } }),

  updateZone: (data) =>
    client.post('/zone/update', data),

  deleteZone: (zoneId) => 
    client.delete(`/zone/${zoneId}`),

  // Telemetry
  postTelemetry: (data) =>
    client.post('/telemetry', data),

  // Alert confirmation
  confirmAlert: (data) =>
    client.post('/confirm', data),
};

export default api;
