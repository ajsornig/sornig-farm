#!/usr/bin/env python3
import math, sys
from datetime import datetime

# Lapeer, MI
LAT = 43.05
LNG = -83.32

def sun_times(date):
    """Calculate sunrise/sunset in local decimal hours using NOAA algorithm."""
    import time
    is_dst = time.daylight and time.localtime().tm_isdst > 0
    tz_offset = -(time.timezone if not is_dst else time.altzone) / 3600.0

    day_of_year = date.timetuple().tm_yday

    # Fractional year (radians)
    gamma = (2 * math.pi / 365) * (day_of_year - 1)

    # Equation of time (minutes)
    eqtime = 229.18 * (0.000075 + 0.001868 * math.cos(gamma)
             - 0.032077 * math.sin(gamma)
             - 0.014615 * math.cos(2 * gamma)
             - 0.040849 * math.sin(2 * gamma))

    # Solar declination (radians)
    decl = (0.006918 - 0.399912 * math.cos(gamma)
            + 0.070257 * math.sin(gamma)
            - 0.006758 * math.cos(2 * gamma)
            + 0.000907 * math.sin(2 * gamma)
            - 0.002697 * math.cos(3 * gamma)
            + 0.00148 * math.sin(3 * gamma))

    lat_rad = math.radians(LAT)

    # Hour angle (degrees)
    cos_ha = (math.cos(math.radians(90.833)) / (math.cos(lat_rad) * math.cos(decl))
              - math.tan(lat_rad) * math.tan(decl))
    cos_ha = max(-1, min(1, cos_ha))
    ha = math.degrees(math.acos(cos_ha))

    # Sunrise and sunset in minutes from midnight UTC
    sunrise_utc = 720 - 4 * (LNG + ha) - eqtime
    sunset_utc = 720 - 4 * (LNG - ha) - eqtime

    # Convert to local hours
    sunrise_local = (sunrise_utc / 60.0) + tz_offset
    sunset_local = (sunset_utc / 60.0) + tz_offset

    return sunrise_local, sunset_local

if __name__ == '__main__':
    today = datetime.now()
    sunrise, sunset = sun_times(today)

    if len(sys.argv) > 1:
        mode = sys.argv[1]
        if mode == 'sunrise':
            h = int(sunrise)
            m = int((sunrise - h) * 60)
            print(f"{h}:{m:02d}")
        elif mode == 'sunset':
            h = int(sunset)
            m = int((sunset - h) * 60)
            print(f"{h}:{m:02d}")
        elif mode == 'check-run':
            hour = today.hour + today.minute / 60.0
            sys.exit(0 if (sunrise - 1) <= hour <= (sunset + 1) else 1)
        elif mode == 'check-coop':
            hour = today.hour + today.minute / 60.0
            if hour >= (sunset - 1) or hour <= (sunrise + 1):
                sys.exit(0)
            else:
                sys.exit(1)
    else:
        sr_h = int(sunrise)
        sr_m = int((sunrise - sr_h) * 60)
        ss_h = int(sunset)
        ss_m = int((sunset - ss_h) * 60)
        print(f"sunrise={sr_h}:{sr_m:02d} sunset={ss_h}:{ss_m:02d}")
