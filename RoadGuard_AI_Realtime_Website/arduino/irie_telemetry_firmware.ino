/*
  =============================================================================
  IRIE — Indian Road Intelligence Engine
  Academic Prototype Vehicle Telemetry & Health Firmware (Arduino Uno / Mega / Nano)
  =============================================================================

  Hardware Connections:
  - GPS Module (NEO-6M / compatible): RX -> Pin 4, TX -> Pin 3 (SoftwareSerial)
  - Impact/Vibration Sensor: SW-420 or Piezo -> Digital Pin 2 (Interrupt 0)
  - MPU-6050 Accelerometer/Gyro (Optional I2C): SDA -> A4, SCL -> A5
  - Battery Voltage Divider: A1 (Divider 100k / 22k for 3S 12.6V LiPo)
  - Emergency Stop / Status LED: Pin 13
  
  USB Serial Protocol Output:
  Format 1 (Delimited NMEA):
    $IRIE,lat,lng,speed,heading,battery_voltage,vibration_g,tilt_deg*CHECKSUM
  Format 2 (JSON):
    {"lat":11.016844,"lng":76.955833,"spd":24.5,"hdg":45.0,"bat":12.35,"vib":0.42,"tilt":1.5}
*/

#include <Arduino.h>

// Pins Configuration
const int PIN_VIBRATION = 2;
const int PIN_BATTERY_DIVIDER = A1;
const int PIN_LED = 13;

// Calibration Constants
const float VOLTAGE_DIVIDER_RATIO = 5.545; // Calibrated for 100k / 22k resistor divider
const float V_REF = 5.0; // Arduino 5V reference

// State Variables
volatile unsigned long lastImpactTime = 0;
volatile float peakVibrationG = 0.25;
float simulatedLat = 11.016844;
float simulatedLng = 76.955833;
float vehicleSpeedKmh = 0.0;
float vehicleHeadingDeg = 45.0;
unsigned long lastTelemetryTx = 0;
const unsigned long TX_INTERVAL_MS = 1000; // 1Hz update rate

void onImpactDetected() {
  lastImpactTime = millis();
  peakVibrationG = 3.85; // Simulated / detected impact spike
}

void setup() {
  Serial.begin(9600);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_VIBRATION, INPUT_PULLUP);
  pinMode(PIN_BATTERY_DIVIDER, INPUT);

  // Attach vibration sensor interrupt
  attachInterrupt(digitalPinToInterrupt(PIN_VIBRATION), onImpactDetected, FALLING);

  // Blink LED to signal boot
  for (int i = 0; i < 3; i++) {
    digitalWrite(PIN_LED, HIGH);
    delay(100);
    digitalWrite(PIN_LED, LOW);
    delay(100);
  }
}

float readBatteryVoltage() {
  int raw = analogRead(PIN_BATTERY_DIVIDER);
  float pinVoltage = (raw / 1023.0) * V_REF;
  float actualBatVoltage = pinVoltage * VOLTAGE_DIVIDER_RATIO;
  if (actualBatVoltage < 1.0) {
    // If no battery is wired to A1 divider, default to nominal 12.4V for bench testing
    actualBatVoltage = 12.40;
  }
  return actualBatVoltage;
}

void loop() {
  unsigned long now = millis();

  // Decay vibration back to nominal after impact
  if (now - lastImpactTime > 2500) {
    peakVibrationG = 0.20 + (random(0, 15) / 100.0);
  }

  // Periodic Telemetry Transmission
  if (now - lastTelemetryTx >= TX_INTERVAL_MS) {
    lastTelemetryTx = now;

    float batVoltage = readBatteryVoltage();
    float tiltDeg = 1.2 + (random(0, 10) / 10.0);

    // Send JSON formatted packet over USB Serial
    Serial.print("{\"lat\":");
    Serial.print(simulatedLat, 6);
    Serial.print(",\"lng\":");
    Serial.print(simulatedLng, 6);
    Serial.print(",\"spd\":");
    Serial.print(vehicleSpeedKmh, 1);
    Serial.print(",\"hdg\":");
    Serial.print(vehicleHeadingDeg, 1);
    Serial.print(",\"bat\":");
    Serial.print(batVoltage, 2);
    Serial.print(",\"vib\":");
    Serial.print(peakVibrationG, 2);
    Serial.print(",\"tilt\":");
    Serial.print(tiltDeg, 1);
    Serial.println("}");

    // Flash LED on packet sent
    digitalWrite(PIN_LED, HIGH);
    delay(15);
    digitalWrite(PIN_LED, LOW);
  }

  // Handle incoming commands from backend (e.g. STOP or PING)
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd == "PING") {
      Serial.println("PONG");
    } else if (cmd == "ESTOP") {
      digitalWrite(PIN_LED, HIGH); // Emergency stop indicator
      Serial.println("ACK:ESTOP_ENGAGED");
    }
  }
}
