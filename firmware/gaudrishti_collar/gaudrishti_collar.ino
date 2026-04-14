/*
 * ============================================================
 * GauDrishti — Smart Cattle Collar Firmware
 * ESP32-WROOM-32 + FreeRTOS
 * 
 * Intelligent Livestock Health Monitoring & Virtual Fencing
 * ============================================================
 * 
 * Hardware:
 *   - ESP32-WROOM-32 (main MCU)
 *   - NEO-6M GPS (UART2)
 *   - ADXL345 Accelerometer (I2C)
 *   - MAX30102 PPG Sensor (I2C)
 *   - DS18B20 Temperature Probe (OneWire)
 *   - Ra-02 LoRa Module (SPI)
 *   - SIM800L GSM Module (UART1)
 *   - DRV2605L Haptic Driver (I2C)
 *   - PAM8302 Audio Amplifier (PWM)
 *   - MicroSD Card (SPI)
 * ============================================================
 */

#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <TinyGPS++.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <LoRa.h>
#include <SD.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <esp_sleep.h>
#include <time.h>

// ============================================================
// CONFIGURATION CONSTANTS
// ============================================================

// Device Identity
#define DEVICE_ID        "GD-KL-001"
#define BACKEND_URL      "http://api.gaudrishti.in"
#define VILLAGE_ID       "VLG_KOTHM_01"
#define FIRMWARE_VERSION "1.0.0"

// --- Pin Definitions ---

// I2C Bus (shared: ADXL345, MAX30102, DRV2605L)
#define I2C_SDA          21
#define I2C_SCL          22

// UART2 — NEO-6M GPS
#define GPS_TX           16
#define GPS_RX           17

// UART1 — SIM800L GSM
#define GSM_TX           26
#define GSM_RX           27

// SPI Bus
#define LORA_SS          5
#define LORA_RST         14
#define LORA_DIO0        2
#define SD_CS            15

// OneWire — DS18B20
#define ONEWIRE_PIN      4

// PWM Audio — PAM8302
#define AUDIO_PIN        25

// --- I2C Addresses ---
#define ADXL345_ADDR     0x53
#define MAX30102_ADDR    0x57
#define DRV2605L_ADDR    0x5A

// --- Baseline Defaults (first boot) ---
#define DEFAULT_BASELINE_TEMP     38.5f
#define DEFAULT_BASELINE_ACTIVITY 500.0f
#define DEFAULT_BASELINE_HR       65.0f

// --- Alert Thresholds ---
#define TEMP_ALERT_DELTA      1.5f   // °C above baseline
#define ACTIVITY_ALERT_RATIO  0.5f   // Below 50% of baseline
#define HR_ALERT_DELTA        15.0f  // BPM above baseline
#define ZONE_WARNING_METERS   20.0f  // Distance from boundary for warning

// --- Timing ---
#define GPS_INTERVAL_MS       (2 * 60 * 1000)    // 2 minutes
#define HEALTH_INTERVAL_MS    (5 * 60 * 1000)    // 5 minutes
#define NIGHTLY_SYNC_HOUR     23                  // 11 PM
#define BASELINE_UPDATE_DAY   0                   // Sunday (0 = Sunday)
#define BASELINE_UPDATE_HOUR  2                   // 2 AM

// --- FreeRTOS ---
#define STACK_SIZE_GPS        4096
#define STACK_SIZE_HEALTH     8192
#define STACK_SIZE_GSM        8192
#define STACK_SIZE_NIGHTLY    8192
#define STACK_SIZE_BASELINE   4096

// ============================================================
// GLOBAL OBJECTS
// ============================================================

// GPS
HardwareSerial gpsSerial(2);
TinyGPSPlus gps;

// GSM
HardwareSerial gsmSerial(1);

// Temperature
OneWire oneWire(ONEWIRE_PIN);
DallasTemperature tempSensor(&oneWire);

// Persistent Storage
Preferences preferences;

// SD Card logging
File logFile;

// FreeRTOS Queue for GSM alerts
QueueHandle_t gsmAlertQueue;

// ============================================================
// SHARED DATA STRUCTURES
// ============================================================

struct GeoPosition {
  double lat;
  double lng;
  bool valid;
  unsigned long timestamp;
};

struct HealthData {
  float temp_c;
  float activity_index;
  float hr_bpm;
  float hrv_rmssd;
  float battery_pct;
};

struct Baseline {
  float temp;
  float activity;
  float hr;
};

enum AlertState {
  STATE_NORMAL,
  STATE_WATCH,
  STATE_ALERT,
  STATE_EMERGENCY
};

struct AlertMessage {
  char device_id[16];
  float temp_c;
  float activity_index;
  float hr_bpm;
  float hrv_rmssd;
  double lat;
  double lng;
  float battery_pct;
  AlertState state;
};

// Global shared variables (protected by mutex in production)
volatile GeoPosition currentPosition = {0.0, 0.0, false, 0};
volatile AlertState currentAlertState = STATE_NORMAL;
volatile float currentBatteryPct = 100.0;
Baseline baseline = {DEFAULT_BASELINE_TEMP, DEFAULT_BASELINE_ACTIVITY, DEFAULT_BASELINE_HR};

// Zone boundary (loaded from SD card)
struct ZoneBoundary {
  double polygon[20][2];  // Max 20 vertices [lat, lng]
  int vertexCount;
  bool loaded;
};
ZoneBoundary activeZone = {{}, 0, false};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/**
 * Read battery voltage from ADC and convert to percentage.
 * Assumes voltage divider on ADC pin 35 for LiPo monitoring.
 */
float readBatteryPercent() {
  int raw = analogRead(35);
  float voltage = (raw / 4095.0) * 3.3 * 2.0;  // Voltage divider factor 2
  // LiPo: 4.2V = 100%, 3.0V = 0%
  float pct = ((voltage - 3.0) / (4.2 - 3.0)) * 100.0;
  return constrain(pct, 0.0, 100.0);
}

/**
 * Point-in-polygon test using ray casting algorithm.
 */
bool isInsideZone(double lat, double lng, ZoneBoundary& zone) {
  if (!zone.loaded || zone.vertexCount < 3) return true;  // No zone = always inside
  
  bool inside = false;
  int j = zone.vertexCount - 1;
  
  for (int i = 0; i < zone.vertexCount; i++) {
    if ((zone.polygon[i][0] > lat) != (zone.polygon[j][0] > lat) &&
        (lng < (zone.polygon[j][1] - zone.polygon[i][1]) * 
         (lat - zone.polygon[i][0]) / (zone.polygon[j][0] - zone.polygon[i][0]) + 
         zone.polygon[i][1])) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

/**
 * Calculate approximate distance from point to polygon boundary in meters.
 * Uses Haversine formula for each edge.
 */
double distanceToEdge(double lat1, double lng1, double lat2, double lng2, double plat, double plng) {
  // Simplified: perpendicular distance from point to line segment
  double R = 6371000.0;  // Earth radius in meters
  double dLat = radians(plat - lat1);
  double dLng = radians(plng - lng1);
  double a = sin(dLat / 2) * sin(dLat / 2) +
             cos(radians(lat1)) * cos(radians(plat)) *
             sin(dLng / 2) * sin(dLng / 2);
  return R * 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
}

double distanceToBoundary(double lat, double lng, ZoneBoundary& zone) {
  double minDist = 999999.0;
  for (int i = 0; i < zone.vertexCount; i++) {
    int j = (i + 1) % zone.vertexCount;
    double d = distanceToEdge(zone.polygon[i][0], zone.polygon[i][1],
                               zone.polygon[j][0], zone.polygon[j][1],
                               lat, lng);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/**
 * Play audio warning tone via PAM8302.
 */
void playWarningTone(int frequency, int durationMs) {
  ledcSetup(0, frequency, 8);
  ledcAttachPin(AUDIO_PIN, 0);
  ledcWrite(0, 128);  // 50% duty cycle
  delay(durationMs);
  ledcWrite(0, 0);
  ledcDetachPin(AUDIO_PIN);
}

/**
 * Trigger haptic feedback via DRV2605L.
 */
void triggerHaptic(uint8_t waveform) {
  Wire.beginTransmission(DRV2605L_ADDR);
  Wire.write(0x01);  // Mode register
  Wire.write(0x00);  // Internal trigger
  Wire.endTransmission();
  
  Wire.beginTransmission(DRV2605L_ADDR);
  Wire.write(0x04);  // Waveform register
  Wire.write(waveform);
  Wire.endTransmission();
  
  Wire.beginTransmission(DRV2605L_ADDR);
  Wire.write(0x05);  // End of waveform
  Wire.write(0x00);
  Wire.endTransmission();
  
  Wire.beginTransmission(DRV2605L_ADDR);
  Wire.write(0x0C);  // GO register
  Wire.write(0x01);
  Wire.endTransmission();
}

/**
 * Log data to SD card in CSV format.
 */
void logToSD(const char* filename, const char* data) {
  logFile = SD.open(filename, FILE_APPEND);
  if (logFile) {
    logFile.println(data);
    logFile.close();
  }
}

/**
 * Load zone GeoJSON from SD card.
 */
void loadZoneFromSD() {
  File zoneFile = SD.open("/zone.json", FILE_READ);
  if (!zoneFile) {
    Serial.println("[ZONE] No zone file found on SD");
    return;
  }
  
  StaticJsonDocument<4096> doc;
  DeserializationError error = deserializeJson(doc, zoneFile);
  zoneFile.close();
  
  if (error) {
    Serial.printf("[ZONE] JSON parse error: %s\n", error.c_str());
    return;
  }
  
  // Parse first feature's polygon coordinates
  JsonArray features = doc["features"];
  if (features.size() == 0) return;
  
  JsonArray coords = features[0]["geometry"]["coordinates"][0];
  activeZone.vertexCount = min((int)coords.size(), 20);
  
  for (int i = 0; i < activeZone.vertexCount; i++) {
    activeZone.polygon[i][1] = coords[i][0];  // lng → [0] in GeoJSON but [1] in our struct
    activeZone.polygon[i][0] = coords[i][1];  // lat → [1] in GeoJSON but [0] in our struct
  }
  activeZone.loaded = true;
  Serial.printf("[ZONE] Loaded zone with %d vertices\n", activeZone.vertexCount);
}

// ============================================================
// SENSOR READING FUNCTIONS
// ============================================================

/**
 * Initialize ADXL345 accelerometer.
 */
void initADXL345() {
  Wire.beginTransmission(ADXL345_ADDR);
  Wire.write(0x2D);  // Power control register
  Wire.write(0x08);  // Measure mode
  Wire.endTransmission();
  
  Wire.beginTransmission(ADXL345_ADDR);
  Wire.write(0x31);  // Data format register
  Wire.write(0x0B);  // Full resolution, ±16g
  Wire.endTransmission();
  
  Wire.beginTransmission(ADXL345_ADDR);
  Wire.write(0x2C);  // Bandwidth rate register
  Wire.write(0x0A);  // 100 Hz
  Wire.endTransmission();
  
  Serial.println("[ADXL345] Initialized");
}

/**
 * Read accelerometer and compute activity index.
 * Sum of magnitude over sampling period.
 */
float readActivityIndex(int sampleDurationMs) {
  float totalMagnitude = 0;
  int samples = 0;
  unsigned long start = millis();
  
  while (millis() - start < (unsigned long)sampleDurationMs) {
    Wire.beginTransmission(ADXL345_ADDR);
    Wire.write(0x32);  // Data register start
    Wire.endTransmission(false);
    Wire.requestFrom(ADXL345_ADDR, 6);
    
    if (Wire.available() >= 6) {
      int16_t x = Wire.read() | (Wire.read() << 8);
      int16_t y = Wire.read() | (Wire.read() << 8);
      int16_t z = Wire.read() | (Wire.read() << 8);
      
      float fx = x * 0.0039;  // Convert to g (3.9mg/LSB at full resolution)
      float fy = y * 0.0039;
      float fz = z * 0.0039;
      
      float magnitude = sqrt(fx * fx + fy * fy + fz * fz);
      totalMagnitude += abs(magnitude - 1.0);  // Subtract gravity
      samples++;
    }
    delay(10);  // ~100 Hz sampling
  }
  
  // Normalize to a 0–1000 activity index
  return (totalMagnitude / max(samples, 1)) * 1000.0;
}

/**
 * Initialize MAX30102 PPG sensor.
 */
void initMAX30102() {
  // Reset
  Wire.beginTransmission(MAX30102_ADDR);
  Wire.write(0x09);  // Mode Config
  Wire.write(0x40);  // Reset
  Wire.endTransmission();
  delay(100);
  
  // SPO2 mode
  Wire.beginTransmission(MAX30102_ADDR);
  Wire.write(0x09);
  Wire.write(0x03);  // SPO2 mode
  Wire.endTransmission();
  
  // SPO2 config: 100 SPS, 411μs pulse, 18-bit ADC
  Wire.beginTransmission(MAX30102_ADDR);
  Wire.write(0x0A);
  Wire.write(0x27);
  Wire.endTransmission();
  
  // LED pulse amplitudes
  Wire.beginTransmission(MAX30102_ADDR);
  Wire.write(0x0C);  // LED1 (Red)
  Wire.write(0x24);  // 7.2mA
  Wire.endTransmission();
  
  Wire.beginTransmission(MAX30102_ADDR);
  Wire.write(0x0D);  // LED2 (IR)
  Wire.write(0x24);
  Wire.endTransmission();
  
  Serial.println("[MAX30102] Initialized");
}

/**
 * Read heart rate and HRV from MAX30102.
 * Simplified peak detection algorithm.
 */
void readHeartRate(float* hr_bpm, float* hrv_rmssd) {
  // Collect IR samples for 15 seconds
  uint32_t irBuffer[1500];
  int sampleCount = 0;
  unsigned long start = millis();
  
  while (millis() - start < 15000 && sampleCount < 1500) {
    Wire.beginTransmission(MAX30102_ADDR);
    Wire.write(0x07);  // FIFO data register
    Wire.endTransmission(false);
    Wire.requestFrom(MAX30102_ADDR, 6);
    
    if (Wire.available() >= 6) {
      // Skip red LED data (3 bytes)
      Wire.read(); Wire.read(); Wire.read();
      // Read IR data (3 bytes, 18-bit)
      uint32_t ir = ((uint32_t)Wire.read() << 16) | 
                    ((uint32_t)Wire.read() << 8) | 
                    Wire.read();
      ir &= 0x03FFFF;
      irBuffer[sampleCount++] = ir;
    }
    delay(10);
  }
  
  if (sampleCount < 100) {
    *hr_bpm = baseline.hr;  // Fallback to baseline
    *hrv_rmssd = 40.0;
    return;
  }
  
  // Simple peak detection for heart rate
  int peaks[50];
  int peakCount = 0;
  float threshold = 0;
  
  // Calculate mean
  float sum = 0;
  for (int i = 0; i < sampleCount; i++) sum += irBuffer[i];
  threshold = sum / sampleCount * 1.02;  // 2% above mean
  
  for (int i = 2; i < sampleCount - 2 && peakCount < 50; i++) {
    if (irBuffer[i] > threshold &&
        irBuffer[i] > irBuffer[i-1] && irBuffer[i] > irBuffer[i-2] &&
        irBuffer[i] > irBuffer[i+1] && irBuffer[i] > irBuffer[i+2]) {
      if (peakCount == 0 || (i - peaks[peakCount-1]) > 30) {  // Min 300ms between beats
        peaks[peakCount++] = i;
      }
    }
  }
  
  if (peakCount < 3) {
    *hr_bpm = baseline.hr;
    *hrv_rmssd = 40.0;
    return;
  }
  
  // Calculate HR from average peak-to-peak interval
  float totalInterval = 0;
  float intervals[50];
  int intervalCount = 0;
  
  for (int i = 1; i < peakCount; i++) {
    float interval = (peaks[i] - peaks[i-1]) * 10.0;  // ms (10ms per sample)
    intervals[intervalCount++] = interval;
    totalInterval += interval;
  }
  
  float avgInterval = totalInterval / intervalCount;
  *hr_bpm = 60000.0 / avgInterval;  // Convert ms to BPM
  
  // Calculate HRV (RMSSD)
  float sumSquaredDiff = 0;
  for (int i = 1; i < intervalCount; i++) {
    float diff = intervals[i] - intervals[i-1];
    sumSquaredDiff += diff * diff;
  }
  *hrv_rmssd = sqrt(sumSquaredDiff / max(intervalCount - 1, 1));
  
  // Sanity check
  if (*hr_bpm < 30 || *hr_bpm > 120) *hr_bpm = baseline.hr;
  if (*hrv_rmssd < 0 || *hrv_rmssd > 200) *hrv_rmssd = 40.0;
}

/**
 * Read DS18B20 temperature.
 */
float readTemperature() {
  tempSensor.requestTemperatures();
  float temp = tempSensor.getTempCByIndex(0);
  if (temp == DEVICE_DISCONNECTED_C || temp < 30.0 || temp > 45.0) {
    return baseline.temp;  // Fallback
  }
  return temp;
}

// ============================================================
// GSM / HTTP FUNCTIONS
// ============================================================

/**
 * Power on SIM800L and wait for registration.
 */
bool powerOnGSM() {
  gsmSerial.begin(9600, SERIAL_8N1, GSM_RX, GSM_TX);
  delay(3000);
  
  // Check if module responds
  gsmSerial.println("AT");
  delay(1000);
  if (!gsmSerial.find("OK")) {
    Serial.println("[GSM] Module not responding");
    return false;
  }
  
  // Set to text mode
  gsmSerial.println("AT+CMGF=1");
  delay(500);
  
  // Check registration
  gsmSerial.println("AT+CREG?");
  delay(2000);
  
  // Enable GPRS
  gsmSerial.println("AT+SAPBR=3,1,\"CONTYPE\",\"GPRS\"");
  delay(1000);
  gsmSerial.println("AT+SAPBR=3,1,\"APN\",\"internet\"");
  delay(1000);
  gsmSerial.println("AT+SAPBR=1,1");
  delay(3000);
  
  // Init HTTP
  gsmSerial.println("AT+HTTPINIT");
  delay(1000);
  
  Serial.println("[GSM] Powered on and connected");
  return true;
}

/**
 * Power off SIM800L to conserve electricity.
 */
void powerOffGSM() {
  gsmSerial.println("AT+HTTPTERM");
  delay(500);
  gsmSerial.println("AT+SAPBR=0,1");
  delay(1000);
  gsmSerial.println("AT+CPOWD=1");
  delay(2000);
  Serial.println("[GSM] Powered off");
}

/**
 * Send HTTP POST via SIM800L.
 */
bool sendHTTPPost(const char* url, const char* jsonPayload) {
  char cmd[256];
  
  // Set URL
  snprintf(cmd, sizeof(cmd), "AT+HTTPPARA=\"URL\",\"%s\"", url);
  gsmSerial.println(cmd);
  delay(1000);
  
  // Set content type
  gsmSerial.println("AT+HTTPPARA=\"CONTENT\",\"application/json\"");
  delay(500);
  
  // Set data size
  int len = strlen(jsonPayload);
  snprintf(cmd, sizeof(cmd), "AT+HTTPDATA=%d,10000", len);
  gsmSerial.println(cmd);
  delay(1000);
  
  // Send data
  gsmSerial.print(jsonPayload);
  delay(3000);
  
  // Execute POST
  gsmSerial.println("AT+HTTPACTION=1");
  delay(10000);  // Wait for response
  
  // Read response status
  gsmSerial.println("AT+HTTPREAD");
  delay(2000);
  
  // Check for 200/201 response (simplified)
  String response = "";
  while (gsmSerial.available()) {
    response += (char)gsmSerial.read();
  }
  
  Serial.printf("[GSM] Response: %s\n", response.c_str());
  return response.indexOf("200") >= 0 || response.indexOf("201") >= 0;
}

// ============================================================
// FREERTOS TASKS
// ============================================================

/**
 * GPS Task — Runs every 2 minutes.
 * Wakes NEO-6M, gets fix, checks zone boundary, logs infractions.
 */
void GPSTask(void* pvParameters) {
  Serial.println("[GPS] Task started");
  
  gpsSerial.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);
  
  while (true) {
    Serial.println("[GPS] Waking module...");
    
    // Wake GPS by sending dummy bytes
    gpsSerial.write(0xFF);
    delay(1000);
    
    // Read GPS data for up to 60 seconds to get a fix
    unsigned long startWait = millis();
    bool gotFix = false;
    
    while (millis() - startWait < 60000) {
      while (gpsSerial.available()) {
        if (gps.encode(gpsSerial.read())) {
          if (gps.location.isValid()) {
            currentPosition.lat = gps.location.lat();
            currentPosition.lng = gps.location.lng();
            currentPosition.valid = true;
            currentPosition.timestamp = millis();
            gotFix = true;
            break;
          }
        }
      }
      if (gotFix) break;
      delay(10);
    }
    
    if (gotFix) {
      Serial.printf("[GPS] Fix: %.6f, %.6f\n", currentPosition.lat, currentPosition.lng);
      
      // Check zone boundary
      if (activeZone.loaded) {
        bool inside = isInsideZone(currentPosition.lat, currentPosition.lng, activeZone);
        double dist = distanceToBoundary(currentPosition.lat, currentPosition.lng, activeZone);
        
        if (!inside) {
          // OUTSIDE zone — haptic + audio alert
          Serial.printf("[ZONE] OUTSIDE boundary! Dist: %.1fm\n", dist);
          triggerHaptic(47);  // Strong buzz pattern
          playWarningTone(2000, 500);
          delay(200);
          playWarningTone(2000, 500);
          
          // Log infraction to SD
          char logEntry[128];
          snprintf(logEntry, sizeof(logEntry), "INFRACTION,%s,%.6f,%.6f,%lu",
                   DEVICE_ID, currentPosition.lat, currentPosition.lng, millis());
          logToSD("/infractions.csv", logEntry);
          
        } else if (dist < ZONE_WARNING_METERS) {
          // NEAR boundary — audio warning only
          Serial.printf("[ZONE] Near boundary: %.1fm\n", dist);
          playWarningTone(1000, 300);
        }
      }
      
      // Log GPS to SD
      char gpsLog[128];
      snprintf(gpsLog, sizeof(gpsLog), "GPS,%.6f,%.6f,%lu",
               currentPosition.lat, currentPosition.lng, millis());
      logToSD("/gps_log.csv", gpsLog);
      
    } else {
      Serial.println("[GPS] No fix obtained");
    }
    
    // Put GPS to sleep (send PMTK standby command)
    gpsSerial.println("$PMTK161,0*28");
    
    vTaskDelay(pdMS_TO_TICKS(GPS_INTERVAL_MS));
  }
}

/**
 * Health Monitor Task — Runs every 5 minutes.
 * Reads all health sensors, runs alert state machine, queues GSM alert if needed.
 */
void HealthMonitorTask(void* pvParameters) {
  Serial.println("[HEALTH] Task started");
  
  // Initialize sensors
  initADXL345();
  initMAX30102();
  tempSensor.begin();
  
  while (true) {
    Serial.println("[HEALTH] Reading sensors...");
    
    // Read temperature
    float temp_c = readTemperature();
    Serial.printf("[HEALTH] Temperature: %.2f°C\n", temp_c);
    
    // Read activity (sample for 30 seconds)
    float activity = readActivityIndex(30000);
    Serial.printf("[HEALTH] Activity Index: %.1f\n", activity);
    
    // Read heart rate (takes ~15 seconds)
    float hr_bpm, hrv_rmssd;
    readHeartRate(&hr_bpm, &hrv_rmssd);
    Serial.printf("[HEALTH] HR: %.1f BPM, HRV: %.2f ms\n", hr_bpm, hrv_rmssd);
    
    // Read battery
    currentBatteryPct = readBatteryPercent();
    Serial.printf("[HEALTH] Battery: %.1f%%\n", currentBatteryPct);
    
    // --- Alert State Machine ---
    float tempDelta = temp_c - baseline.temp;
    float activityRatio = activity / max(baseline.activity, 1.0f);
    float hrDelta = hr_bpm - baseline.hr;
    
    int flags = 0;
    if (tempDelta > TEMP_ALERT_DELTA) flags++;
    if (activityRatio < ACTIVITY_ALERT_RATIO) flags++;
    if (hrDelta > HR_ALERT_DELTA) flags++;
    
    AlertState previousState = currentAlertState;
    
    if (flags >= 3) {
      currentAlertState = STATE_EMERGENCY;
    } else if (flags >= 2) {
      // temp > baseline+1.5 AND activity < baseline*0.5 → ALERT
      currentAlertState = STATE_ALERT;
    } else if (flags >= 1 || tempDelta > 0.8 || activityRatio < 0.7) {
      currentAlertState = STATE_WATCH;
    } else {
      currentAlertState = STATE_NORMAL;
    }
    
    const char* stateNames[] = {"NORMAL", "WATCH", "ALERT", "EMERGENCY"};
    Serial.printf("[HEALTH] State: %s (flags: %d, tempΔ: %.1f, actRatio: %.2f, hrΔ: %.1f)\n",
                  stateNames[currentAlertState], flags, tempDelta, activityRatio, hrDelta);
    
    // Log health data to SD
    char healthLog[256];
    snprintf(healthLog, sizeof(healthLog), 
             "HEALTH,%s,%.2f,%.1f,%.1f,%.2f,%.1f,%s,%lu",
             DEVICE_ID, temp_c, activity, hr_bpm, hrv_rmssd, 
             currentBatteryPct, stateNames[currentAlertState], millis());
    logToSD("/health_log.csv", healthLog);
    
    // On state change to ALERT or EMERGENCY, queue GSM alert
    if (currentAlertState >= STATE_ALERT && currentAlertState > previousState) {
      AlertMessage msg;
      strncpy(msg.device_id, DEVICE_ID, sizeof(msg.device_id));
      msg.temp_c = temp_c;
      msg.activity_index = activity;
      msg.hr_bpm = hr_bpm;
      msg.hrv_rmssd = hrv_rmssd;
      msg.lat = currentPosition.lat;
      msg.lng = currentPosition.lng;
      msg.battery_pct = currentBatteryPct;
      msg.state = currentAlertState;
      
      if (xQueueSend(gsmAlertQueue, &msg, pdMS_TO_TICKS(5000)) != pdTRUE) {
        Serial.println("[HEALTH] Failed to queue GSM alert!");
      } else {
        Serial.println("[HEALTH] Queued GSM alert for transmission");
      }
    }
    
    vTaskDelay(pdMS_TO_TICKS(HEALTH_INTERVAL_MS));
  }
}

/**
 * GSM Alert Task — Waits on queue, transmits alerts via HTTP POST.
 */
void GSMAlertTask(void* pvParameters) {
  Serial.println("[GSM] Alert task started");
  
  AlertMessage msg;
  
  while (true) {
    // Wait for an alert message on the queue
    if (xQueueReceive(gsmAlertQueue, &msg, portMAX_DELAY) == pdTRUE) {
      Serial.println("[GSM] Received alert, powering on...");
      
      if (powerOnGSM()) {
        // Build JSON payload
        StaticJsonDocument<512> doc;
        doc["device_id"] = msg.device_id;
        doc["temp_c"] = msg.temp_c;
        doc["activity_index"] = msg.activity_index;
        doc["hr_bpm"] = msg.hr_bpm;
        doc["hrv_rmssd"] = msg.hrv_rmssd;
        doc["lat"] = msg.lat;
        doc["lng"] = msg.lng;
        doc["battery_pct"] = msg.battery_pct;
        
        // Add ISO 8601 timestamp
        char timestamp[32];
        struct tm timeinfo;
        if (getLocalTime(&timeinfo)) {
          strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%SZ", &timeinfo);
        } else {
          snprintf(timestamp, sizeof(timestamp), "1970-01-01T00:00:00Z");
        }
        doc["timestamp"] = timestamp;
        
        char jsonBuffer[512];
        serializeJson(doc, jsonBuffer, sizeof(jsonBuffer));
        
        // Send to backend
        char url[256];
        snprintf(url, sizeof(url), "%s/telemetry", BACKEND_URL);
        
        bool success = sendHTTPPost(url, jsonBuffer);
        Serial.printf("[GSM] Telemetry POST %s\n", success ? "succeeded" : "failed");
        
        // If it's a real alert, also POST to /alert endpoint
        if (msg.state >= STATE_ALERT) {
          StaticJsonDocument<256> alertDoc;
          alertDoc["device_id"] = msg.device_id;
          alertDoc["alert_type"] = msg.state == STATE_EMERGENCY ? "EMERGENCY" : "ALERT";
          alertDoc["temp"] = msg.temp_c;
          alertDoc["activity_delta"] = msg.activity_index - baseline.activity;
          alertDoc["hr"] = msg.hr_bpm;
          alertDoc["timestamp"] = timestamp;
          
          char alertJson[256];
          serializeJson(alertDoc, alertJson, sizeof(alertJson));
          
          snprintf(url, sizeof(url), "%s/alert", BACKEND_URL);
          sendHTTPPost(url, alertJson);
        }
        
        powerOffGSM();
      } else {
        Serial.println("[GSM] Failed to power on, will retry next alert");
      }
    }
  }
}

/**
 * Nightly Sync Task — Runs at 11 PM daily.
 * Transmits 24h health log via LoRa, receives zone updates.
 */
void NightlySyncTask(void* pvParameters) {
  Serial.println("[NIGHTLY] Sync task started");
  
  while (true) {
    // Check if it's 11 PM
    struct tm timeinfo;
    if (getLocalTime(&timeinfo)) {
      if (timeinfo.tm_hour == NIGHTLY_SYNC_HOUR && timeinfo.tm_min == 0) {
        Serial.println("[NIGHTLY] Starting nightly sync...");
        
        // Initialize LoRa
        LoRa.setPins(LORA_SS, LORA_RST, LORA_DIO0);
        if (LoRa.begin(433E6)) {  // 433 MHz for India ISM band
          LoRa.setSpreadingFactor(10);
          LoRa.setSignalBandwidth(125E3);
          LoRa.setCodingRate4(5);
          
          Serial.println("[LORA] Initialized for nightly sync");
          
          // Read and transmit health log from SD
          File healthFile = SD.open("/health_log.csv", FILE_READ);
          if (healthFile) {
            int packetCount = 0;
            char line[256];
            int lineIdx = 0;
            
            while (healthFile.available()) {
              char c = healthFile.read();
              if (c == '\n' || lineIdx >= 254) {
                line[lineIdx] = '\0';
                
                // Send via LoRa
                LoRa.beginPacket();
                LoRa.print(DEVICE_ID);
                LoRa.print("|");
                LoRa.print(line);
                LoRa.endPacket();
                
                packetCount++;
                lineIdx = 0;
                delay(100);  // Wait between packets
              } else {
                line[lineIdx++] = c;
              }
            }
            healthFile.close();
            Serial.printf("[LORA] Transmitted %d packets\n", packetCount);
            
            // Clear log after successful transmission
            SD.remove("/health_log.csv");
          }
          
          // Wait for zone update response (30 second window)
          Serial.println("[LORA] Waiting for zone update...");
          unsigned long waitStart = millis();
          String zoneData = "";
          
          while (millis() - waitStart < 30000) {
            int packetSize = LoRa.parsePacket();
            if (packetSize) {
              while (LoRa.available()) {
                zoneData += (char)LoRa.read();
              }
              Serial.printf("[LORA] Received zone data: %d bytes\n", zoneData.length());
              break;
            }
            delay(100);
          }
          
          // Save zone data to SD
          if (zoneData.length() > 0) {
            SD.remove("/zone.json");
            File zoneFile = SD.open("/zone.json", FILE_WRITE);
            if (zoneFile) {
              zoneFile.print(zoneData);
              zoneFile.close();
              Serial.println("[LORA] Zone data saved to SD");
              
              // Reload zone
              loadZoneFromSD();
            }
          }
          
          LoRa.end();
          
        } else {
          Serial.println("[LORA] Init failed!");
        }
        
        // Also transmit/clear infractions log
        SD.remove("/infractions.csv");
        
        Serial.println("[NIGHTLY] Sync complete");
      }
    }
    
    // Check every minute
    vTaskDelay(pdMS_TO_TICKS(60000));
  }
}

/**
 * Baseline Update Task — Runs weekly at 2 AM Sunday.
 * Reads 7 days of health logs, recalculates rolling averages.
 */
void BaselineUpdateTask(void* pvParameters) {
  Serial.println("[BASELINE] Update task started");
  
  while (true) {
    struct tm timeinfo;
    if (getLocalTime(&timeinfo)) {
      if (timeinfo.tm_wday == BASELINE_UPDATE_DAY && 
          timeinfo.tm_hour == BASELINE_UPDATE_HOUR && 
          timeinfo.tm_min == 0) {
        Serial.println("[BASELINE] Recalculating baselines...");
        
        // Read health log from SD card
        File healthFile = SD.open("/health_log.csv", FILE_READ);
        if (healthFile) {
          float totalTemp = 0, totalActivity = 0, totalHR = 0;
          int count = 0;
          
          char line[256];
          int lineIdx = 0;
          
          while (healthFile.available()) {
            char c = healthFile.read();
            if (c == '\n' || lineIdx >= 254) {
              line[lineIdx] = '\0';
              
              // Parse CSV: HEALTH,device_id,temp,activity,hr,hrv,battery,state,timestamp
              float temp, act, hr;
              if (sscanf(line, "HEALTH,%*[^,],%f,%f,%f", &temp, &act, &hr) == 3) {
                // Only include NORMAL state readings for baseline
                if (strstr(line, "NORMAL") != NULL) {
                  totalTemp += temp;
                  totalActivity += act;
                  totalHR += hr;
                  count++;
                }
              }
              lineIdx = 0;
            } else {
              line[lineIdx++] = c;
            }
          }
          healthFile.close();
          
          if (count > 10) {  // Need minimum samples for reliable baseline
            baseline.temp = totalTemp / count;
            baseline.activity = totalActivity / count;
            baseline.hr = totalHR / count;
            
            // Persist to NVS
            preferences.begin("gaudrishti", false);
            preferences.putFloat("b_temp", baseline.temp);
            preferences.putFloat("b_activity", baseline.activity);
            preferences.putFloat("b_hr", baseline.hr);
            preferences.end();
            
            Serial.printf("[BASELINE] Updated — Temp: %.2f, Activity: %.1f, HR: %.1f (from %d samples)\n",
                          baseline.temp, baseline.activity, baseline.hr, count);
          } else {
            Serial.printf("[BASELINE] Not enough samples (%d), keeping current baseline\n", count);
          }
        }
      }
    }
    
    // Check every minute
    vTaskDelay(pdMS_TO_TICKS(60000));
  }
}

// ============================================================
// SETUP & MAIN
// ============================================================

void setup() {
  Serial.begin(115200);
  delay(1000);
  
  Serial.println("============================================");
  Serial.println("  GauDrishti Smart Cattle Collar v" FIRMWARE_VERSION);
  Serial.printf("  Device ID: %s\n", DEVICE_ID);
  Serial.printf("  Village:   %s\n", VILLAGE_ID);
  Serial.println("============================================");
  
  // Initialize I2C
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);  // 400 kHz fast mode
  Serial.println("[I2C] Initialized (SDA=21, SCL=22)");
  
  // Initialize SPI for SD card
  SPI.begin();
  if (SD.begin(SD_CS)) {
    Serial.println("[SD] Card initialized");
  } else {
    Serial.println("[SD] Card initialization failed!");
  }
  
  // Load baselines from NVS (Preferences)
  preferences.begin("gaudrishti", true);  // Read-only
  baseline.temp = preferences.getFloat("b_temp", DEFAULT_BASELINE_TEMP);
  baseline.activity = preferences.getFloat("b_activity", DEFAULT_BASELINE_ACTIVITY);
  baseline.hr = preferences.getFloat("b_hr", DEFAULT_BASELINE_HR);
  preferences.end();
  
  Serial.printf("[BASELINE] Loaded — Temp: %.2f°C, Activity: %.1f, HR: %.1f BPM\n",
                baseline.temp, baseline.activity, baseline.hr);
  
  // Load zone from SD card
  loadZoneFromSD();
  
  // Configure NTP for time sync (when WiFi/GSM is available)
  configTime(19800, 0, "pool.ntp.org");  // IST UTC+5:30
  
  // Initialize audio pin
  pinMode(AUDIO_PIN, OUTPUT);
  
  // Create FreeRTOS queue for GSM alerts
  gsmAlertQueue = xQueueCreate(5, sizeof(AlertMessage));
  if (gsmAlertQueue == NULL) {
    Serial.println("[ERROR] Failed to create GSM alert queue!");
  }
  
  // Create FreeRTOS tasks
  xTaskCreatePinnedToCore(GPSTask, "GPS", STACK_SIZE_GPS, NULL, 2, NULL, 0);
  xTaskCreatePinnedToCore(HealthMonitorTask, "Health", STACK_SIZE_HEALTH, NULL, 3, NULL, 1);
  xTaskCreatePinnedToCore(GSMAlertTask, "GSM", STACK_SIZE_GSM, NULL, 4, NULL, 0);
  xTaskCreatePinnedToCore(NightlySyncTask, "Nightly", STACK_SIZE_NIGHTLY, NULL, 1, NULL, 0);
  xTaskCreatePinnedToCore(BaselineUpdateTask, "Baseline", STACK_SIZE_BASELINE, NULL, 1, NULL, 0);
  
  Serial.println("[RTOS] All tasks created");
  Serial.println("============================================");
}

void loop() {
  // FreeRTOS tasks handle everything
  // Main loop can handle watchdog or deep sleep logic
  
  // Light sleep between task executions to save power
  delay(1000);
  
  // If battery critically low, enter deep sleep
  if (currentBatteryPct < 5.0) {
    Serial.println("[POWER] Battery critical! Entering deep sleep...");
    esp_sleep_enable_timer_wakeup(3600000000ULL);  // Wake after 1 hour
    esp_deep_sleep_start();
  }
}
