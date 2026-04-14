"""
GauDrishti — FastAPI Backend
Intelligent Livestock Health Monitoring & Virtual Fencing Platform
"""

import os
import json
import gzip
from datetime import datetime, timedelta, timezone
from typing import Optional, List
from enum import Enum

from fastapi import FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from supabase import create_client, Client
from twilio.rest import Client as TwilioClient

load_dotenv()

# ============================================
# Configuration
# ============================================

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
TWILIO_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_WA_FROM = os.getenv("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886")
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:5173,http://localhost:3000").split(",")

# Government Livestock Health Centres lookup (Kerala / Karnataka)
GLHC_LOOKUP = {
    "GLHC_KL_EKM_01": {
        "name": "District Veterinary Centre, Ernakulam",
        "phone": "+914842394567",
        "address": "Kakkanad, Ernakulam, Kerala 682030",
    },
    "GLHC_KL_EKM_02": {
        "name": "Taluk Veterinary Hospital, Kothamangalam",
        "phone": "+914852822345",
        "address": "Kothamangalam, Ernakulam, Kerala 686691",
    },
    "GLHC_KA_MND_01": {
        "name": "District Veterinary Hospital, Mandya",
        "phone": "+918232224567",
        "address": "Mandya Town, Mandya, Karnataka 571401",
    },
    "GLHC_KA_MND_02": {
        "name": "Taluk Veterinary Dispensary, Maddur",
        "phone": "+918232267890",
        "address": "Maddur, Mandya, Karnataka 571428",
    },
}

# ============================================
# Supabase & Twilio Clients
# ============================================

supabase: Optional[Client] = None
twilio_client: Optional[TwilioClient] = None

def get_supabase() -> Client:
    global supabase
    if supabase is None:
        if not SUPABASE_URL or not SUPABASE_KEY:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.",
            )
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    return supabase

def get_twilio() -> Optional[TwilioClient]:
    global twilio_client
    if twilio_client is None and TWILIO_SID and TWILIO_TOKEN:
        twilio_client = TwilioClient(TWILIO_SID, TWILIO_TOKEN)
    return twilio_client

# ============================================
# FastAPI App
# ============================================

app = FastAPI(
    title="GauDrishti API",
    description="Intelligent Livestock Health Monitoring & Virtual Fencing Backend",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================
# Enums & Models
# ============================================

class AlertState(str, Enum):
    NORMAL = "NORMAL"
    WATCH = "WATCH"
    ALERT = "ALERT"
    EMERGENCY = "EMERGENCY"

class SeverityLevel(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"

class OutcomeType(str, Enum):
    TREATED = "TREATED"
    VET_CALLED = "VET_CALLED"
    FALSE_ALARM = "FALSE_ALARM"
    PENDING = "PENDING"

# --- Request Models ---

class TelemetryPayload(BaseModel):
    device_id: str
    temp_c: float
    activity_index: float
    hr_bpm: float
    hrv_rmssd: Optional[float] = None
    lat: float
    lng: float
    battery_pct: float
    timestamp: Optional[str] = None

class AlertPayload(BaseModel):
    device_id: str
    alert_type: str
    temp: float
    activity_delta: float
    hr: float
    timestamp: Optional[str] = None

class InfractionPayload(BaseModel):
    device_id: str
    lat: float
    lng: float
    timestamp: Optional[str] = None
    severity: SeverityLevel = SeverityLevel.LOW

class ConfirmPayload(BaseModel):
    device_id: str
    reply_digit: int = Field(..., ge=1, le=3, description="1=treated, 2=vet called, 3=false alarm")

class ZoneUpdatePayload(BaseModel):
    village_id: str
    zone_geojson: dict
    schedule: dict

# ============================================
# Helper Functions
# ============================================

ALERT_STATE_PRIORITY = {
    "NORMAL": 0,
    "WATCH": 1,
    "ALERT": 2,
    "EMERGENCY": 3,
}

def compute_alert_state(
    temp_c: float, activity_index: float, hr_bpm: float,
    baseline_temp: float, baseline_activity: float, baseline_hr: float,
) -> str:
    """
    Alert state machine:
      NORMAL → WATCH → ALERT → EMERGENCY
    Based on deviation from device baseline values.
    """
    temp_delta = temp_c - baseline_temp
    activity_ratio = activity_index / max(baseline_activity, 1)
    hr_delta = hr_bpm - baseline_hr

    flags = 0
    # Temperature elevated > 1.5°C above baseline
    if temp_delta > 1.5:
        flags += 1
    # Activity dropped below 50% of baseline
    if activity_ratio < 0.5:
        flags += 1
    # Heart rate elevated > 15 BPM above baseline
    if hr_delta > 15:
        flags += 1

    if flags >= 3:
        return "EMERGENCY"
    elif flags >= 2:
        return "ALERT"
    elif flags >= 1 or temp_delta > 0.8 or activity_ratio < 0.7:
        return "WATCH"
    else:
        return "NORMAL"

def determine_severity(alert_state: str) -> str:
    mapping = {
        "NORMAL": "LOW",
        "WATCH": "MEDIUM",
        "ALERT": "HIGH",
        "EMERGENCY": "CRITICAL",
    }
    return mapping.get(alert_state, "LOW")

async def send_whatsapp(to_number: str, message: str) -> bool:
    """Send a WhatsApp message via Twilio."""
    client = get_twilio()
    if client is None:
        print(f"[TWILIO MOCK] To: {to_number}\n{message}")
        return False
    try:
        client.messages.create(
            body=message,
            from_=TWILIO_WA_FROM,
            to=f"whatsapp:{to_number}",
        )
        return True
    except Exception as e:
        print(f"[TWILIO ERROR] {e}")
        return False

def resolve_farmer_whatsapp(device_id: str) -> dict:
    """Resolve the farmer's WhatsApp number and GLHC from device_id."""
    db = get_supabase()
    # Get device → farmer_id
    device_res = db.table("devices").select("farmer_id").eq("device_id", device_id).execute()
    if not device_res.data:
        return {}
    farmer_id = device_res.data[0]["farmer_id"]
    # Get farmer details
    farmer_res = db.table("farmers").select("*").eq("farmer_id", farmer_id).execute()
    if not farmer_res.data:
        return {}
    return farmer_res.data[0]

# ============================================
# Endpoints
# ============================================

@app.get("/health", tags=["System"])
async def health_check():
    """Simple health check endpoint."""
    return {"status": "healthy", "service": "GauDrishti API", "timestamp": datetime.now(timezone.utc).isoformat()}


# --- POST /telemetry ---
@app.post("/telemetry", status_code=status.HTTP_201_CREATED, tags=["Telemetry"])
async def receive_telemetry(payload: TelemetryPayload):
    """
    Receives sensor data from collar. Stores to sensor_streams.
    Runs alert state machine. Triggers WhatsApp on state change to ALERT+.
    """
    db = get_supabase()
    ts = payload.timestamp or datetime.now(timezone.utc).isoformat()

    # Store sensor reading
    stream_data = {
        "device_id": payload.device_id,
        "timestamp": ts,
        "temp_c": payload.temp_c,
        "activity_index": payload.activity_index,
        "hr_bpm": payload.hr_bpm,
        "hrv_rmssd": payload.hrv_rmssd,
        "lat": payload.lat,
        "lng": payload.lng,
        "battery_pct": payload.battery_pct,
    }

    try:
        db.table("sensor_streams").insert(stream_data).execute()
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to store telemetry: {e}")

    # Get device baseline and current state
    device_res = db.table("devices").select("*").eq("device_id", payload.device_id).execute()
    if not device_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Device {payload.device_id} not found")

    device = device_res.data[0]
    old_state = device["alert_state"]

    # Compute new alert state
    new_state = compute_alert_state(
        payload.temp_c, payload.activity_index, payload.hr_bpm,
        device["baseline_temp"], device["baseline_activity"], device["baseline_hr"],
    )

    # Update device record
    update_data = {
        "last_seen": ts,
        "battery_pct": payload.battery_pct,
        "alert_state": new_state,
    }
    db.table("devices").update(update_data).eq("device_id", payload.device_id).execute()

    # On state change to ALERT or higher, trigger WhatsApp
    alert_sent = False
    if (
        ALERT_STATE_PRIORITY.get(new_state, 0) >= ALERT_STATE_PRIORITY["ALERT"]
        and ALERT_STATE_PRIORITY.get(new_state, 0) > ALERT_STATE_PRIORITY.get(old_state, 0)
    ):
        farmer = resolve_farmer_whatsapp(payload.device_id)
        if farmer:
            severity = determine_severity(new_state)
            message = (
                f"🐄 *GauDrishti Alert — {new_state}*\n\n"
                f"Animal: {device['animal_name']} ({device['breed']})\n"
                f"Temperature: {payload.temp_c:.1f}°C (baseline: {device['baseline_temp']:.1f}°C)\n"
                f"Activity: {payload.activity_index:.0f} (baseline: {device['baseline_activity']:.0f})\n"
                f"Heart Rate: {payload.hr_bpm:.0f} BPM (baseline: {device['baseline_hr']:.0f})\n"
                f"Battery: {payload.battery_pct:.0f}%\n\n"
                f"Reply:\n1️⃣ Treated at home\n2️⃣ Vet called\n3️⃣ False alarm"
            )
            alert_sent = await send_whatsapp(farmer["whatsapp_number"], message)

            # Log the alert
            alert_data = {
                "device_id": payload.device_id,
                "alert_type": f"STATE_CHANGE_{new_state}",
                "timestamp": ts,
                "temp_c": payload.temp_c,
                "activity_delta": payload.activity_index - device["baseline_activity"],
                "hr_bpm": payload.hr_bpm,
                "severity": severity,
                "farmer_notified": alert_sent or True,  # True even for mock
                "outcome": "PENDING",
            }
            db.table("alerts").insert(alert_data).execute()

    return {
        "status": "ok",
        "device_id": payload.device_id,
        "previous_state": old_state,
        "current_state": new_state,
        "alert_sent": alert_sent,
    }


# --- POST /alert ---
@app.post("/alert", status_code=status.HTTP_201_CREATED, tags=["Alerts"])
async def create_alert(payload: AlertPayload):
    """
    Receives alert data. Resolves farmer WhatsApp. Sends notification.
    For EMERGENCY, appends nearest government livestock health centre info.
    """
    db = get_supabase()
    ts = payload.timestamp or datetime.now(timezone.utc).isoformat()

    # Resolve farmer info
    farmer = resolve_farmer_whatsapp(payload.device_id)
    if not farmer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Farmer not found for device")

    # Get device info
    device_res = db.table("devices").select("*").eq("device_id", payload.device_id).execute()
    if not device_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    device = device_res.data[0]

    # Determine severity
    severity = "HIGH" if payload.alert_type == "EMERGENCY" else "MEDIUM"

    # Build WhatsApp message (English)
    # TODO: Integrate Bhashini API for regional language translation
    # bhashini_translated = bhashini_translate(message, farmer["language_code"])
    message = (
        f"🐄 *GauDrishti — {payload.alert_type} Alert*\n\n"
        f"Animal: {device['animal_name']} ({device['breed']})\n"
        f"Temperature: {payload.temp:.1f}°C\n"
        f"Activity Change: {payload.activity_delta:+.0f}\n"
        f"Heart Rate: {payload.hr:.0f} BPM\n"
        f"Time: {ts}\n\n"
        f"Reply:\n1️⃣ Treated at home\n2️⃣ Vet called\n3️⃣ False alarm"
    )

    # For EMERGENCY, append nearest GLHC info
    if payload.alert_type == "EMERGENCY" and farmer.get("glhc_id"):
        glhc = GLHC_LOOKUP.get(farmer["glhc_id"])
        if glhc:
            message += (
                f"\n\n🏥 *Nearest Vet Centre:*\n"
                f"{glhc['name']}\n"
                f"📞 {glhc['phone']}\n"
                f"📍 {glhc['address']}"
            )

    alert_sent = await send_whatsapp(farmer["whatsapp_number"], message)

    # Store alert
    alert_data = {
        "device_id": payload.device_id,
        "alert_type": payload.alert_type,
        "timestamp": ts,
        "temp_c": payload.temp,
        "activity_delta": payload.activity_delta,
        "hr_bpm": payload.hr,
        "severity": severity,
        "farmer_notified": alert_sent or True,
        "outcome": "PENDING",
    }
    db.table("alerts").insert(alert_data).execute()

    return {"status": "ok", "alert_sent": alert_sent, "farmer_name": farmer["name"]}


# --- POST /infraction ---
@app.post("/infraction", status_code=status.HTTP_201_CREATED, tags=["Infractions"])
async def log_infraction(payload: InfractionPayload):
    """
    Logs zone boundary infraction.
    If 5+ infractions in 24h for same device → WhatsApp alert to GP secretary.
    """
    db = get_supabase()
    ts = payload.timestamp or datetime.now(timezone.utc).isoformat()

    # Get device village
    device_res = db.table("devices").select("village_id, cooperative_id, animal_name").eq("device_id", payload.device_id).execute()
    if not device_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    device = device_res.data[0]

    # Store infraction
    infraction_data = {
        "device_id": payload.device_id,
        "lat": payload.lat,
        "lng": payload.lng,
        "timestamp": ts,
        "severity": payload.severity.value,
        "village_id": device["village_id"],
    }
    db.table("infractions").insert(infraction_data).execute()

    # Check 24h infraction count for this device
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    count_res = (
        db.table("infractions")
        .select("infraction_id", count="exact")
        .eq("device_id", payload.device_id)
        .gte("timestamp", cutoff)
        .execute()
    )
    infraction_count = count_res.count if count_res.count else 0

    gp_notified = False
    if infraction_count >= 5:
        # Notify GP secretary (cooperative contact)
        coop_res = (
            db.table("cooperatives")
            .select("contact_whatsapp, name")
            .eq("cooperative_id", device["cooperative_id"])
            .execute()
        )
        if coop_res.data:
            coop = coop_res.data[0]
            message = (
                f"🚨 *GauDrishti — Zone Infraction Alert*\n\n"
                f"Animal: {device['animal_name']} (Device: {payload.device_id})\n"
                f"Village: {device['village_id']}\n"
                f"Infractions in 24h: {infraction_count}\n"
                f"Last Location: {payload.lat:.6f}, {payload.lng:.6f}\n\n"
                f"Please review zone boundaries or contact the farmer."
            )
            gp_notified = await send_whatsapp(coop["contact_whatsapp"], message)

    return {
        "status": "ok",
        "infraction_count_24h": infraction_count,
        "gp_secretary_notified": gp_notified,
    }


# --- POST /confirm ---
@app.post("/confirm", status_code=status.HTTP_200_OK, tags=["Alerts"])
async def confirm_alert(payload: ConfirmPayload):
    """
    Receives farmer reply: 1=treated, 2=vet called, 3=false alarm.
    Updates the most recent PENDING alert for this device.
    """
    outcome_map = {
        1: "TREATED",
        2: "VET_CALLED",
        3: "FALSE_ALARM",
    }
    outcome = outcome_map.get(payload.reply_digit, "PENDING")

    db = get_supabase()

    # Find the most recent PENDING alert for this device
    alert_res = (
        db.table("alerts")
        .select("alert_id")
        .eq("device_id", payload.device_id)
        .eq("outcome", "PENDING")
        .order("timestamp", desc=True)
        .limit(1)
        .execute()
    )

    if not alert_res.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No pending alert found for this device")

    alert_id = alert_res.data[0]["alert_id"]
    now = datetime.now(timezone.utc).isoformat()

    db.table("alerts").update({
        "outcome": outcome,
        "outcome_ts": now,
        "vet_confirmed": outcome == "VET_CALLED",
    }).eq("alert_id", alert_id).execute()

    # If treated or vet called, reset device to NORMAL
    if outcome in ("TREATED", "VET_CALLED"):
        db.table("devices").update({"alert_state": "NORMAL"}).eq("device_id", payload.device_id).execute()

    return {"status": "ok", "alert_id": alert_id, "outcome": outcome}


# --- GET /zone-update ---
@app.get("/zone-update", tags=["Zones"])
async def get_zone_update(village_id: str = Query(..., description="Village ID")):
    """
    Returns active zone GeoJSON for a village for next 24 hours.
    Response compressed under 4KB for LoRa transmission.
    """
    db = get_supabase()

    zones_res = (
        db.table("zones")
        .select("zone_id, zone_geojson, schedule")
        .eq("village_id", village_id)
        .eq("active", True)
        .execute()
    )

    if not zones_res.data:
        return JSONResponse(content={"type": "FeatureCollection", "features": []})

    # Build minimal GeoJSON FeatureCollection
    features = []
    for z in zones_res.data:
        geojson = z["zone_geojson"] if isinstance(z["zone_geojson"], dict) else json.loads(z["zone_geojson"])
        geojson["properties"]["zone_id"] = z["zone_id"]
        geojson["properties"]["schedule"] = z["schedule"]
        features.append(geojson)

    collection = {"type": "FeatureCollection", "features": features}

    # Compress for LoRa — check size
    json_bytes = json.dumps(collection, separators=(",", ":")).encode("utf-8")
    compressed = gzip.compress(json_bytes)

    if len(compressed) > 4096:
        # Simplify coordinates if too large
        return JSONResponse(
            content=collection,
            headers={"X-Compressed-Size": str(len(compressed)), "X-Warning": "Payload exceeds 4KB LoRa limit"},
        )

    return JSONResponse(
        content=collection,
        headers={"X-Compressed-Size": str(len(compressed))},
    )


# --- GET /dashboard/herd/{cooperative_id} ---
@app.get("/dashboard/herd/{cooperative_id}", tags=["Dashboard"])
async def get_herd_status(cooperative_id: str):
    """Returns all cattle status for a cooperative."""
    db = get_supabase()

    devices_res = (
        db.table("devices")
        .select("device_id, animal_name, breed, alert_state, battery_pct, last_seen, village_id, baseline_temp, baseline_activity, baseline_hr")
        .eq("cooperative_id", cooperative_id)
        .execute()
    )

    if not devices_res.data:
        return {"cooperative_id": cooperative_id, "cattle": [], "total": 0}

    cattle = []
    for d in devices_res.data:
        # Get latest sensor reading for this device
        latest_res = (
            db.table("sensor_streams")
            .select("temp_c, activity_index, hr_bpm, lat, lng, battery_pct, timestamp")
            .eq("device_id", d["device_id"])
            .order("timestamp", desc=True)
            .limit(1)
            .execute()
        )

        latest = latest_res.data[0] if latest_res.data else {}

        cattle.append({
            "device_id": d["device_id"],
            "animal_name": d["animal_name"],
            "breed": d["breed"],
            "last_temp": latest.get("temp_c"),
            "last_activity": latest.get("activity_index"),
            "last_hr": latest.get("hr_bpm"),
            "battery_pct": latest.get("battery_pct", d["battery_pct"]),
            "alert_state": d["alert_state"],
            "lat": latest.get("lat"),
            "lng": latest.get("lng"),
            "last_seen": latest.get("timestamp", d["last_seen"]),
        })

    return {"cooperative_id": cooperative_id, "cattle": cattle, "total": len(cattle)}


# --- GET /dashboard/alerts/{cooperative_id} ---
@app.get("/dashboard/alerts/{cooperative_id}", tags=["Dashboard"])
async def get_cooperative_alerts(cooperative_id: str):
    """Returns last 50 alerts for the cooperative with outcome labels."""
    db = get_supabase()

    # Get all device_ids for this cooperative
    devices_res = (
        db.table("devices")
        .select("device_id, animal_name, breed")
        .eq("cooperative_id", cooperative_id)
        .execute()
    )

    if not devices_res.data:
        return {"cooperative_id": cooperative_id, "alerts": [], "total": 0}

    device_map = {d["device_id"]: d for d in devices_res.data}
    device_ids = list(device_map.keys())

    # Get latest 50 alerts for these devices
    alerts_res = (
        db.table("alerts")
        .select("*")
        .in_("device_id", device_ids)
        .order("timestamp", desc=True)
        .limit(50)
        .execute()
    )

    enriched_alerts = []
    for a in (alerts_res.data or []):
        device_info = device_map.get(a["device_id"], {})
        enriched_alerts.append({
            **a,
            "animal_name": device_info.get("animal_name", "Unknown"),
            "breed": device_info.get("breed", "Unknown"),
        })

    return {"cooperative_id": cooperative_id, "alerts": enriched_alerts, "total": len(enriched_alerts)}


# --- POST /zone/update ---
@app.post("/zone/update", status_code=status.HTTP_201_CREATED, tags=["Zones"])
async def update_zone(payload: ZoneUpdatePayload):
    """GP secretary posts updated zone GeoJSON and schedule for a village."""
    db = get_supabase()

    zone_data = {
        "village_id": payload.village_id,
        "zone_geojson": payload.zone_geojson,
        "schedule": payload.schedule,
        "active": True,
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }

    try:
        result = db.table("zones").insert(zone_data).execute()
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to create zone: {e}")

    return {"status": "ok", "zone_id": result.data[0]["zone_id"] if result.data else None}


# --- GET /dashboard/device/{device_id}/history ---
@app.get("/dashboard/device/{device_id}/history", tags=["Dashboard"])
async def get_device_history(device_id: str, hours: int = Query(24, ge=1, le=168)):
    """Returns sensor history for a device over the specified hours."""
    db = get_supabase()

    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()

    # Get sensor history
    history_res = (
        db.table("sensor_streams")
        .select("timestamp, temp_c, activity_index, hr_bpm, hrv_rmssd, lat, lng, battery_pct")
        .eq("device_id", device_id)
        .gte("timestamp", cutoff)
        .order("timestamp", desc=False)
        .execute()
    )

    # Get alert history
    alerts_res = (
        db.table("alerts")
        .select("*")
        .eq("device_id", device_id)
        .gte("timestamp", cutoff)
        .order("timestamp", desc=True)
        .execute()
    )

    return {
        "device_id": device_id,
        "hours": hours,
        "sensor_data": history_res.data or [],
        "alerts": alerts_res.data or [],
    }


# ============================================
# Entry Point
# ============================================

if __name__ == "__main__":
    import uvicorn
    host = os.getenv("BACKEND_HOST", "0.0.0.0")
    port = int(os.getenv("BACKEND_PORT", "8000"))
    uvicorn.run("main:app", host=host, port=port, reload=True)
