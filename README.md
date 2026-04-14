# GauDrishti 🐄

**Intelligent Livestock Health Monitoring & Virtual Fencing Platform**

An end-to-end IoT platform for Indian smallholder dairy farmers. ESP32-based smart collars monitor cattle health vitals (temperature, heart rate, activity), enforce virtual grazing zones, and alert farmers via WhatsApp — no app required.

---

## Architecture

```
┌──────────────┐     LoRa/GSM     ┌──────────────┐     Supabase     ┌────────────────┐
│  ESP32 Smart │ ───────────────► │   FastAPI     │ ──────────────► │   Supabase DB  │
│  Collar      │                  │   Backend     │                  │   (PostgreSQL) │
└──────────────┘                  └──────┬───────┘                  └────────────────┘
                                         │
                         ┌───────────────┼───────────────┐
                         │               │               │
                         ▼               ▼               ▼
                  ┌──────────┐   ┌──────────────┐  ┌──────────────┐
                  │ WhatsApp │   │  React Web   │  │  Python HW   │
                  │ (Twilio) │   │  Dashboard   │  │  Simulator   │
                  └──────────┘   └──────────────┘  └──────────────┘
```

---

## Project Structure

```
gaudrishti/
├── backend/
│   ├── main.py              # FastAPI backend server
│   ├── requirements.txt     # Python dependencies
│   └── .env.example         # Environment variables template
├── frontend/
│   ├── src/
│   │   ├── App.jsx          # Main application component
│   │   ├── index.css        # Design system & styles
│   │   ├── components/
│   │   │   ├── HerdMap.jsx      # Leaflet map with cattle markers
│   │   │   ├── AlertFeed.jsx    # Alert list with filters
│   │   │   ├── ZoneManager.jsx  # Zone drawing & management
│   │   │   └── AnimalModal.jsx  # Animal detail with charts
│   │   └── api/
│   │       └── client.js    # Axios API client
│   ├── .env                 # Frontend env vars
│   └── package.json         # Node.js dependencies
├── firmware/
│   └── gaudrishti_collar/
│       └── gaudrishti_collar.ino  # ESP32 Arduino firmware
├── simulator/
│   └── simulator.py         # Python hardware simulator
├── database/
│   └── schema.sql           # Supabase SQL schema + seed data
├── docs/
│   └── hardware_diagram.txt # ASCII wiring diagram
└── README.md                # This file
```

---

## Quick Start (Demo Mode)

Run the simulator against the local backend without any hardware:

### 1. Database Setup (Supabase)

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to SQL Editor and run `database/schema.sql`
3. Copy your project URL and service role key

### 2. Backend

```bash
cd backend

# Create virtual environment
python -m venv venv
venv\Scripts\activate  # Windows
# source venv/bin/activate  # Linux/Mac

# Install dependencies
pip install -r requirements.txt

# Configure environment
copy .env.example .env
# Edit .env with your Supabase credentials

# Run the backend
python main.py
```

The API will be available at `http://localhost:8000`. Visit `http://localhost:8000/docs` for Swagger UI.

### 3. Frontend

```bash
cd frontend

# Install dependencies
npm install

# Run development server
npm run dev
```

The dashboard will be available at `http://localhost:5173`.

### 4. Simulator

```bash
cd simulator

# Install dependencies
pip install httpx rich asyncio

# Run simulator (sends data every 30 seconds)
python simulator.py --backend-url http://localhost:8000
```

You'll see a live terminal table showing 8 simulated cattle with realistic health data. The simulator will:
- Send telemetry readings every 30 seconds
- Trigger WATCH states every 5 minutes
- Trigger ALERT states every 15 minutes (10 min duration)
- Drift GPS coordinates to simulate movement

---

## Environment Variables

### Backend (`.env`)

| Variable | Description | Required |
|----------|-------------|----------|
| `SUPABASE_URL` | Supabase project URL | ✅ |
| `SUPABASE_SERVICE_KEY` | Supabase service role key | ✅ |
| `TWILIO_ACCOUNT_SID` | Twilio account SID | For WhatsApp alerts |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | For WhatsApp alerts |
| `TWILIO_WHATSAPP_FROM` | Twilio WhatsApp sender | For WhatsApp alerts |
| `BACKEND_HOST` | Server host | Default: `0.0.0.0` |
| `BACKEND_PORT` | Server port | Default: `8000` |
| `CORS_ORIGINS` | Allowed CORS origins | Default: `localhost` |

### Frontend (`.env`)

| Variable | Description |
|----------|-------------|
| `VITE_API_BASE_URL` | Backend API URL (default: `http://localhost:8000`) |
| `VITE_COOPERATIVE_ID` | Default cooperative ID |

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/telemetry` | Receive sensor data from collar |
| `POST` | `/alert` | Create alert, send WhatsApp |
| `POST` | `/infraction` | Log zone boundary violation |
| `POST` | `/confirm` | Farmer reply (1=treated, 2=vet, 3=false alarm) |
| `GET` | `/zone-update?village_id=` | Get active zones (LoRa-compressed) |
| `GET` | `/dashboard/herd/{cooperative_id}` | Get all cattle status |
| `GET` | `/dashboard/alerts/{cooperative_id}` | Get last 50 alerts |
| `GET` | `/dashboard/device/{device_id}/history` | Get 24h sensor history |
| `POST` | `/zone/update` | Create/update zone GeoJSON |

---

## Alert State Machine

```
NORMAL → WATCH → ALERT → EMERGENCY

Transitions based on deviation from per-animal baselines:
- WATCH:     1 flag OR temp > +0.8°C OR activity < 70%
- ALERT:     2 flags (temp > +1.5°C, activity < 50%, HR > +15 BPM)
- EMERGENCY: All 3 flags crossed simultaneously

WhatsApp sent on: ALERT, EMERGENCY
GP Secretary notified on: 5+ zone infractions in 24h
```

---

## Hardware (ESP32 Smart Collar)

### Components
- **ESP32-WROOM-32** — Main MCU
- **NEO-6M GPS** — Location tracking (UART2)
- **ADXL345** — Accelerometer for activity (I2C)
- **MAX30102** — PPG sensor for HR/HRV (I2C)
- **DS18B20** — Temperature probe (OneWire)
- **Ra-02 LoRa** — Long-range communication (SPI)
- **SIM800L** — GSM for SMS/HTTP (UART1)
- **DRV2605L** — Haptic motor driver (I2C)
- **PAM8302** — Audio amplifier (PWM)
- **MicroSD** — Local data logging (SPI)

### FreeRTOS Tasks
| Task | Interval | Core | Priority | Description |
|------|----------|------|----------|-------------|
| GPSTask | 2 min | 0 | 2 | GPS fix, zone check, audio/haptic alerts |
| HealthMonitorTask | 5 min | 1 | 3 | Read all sensors, run state machine |
| GSMAlertTask | On queue | 0 | 4 | HTTP POST alerts via SIM800L |
| NightlySyncTask | 11 PM | 0 | 1 | LoRa data dump, receive zone updates |
| BaselineUpdateTask | Sun 2 AM | 0 | 1 | Recalculate rolling averages from 7 days |

See `docs/hardware_diagram.txt` for full wiring diagram.

---

## Seed Data

The schema includes realistic seed data:
- **2 Cooperatives**: Kothamangalam (Kerala), Mandya (Karnataka)
- **5 Farmers**: 3 in Kerala, 2 in Karnataka
- **8 Cattle**: Gir, Sahiwal, Tharparkar, Murrah Buffalo, Crossbred
- **3 Grazing Zones**: GeoJSON polygons with weekly schedules

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Python, FastAPI, Supabase, Twilio |
| Frontend | React, Vite, Tailwind CSS, Leaflet.js, Recharts |
| Firmware | Arduino C++, ESP32 FreeRTOS |
| Database | PostgreSQL (Supabase) with RLS |
| Simulator | Python, httpx, rich |
| Communication | LoRa (Ra-02), GSM (SIM800L) |
| Messaging | WhatsApp via Twilio |

---

## License

This project is built for Indian smallholder dairy cooperatives under the GauDrishti initiative.
