#!/usr/bin/env python3
"""Script step: hourly air quality for today (06-22) from Open-Meteo, no API key.

Inputs (env): PLAYBOOK_INPUT_LAT, PLAYBOOK_INPUT_LON. Last stdout line: {"outputs": {"air": "..."}}.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

lat = os.environ.get("PLAYBOOK_INPUT_LAT", "52.23")
lon = os.environ.get("PLAYBOOK_INPUT_LON", "21.01")
query = urllib.parse.urlencode({
    "latitude": lat, "longitude": lon, "timezone": "auto", "forecast_days": 1,
    "hourly": "pm2_5,pm10,european_aqi",
})
try:
    with urllib.request.urlopen("https://air-quality-api.open-meteo.com/v1/air-quality?" + query, timeout=30) as resp:
        hourly = json.load(resp)["hourly"]
except Exception as exc:
    print(f"Open-Meteo air quality failed: {exc}", file=sys.stderr)
    sys.exit(1)
rows = []
for i, ts in enumerate(hourly["time"]):
    hour = int(ts[11:13])
    if 6 <= hour <= 22:
        rows.append(f"{ts[11:16]} EAQI {hourly['european_aqi'][i]} PM2.5 {hourly['pm2_5'][i]} PM10 {hourly['pm10'][i]} µg/m³")
print(json.dumps({"summary": f"{len(rows)} hours of air quality", "outputs": {"air": "\n".join(rows)}}, ensure_ascii=False))
