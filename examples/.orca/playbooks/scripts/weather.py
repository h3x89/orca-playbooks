#!/usr/bin/env python3
"""Script step: hourly weather for today (06-22) from Open-Meteo, no API key.

Inputs (env): PLAYBOOK_INPUT_LAT, PLAYBOOK_INPUT_LON. Last stdout line: {"outputs": {"weather": "..."}}.
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

lat = os.environ.get("PLAYBOOK_INPUT_LAT", "52.23")
lon = os.environ.get("PLAYBOOK_INPUT_LON", "21.01")
query = urllib.parse.urlencode({
    "latitude": lat, "longitude": lon, "timezone": "auto", "forecast_days": 1,
    "hourly": "temperature_2m,precipitation_probability,precipitation,wind_speed_10m",
})
try:
    with urllib.request.urlopen("https://api.open-meteo.com/v1/forecast?" + query, timeout=30) as resp:
        data = json.load(resp)
    hourly = data["hourly"]
except Exception as exc:  # the plugin shows the last stderr line as the failure reason
    print(f"Open-Meteo forecast failed: {exc}", file=sys.stderr)
    sys.exit(1)
rows = []
for i, ts in enumerate(hourly["time"]):
    hour = int(ts[11:13])
    if 6 <= hour <= 22:
        rows.append(f"{ts[11:16]} {hourly['temperature_2m'][i]}°C precipitation {hourly['precipitation_probability'][i]}% "
                    f"({hourly['precipitation'][i]} mm) wind {hourly['wind_speed_10m'][i]} km/h")
# timezone=auto: Open-Meteo answers in the time zone of the coordinates and names it.
now = (datetime.now(timezone.utc) + timedelta(seconds=data.get("utc_offset_seconds", 0))).strftime("%H:%M")
rows.insert(0, f"Local time there: {now} ({data.get('timezone', 'UTC')}).")
print(json.dumps({"summary": f"{len(rows) - 1} hours of forecast", "outputs": {"weather": "\n".join(rows)}}, ensure_ascii=False))
