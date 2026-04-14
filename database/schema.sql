-- ============================================
-- GauDrishti — Supabase Database Schema
-- Intelligent Livestock Health Monitoring
-- ============================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- ============================================
-- ENUM TYPES
-- ============================================

CREATE TYPE breed_type AS ENUM (
  'GIR',
  'SAHIWAL',
  'THARPARKAR',
  'MURRAH_BUFFALO',
  'CROSSBRED'
);

CREATE TYPE alert_state_type AS ENUM (
  'NORMAL',
  'WATCH',
  'ALERT',
  'EMERGENCY'
);

CREATE TYPE severity_type AS ENUM (
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL'
);

CREATE TYPE outcome_type AS ENUM (
  'TREATED',
  'VET_CALLED',
  'FALSE_ALARM',
  'PENDING'
);

-- ============================================
-- TABLES
-- ============================================

-- Cooperatives
CREATE TABLE cooperatives (
  cooperative_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  contact_whatsapp TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Farmers
CREATE TABLE farmers (
  farmer_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  whatsapp_number TEXT NOT NULL,
  language_code TEXT NOT NULL DEFAULT 'en',
  cooperative_id UUID NOT NULL REFERENCES cooperatives(cooperative_id) ON DELETE CASCADE,
  village_id TEXT NOT NULL,
  location_lat DOUBLE PRECISION,
  location_lng DOUBLE PRECISION,
  glhc_id TEXT,  -- Government Livestock Health Centre ID
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Devices (Smart Collars)
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  farmer_id UUID NOT NULL REFERENCES farmers(farmer_id) ON DELETE CASCADE,
  animal_name TEXT NOT NULL,
  breed breed_type NOT NULL,
  age_months INTEGER NOT NULL DEFAULT 24,
  cooperative_id UUID NOT NULL REFERENCES cooperatives(cooperative_id) ON DELETE CASCADE,
  village_id TEXT NOT NULL,
  baseline_temp DOUBLE PRECISION NOT NULL DEFAULT 38.5,
  baseline_activity DOUBLE PRECISION NOT NULL DEFAULT 500.0,
  baseline_hr DOUBLE PRECISION NOT NULL DEFAULT 65.0,
  baseline_updated_at TIMESTAMPTZ DEFAULT NOW(),
  alert_state alert_state_type NOT NULL DEFAULT 'NORMAL',
  last_seen TIMESTAMPTZ,
  battery_pct DOUBLE PRECISION DEFAULT 100.0,
  firmware_version TEXT DEFAULT '1.0.0',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Alerts
CREATE TABLE alerts (
  alert_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  temp_c DOUBLE PRECISION,
  activity_delta DOUBLE PRECISION,
  hr_bpm DOUBLE PRECISION,
  severity severity_type NOT NULL DEFAULT 'LOW',
  farmer_notified BOOLEAN NOT NULL DEFAULT FALSE,
  outcome outcome_type NOT NULL DEFAULT 'PENDING',
  outcome_ts TIMESTAMPTZ,
  vet_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sensor Streams (partitioned by date for performance)
CREATE TABLE sensor_streams (
  stream_id UUID NOT NULL DEFAULT uuid_generate_v4(),
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  temp_c DOUBLE PRECISION,
  activity_index DOUBLE PRECISION,
  hr_bpm DOUBLE PRECISION,
  hrv_rmssd DOUBLE PRECISION,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  battery_pct DOUBLE PRECISION,
  PRIMARY KEY (stream_id, timestamp)
) PARTITION BY RANGE (timestamp);

-- Create monthly partitions for sensor_streams (next 12 months)
CREATE TABLE sensor_streams_2026_01 PARTITION OF sensor_streams
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE sensor_streams_2026_02 PARTITION OF sensor_streams
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE sensor_streams_2026_03 PARTITION OF sensor_streams
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE sensor_streams_2026_04 PARTITION OF sensor_streams
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE sensor_streams_2026_05 PARTITION OF sensor_streams
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE sensor_streams_2026_06 PARTITION OF sensor_streams
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE sensor_streams_2026_07 PARTITION OF sensor_streams
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE sensor_streams_2026_08 PARTITION OF sensor_streams
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE sensor_streams_2026_09 PARTITION OF sensor_streams
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE sensor_streams_2026_10 PARTITION OF sensor_streams
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE sensor_streams_2026_11 PARTITION OF sensor_streams
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE sensor_streams_2026_12 PARTITION OF sensor_streams
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- Zones (Virtual Fencing)
CREATE TABLE zones (
  zone_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  village_id TEXT NOT NULL,
  gp_id TEXT,
  zone_geojson JSONB NOT NULL,
  schedule JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Infractions (Zone boundary violations)
CREATE TABLE infractions (
  infraction_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity severity_type NOT NULL DEFAULT 'LOW',
  village_id TEXT NOT NULL
);

-- ============================================
-- INDEXES
-- ============================================

-- Sensor streams: fast lookup by device and time range
CREATE INDEX idx_sensor_streams_device_ts ON sensor_streams (device_id, timestamp DESC);
CREATE INDEX idx_sensor_streams_timestamp ON sensor_streams (timestamp DESC);

-- Alerts: fast lookup by device and cooperative
CREATE INDEX idx_alerts_device_id ON alerts (device_id);
CREATE INDEX idx_alerts_timestamp ON alerts (timestamp DESC);

-- Devices: lookup by cooperative and village
CREATE INDEX idx_devices_cooperative ON devices (cooperative_id);
CREATE INDEX idx_devices_village ON devices (village_id);
CREATE INDEX idx_devices_farmer ON devices (farmer_id);

-- Infractions: lookup by device and time window
CREATE INDEX idx_infractions_device_ts ON infractions (device_id, timestamp DESC);
CREATE INDEX idx_infractions_village ON infractions (village_id);

-- Zones: lookup by village
CREATE INDEX idx_zones_village ON zones (village_id);
CREATE INDEX idx_zones_active ON zones (active) WHERE active = TRUE;

-- Farmers: lookup by cooperative
CREATE INDEX idx_farmers_cooperative ON farmers (cooperative_id);

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================

ALTER TABLE cooperatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE farmers ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensor_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE infractions ENABLE ROW LEVEL SECURITY;

-- Policy: Cooperative admins can only read their own cooperative's data
-- Uses Supabase auth.uid() mapped to cooperative_id via a user_roles table or JWT claim

-- Cooperatives: users can only see their own cooperative
CREATE POLICY "cooperative_isolation" ON cooperatives
  FOR SELECT
  USING (cooperative_id = (current_setting('request.jwt.claims', true)::json->>'cooperative_id')::uuid);

-- Farmers: users can only see farmers in their cooperative
CREATE POLICY "farmer_cooperative_isolation" ON farmers
  FOR SELECT
  USING (cooperative_id = (current_setting('request.jwt.claims', true)::json->>'cooperative_id')::uuid);

-- Devices: users can only see devices in their cooperative
CREATE POLICY "device_cooperative_isolation" ON devices
  FOR SELECT
  USING (cooperative_id = (current_setting('request.jwt.claims', true)::json->>'cooperative_id')::uuid);

-- Alerts: users can only see alerts for devices in their cooperative
CREATE POLICY "alert_cooperative_isolation" ON alerts
  FOR SELECT
  USING (
    device_id IN (
      SELECT device_id FROM devices
      WHERE cooperative_id = (current_setting('request.jwt.claims', true)::json->>'cooperative_id')::uuid
    )
  );

-- Sensor streams: users can only see streams for devices in their cooperative
CREATE POLICY "stream_cooperative_isolation" ON sensor_streams
  FOR SELECT
  USING (
    device_id IN (
      SELECT device_id FROM devices
      WHERE cooperative_id = (current_setting('request.jwt.claims', true)::json->>'cooperative_id')::uuid
    )
  );

-- Zones: users can only see zones in their villages
CREATE POLICY "zone_village_isolation" ON zones
  FOR ALL
  USING (
    village_id IN (
      SELECT DISTINCT village_id FROM devices
      WHERE cooperative_id = (current_setting('request.jwt.claims', true)::json->>'cooperative_id')::uuid
    )
  );

-- Infractions: users can only see infractions for their cooperative's devices
CREATE POLICY "infraction_cooperative_isolation" ON infractions
  FOR SELECT
  USING (
    device_id IN (
      SELECT device_id FROM devices
      WHERE cooperative_id = (current_setting('request.jwt.claims', true)::json->>'cooperative_id')::uuid
    )
  );

-- Service role bypass for backend operations
CREATE POLICY "service_role_all_cooperatives" ON cooperatives FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_farmers" ON farmers FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_devices" ON devices FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_alerts" ON alerts FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_streams" ON sensor_streams FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_zones" ON zones FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all_infractions" ON infractions FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- SEED DATA
-- ============================================

-- Insert Cooperatives
INSERT INTO cooperatives (cooperative_id, name, state, contact_whatsapp) VALUES
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Kothamangalam Dairy Cooperative', 'Kerala', '+919876543210'),
  ('b2c3d4e5-f6a7-8901-bcde-f12345678901', 'Mandya Milk Producers Cooperative', 'Karnataka', '+919876543211');

-- Insert Farmers
INSERT INTO farmers (farmer_id, name, whatsapp_number, language_code, cooperative_id, village_id, location_lat, location_lng, glhc_id) VALUES
  ('f1000001-0000-0000-0000-000000000001', 'Rajan Nair', '+919845001001', 'ml', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'VLG_KOTHM_01', 10.0530, 76.9210, 'GLHC_KL_EKM_01'),
  ('f1000001-0000-0000-0000-000000000002', 'Meera Kumari', '+919845001002', 'ml', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'VLG_KOTHM_01', 10.0545, 76.9225, 'GLHC_KL_EKM_01'),
  ('f1000001-0000-0000-0000-000000000003', 'Suresh Menon', '+919845001003', 'ml', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'VLG_KOTHM_02', 10.0610, 76.9180, 'GLHC_KL_EKM_02'),
  ('f1000001-0000-0000-0000-000000000004', 'Rajesh Hegde', '+919845002001', 'kn', 'b2c3d4e5-f6a7-8901-bcde-f12345678901', 'VLG_MNDY_01', 12.5226, 76.8951, 'GLHC_KA_MND_01'),
  ('f1000001-0000-0000-0000-000000000005', 'Lakshmi Devi', '+919845002002', 'kn', 'b2c3d4e5-f6a7-8901-bcde-f12345678901', 'VLG_MNDY_01', 12.5240, 76.8970, 'GLHC_KA_MND_01');

-- Insert Devices (8 cattle with realistic Kerala/Karnataka coordinates)
INSERT INTO devices (device_id, farmer_id, animal_name, breed, age_months, cooperative_id, village_id, baseline_temp, baseline_activity, baseline_hr) VALUES
  ('GD-KL-001', 'f1000001-0000-0000-0000-000000000001', 'Lakshmi', 'GIR', 48, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'VLG_KOTHM_01', 38.2, 520, 68),
  ('GD-KL-002', 'f1000001-0000-0000-0000-000000000001', 'Gauri', 'SAHIWAL', 36, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'VLG_KOTHM_01', 38.4, 480, 64),
  ('GD-KL-003', 'f1000001-0000-0000-0000-000000000002', 'Nandini', 'CROSSBRED', 60, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'VLG_KOTHM_01', 38.6, 510, 70),
  ('GD-KL-004', 'f1000001-0000-0000-0000-000000000003', 'Kamala', 'GIR', 30, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'VLG_KOTHM_02', 38.3, 540, 66),
  ('GD-KL-005', 'f1000001-0000-0000-0000-000000000003', 'Bhavani', 'MURRAH_BUFFALO', 42, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'VLG_KOTHM_02', 37.8, 460, 60),
  ('GD-KA-001', 'f1000001-0000-0000-0000-000000000004', 'Ganga', 'THARPARKAR', 54, 'b2c3d4e5-f6a7-8901-bcde-f12345678901', 'VLG_MNDY_01', 38.5, 500, 65),
  ('GD-KA-002', 'f1000001-0000-0000-0000-000000000004', 'Kaveri', 'SAHIWAL', 28, 'b2c3d4e5-f6a7-8901-bcde-f12345678901', 'VLG_MNDY_01', 38.3, 490, 63),
  ('GD-KA-003', 'f1000001-0000-0000-0000-000000000005', 'Tulsi', 'MURRAH_BUFFALO', 66, 'b2c3d4e5-f6a7-8901-bcde-f12345678901', 'VLG_MNDY_01', 37.9, 470, 62);

-- Insert Zones (3 zones with GeoJSON polygons)
INSERT INTO zones (village_id, gp_id, zone_geojson, schedule, active) VALUES
  (
    'VLG_KOTHM_01',
    'GP_KOTHM',
    '{
      "type": "Feature",
      "properties": {"name": "Kothamangalam Grazing Zone A", "color": "#2D6A4F"},
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[76.9150, 10.0500], [76.9280, 10.0500], [76.9280, 10.0580], [76.9150, 10.0580], [76.9150, 10.0500]]]
      }
    }',
    '{"monday": true, "tuesday": true, "wednesday": true, "thursday": true, "friday": true, "saturday": false, "sunday": false}',
    TRUE
  ),
  (
    'VLG_KOTHM_02',
    'GP_KOTHM',
    '{
      "type": "Feature",
      "properties": {"name": "Kothamangalam Grazing Zone B", "color": "#40916C"},
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[76.9120, 10.0580], [76.9250, 10.0580], [76.9250, 10.0660], [76.9120, 10.0660], [76.9120, 10.0580]]]
      }
    }',
    '{"monday": false, "tuesday": false, "wednesday": true, "thursday": true, "friday": true, "saturday": true, "sunday": true}',
    TRUE
  ),
  (
    'VLG_MNDY_01',
    'GP_MANDYA',
    '{
      "type": "Feature",
      "properties": {"name": "Mandya Grazing Zone", "color": "#52B788"},
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[76.8900, 12.5200], [76.9020, 12.5200], [76.9020, 12.5280], [76.8900, 12.5280], [76.8900, 12.5200]]]
      }
    }',
    '{"monday": true, "tuesday": true, "wednesday": true, "thursday": true, "friday": true, "saturday": true, "sunday": false}',
    TRUE
  );
