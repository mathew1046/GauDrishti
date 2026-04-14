"""
GauDrishti — Hardware Simulator
Simulates 8 cattle collars sending realistic data to the backend.
Usage: python simulator.py --backend-url http://localhost:8000
"""

import asyncio
import argparse
import random
import time
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional

import httpx
from rich.console import Console
from rich.table import Table
from rich.live import Live
from rich.panel import Panel
from rich.text import Text

console = Console()

# ============================================
# Cattle Definitions
# ============================================

BREEDS = {
    "GIR": {"base_temp": 38.2, "base_activity": 520, "base_hr": 68},
    "SAHIWAL": {"base_temp": 38.4, "base_activity": 480, "base_hr": 64},
    "THARPARKAR": {"base_temp": 38.5, "base_activity": 500, "base_hr": 65},
    "MURRAH_BUFFALO": {"base_temp": 37.8, "base_activity": 460, "base_hr": 60},
    "CROSSBRED": {"base_temp": 38.6, "base_activity": 510, "base_hr": 70},
}

# Kothamangalam area (Kerala) base coordinates
BASE_LAT = 10.05
BASE_LNG = 76.90


@dataclass
class SimulatedCattle:
    device_id: str
    name: str
    breed: str
    base_temp: float
    base_activity: float
    base_hr: float
    lat: float
    lng: float
    current_state: str = "NORMAL"
    state_timer: float = 0
    state_duration: float = 0
    temp_offset: float = 0.0
    activity_multiplier: float = 1.0
    hr_offset: float = 0.0
    battery_pct: float = field(default_factory=lambda: random.uniform(65, 100))
    readings_sent: int = 0
    last_response: str = ""

    @property
    def current_temp(self) -> float:
        noise = random.gauss(0, 0.15)
        return self.base_temp + self.temp_offset + noise

    @property
    def current_activity(self) -> float:
        noise = random.gauss(0, 20)
        return max(0, self.base_activity * self.activity_multiplier + noise)

    @property
    def current_hr(self) -> float:
        noise = random.gauss(0, 3)
        return max(30, self.base_hr + self.hr_offset + noise)

    @property
    def current_hrv(self) -> float:
        # HRV inversely correlated with stress
        base_hrv = 45.0
        if self.current_state == "EMERGENCY":
            return base_hrv * 0.4 + random.gauss(0, 2)
        elif self.current_state == "ALERT":
            return base_hrv * 0.6 + random.gauss(0, 3)
        elif self.current_state == "WATCH":
            return base_hrv * 0.8 + random.gauss(0, 3)
        return base_hrv + random.gauss(0, 5)


CATTLE = [
    SimulatedCattle("GD-KL-001", "Lakshmi", "GIR", **BREEDS["GIR"], lat=BASE_LAT + 0.003, lng=BASE_LNG + 0.021),
    SimulatedCattle("GD-KL-002", "Gauri", "SAHIWAL", **BREEDS["SAHIWAL"], lat=BASE_LAT + 0.0045, lng=BASE_LNG + 0.0225),
    SimulatedCattle("GD-KL-003", "Nandini", "CROSSBRED", **BREEDS["CROSSBRED"], lat=BASE_LAT + 0.0045, lng=BASE_LNG + 0.0225),
    SimulatedCattle("GD-KL-004", "Kamala", "GIR", **BREEDS["GIR"], lat=BASE_LAT + 0.011, lng=BASE_LNG + 0.018),
    SimulatedCattle("GD-KL-005", "Bhavani", "MURRAH_BUFFALO", **BREEDS["MURRAH_BUFFALO"], lat=BASE_LAT + 0.011, lng=BASE_LNG + 0.018),
    SimulatedCattle("GD-KA-001", "Ganga", "THARPARKAR", **BREEDS["THARPARKAR"], lat=12.5226, lng=76.8951),
    SimulatedCattle("GD-KA-002", "Kaveri", "SAHIWAL", **BREEDS["SAHIWAL"], lat=12.524, lng=76.897),
    SimulatedCattle("GD-KA-003", "Tulsi", "MURRAH_BUFFALO", **BREEDS["MURRAH_BUFFALO"], lat=12.524, lng=76.897),
]


# ============================================
# Simulation Logic
# ============================================

class Simulator:
    def __init__(self, backend_url: str):
        self.backend_url = backend_url.rstrip("/")
        self.cattle = CATTLE
        self.tick = 0
        self.start_time = time.time()
        self.events_log: list[str] = []

    def drift_gps(self, cow: SimulatedCattle):
        """Simulate GPS drift for movement."""
        cow.lat += random.gauss(0, 0.0001)
        cow.lng += random.gauss(0, 0.0001)

    def update_states(self):
        """Update health states based on simulation schedule."""
        self.tick += 1
        elapsed = time.time() - self.start_time

        for cow in self.cattle:
            # Drift GPS for all animals
            self.drift_gps(cow)

            # Battery drain
            cow.battery_pct = max(5, cow.battery_pct - random.uniform(0.01, 0.05))

            # If animal is in elevated state, check if it should recover
            if cow.current_state != "NORMAL" and cow.state_timer > 0:
                cow.state_timer -= 30  # 30 seconds per tick
                if cow.state_timer <= 0:
                    self._set_state(cow, "NORMAL")
                    self.events_log.append(f"✅ {cow.name} recovered → NORMAL")

        # Every 5 minutes (10 ticks at 30s): random WATCH state
        if self.tick % 10 == 0:
            candidates = [c for c in self.cattle if c.current_state == "NORMAL"]
            if candidates:
                cow = random.choice(candidates)
                self._set_state(cow, "WATCH")
                cow.state_timer = 300  # 5 min duration
                self.events_log.append(f"⚠️ {cow.name} → WATCH (temp +0.8°C, activity -30%)")

        # Every 15 minutes (30 ticks): random ALERT state
        if self.tick % 30 == 0:
            candidates = [c for c in self.cattle if c.current_state in ("NORMAL", "WATCH")]
            if candidates:
                cow = random.choice(candidates)
                self._set_state(cow, "ALERT")
                cow.state_timer = 600  # 10 min duration
                self.events_log.append(f"🔴 {cow.name} → ALERT (temp +1.6°C, activity -55%, HR +15)")

    def _set_state(self, cow: SimulatedCattle, state: str):
        cow.current_state = state
        if state == "NORMAL":
            cow.temp_offset = 0.0
            cow.activity_multiplier = 1.0
            cow.hr_offset = 0.0
        elif state == "WATCH":
            cow.temp_offset = 0.8
            cow.activity_multiplier = 0.7
            cow.hr_offset = 5.0
        elif state == "ALERT":
            cow.temp_offset = 1.6
            cow.activity_multiplier = 0.45
            cow.hr_offset = 15.0
        elif state == "EMERGENCY":
            cow.temp_offset = 2.2
            cow.activity_multiplier = 0.3
            cow.hr_offset = 25.0

    async def send_telemetry(self, client: httpx.AsyncClient, cow: SimulatedCattle):
        """Send telemetry data for a single cow."""
        payload = {
            "device_id": cow.device_id,
            "temp_c": round(cow.current_temp, 2),
            "activity_index": round(cow.current_activity, 1),
            "hr_bpm": round(cow.current_hr, 1),
            "hrv_rmssd": round(cow.current_hrv, 2),
            "lat": round(cow.lat, 6),
            "lng": round(cow.lng, 6),
            "battery_pct": round(cow.battery_pct, 1),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        try:
            resp = await client.post(f"{self.backend_url}/telemetry", json=payload, timeout=10.0)
            cow.readings_sent += 1
            if resp.status_code == 201:
                data = resp.json()
                cow.last_response = f"{data.get('current_state', '?')}"
                if data.get("alert_sent"):
                    cow.last_response += " 📱"
            else:
                cow.last_response = f"HTTP {resp.status_code}"
        except httpx.ConnectError:
            cow.last_response = "❌ Connection refused"
        except Exception as e:
            cow.last_response = f"❌ {str(e)[:30]}"

    def build_table(self) -> Table:
        """Build rich table showing current status of all cattle."""
        table = Table(
            title="🐄 GauDrishti — Cattle Simulator",
            title_style="bold green",
            border_style="dim green",
            show_lines=True,
            padding=(0, 1),
        )

        table.add_column("Device", style="cyan", no_wrap=True, width=12)
        table.add_column("Name", style="bold white", width=10)
        table.add_column("Breed", style="dim", width=16)
        table.add_column("Temp °C", justify="right", width=8)
        table.add_column("Activity", justify="right", width=9)
        table.add_column("HR BPM", justify="right", width=8)
        table.add_column("HRV", justify="right", width=7)
        table.add_column("Battery", justify="right", width=8)
        table.add_column("State", justify="center", width=12)
        table.add_column("GPS", style="dim", width=22)
        table.add_column("Sent", justify="right", width=5)
        table.add_column("Response", width=20)

        state_colors = {
            "NORMAL": "green",
            "WATCH": "yellow",
            "ALERT": "rgb(255,165,0)",
            "EMERGENCY": "red",
        }

        for cow in self.cattle:
            state_color = state_colors.get(cow.current_state, "white")
            state_text = Text(cow.current_state, style=f"bold {state_color}")

            temp_style = "red" if cow.temp_offset > 1.0 else ("yellow" if cow.temp_offset > 0.5 else "green")
            activity_style = "red" if cow.activity_multiplier < 0.5 else ("yellow" if cow.activity_multiplier < 0.8 else "green")
            hr_style = "red" if cow.hr_offset > 10 else ("yellow" if cow.hr_offset > 3 else "green")

            batt_style = "red" if cow.battery_pct < 20 else ("yellow" if cow.battery_pct < 40 else "green")

            table.add_row(
                cow.device_id,
                cow.name,
                cow.breed.replace("_", " ").title(),
                Text(f"{cow.current_temp:.1f}", style=temp_style),
                Text(f"{cow.current_activity:.0f}", style=activity_style),
                Text(f"{cow.current_hr:.0f}", style=hr_style),
                f"{cow.current_hrv:.1f}",
                Text(f"{cow.battery_pct:.0f}%", style=batt_style),
                state_text,
                f"{cow.lat:.4f}, {cow.lng:.4f}",
                str(cow.readings_sent),
                cow.last_response,
            )

        return table

    def build_display(self) -> Panel:
        """Build the full display with table and event log."""
        table = self.build_table()
        elapsed = int(time.time() - self.start_time)
        minutes, seconds = divmod(elapsed, 60)

        # Show last 5 events
        events_text = "\n".join(self.events_log[-5:]) if self.events_log else "No events yet..."

        footer = Text(
            f"\n⏱ Runtime: {minutes:02d}:{seconds:02d}  |  Tick: {self.tick}  |  "
            f"Backend: {self.backend_url}  |  Interval: 30s  |  Ctrl+C to stop\n\n"
            f"📋 Recent Events:\n{events_text}",
            style="dim",
        )

        from rich.console import Group
        return Panel(
            Group(table, footer),
            title="[bold green]GauDrishti Simulator[/]",
            border_style="green",
            padding=(1, 2),
        )

    async def run(self):
        """Main simulation loop."""
        console.print(
            Panel(
                "[bold green]🐄 GauDrishti Hardware Simulator[/]\n\n"
                f"Backend URL: {self.backend_url}\n"
                f"Cattle count: {len(self.cattle)}\n"
                f"Telemetry interval: 30 seconds\n"
                f"WATCH events: every 5 minutes\n"
                f"ALERT events: every 15 minutes\n",
                title="Starting...",
                border_style="green",
            )
        )

        # Check backend health
        async with httpx.AsyncClient() as client:
            try:
                resp = await client.get(f"{self.backend_url}/health", timeout=5.0)
                if resp.status_code == 200:
                    console.print("[green]✅ Backend is healthy[/]")
                else:
                    console.print(f"[yellow]⚠️ Backend returned {resp.status_code}[/]")
            except Exception:
                console.print("[yellow]⚠️ Cannot reach backend — will retry on each tick[/]")

        console.print()

        with Live(self.build_display(), refresh_per_second=1, console=console) as live:
            async with httpx.AsyncClient() as client:
                while True:
                    # Update simulation states
                    self.update_states()

                    # Send telemetry for all cattle concurrently
                    tasks = [self.send_telemetry(client, cow) for cow in self.cattle]
                    await asyncio.gather(*tasks)

                    # Update display
                    live.update(self.build_display())

                    # Wait 30 seconds
                    await asyncio.sleep(30)


# ============================================
# Entry Point
# ============================================

def main():
    parser = argparse.ArgumentParser(
        description="GauDrishti Hardware Simulator — Simulates 8 cattle collars",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python simulator.py
  python simulator.py --backend-url http://localhost:8000
  python simulator.py --backend-url https://api.gaudrishti.in
        """,
    )
    parser.add_argument(
        "--backend-url",
        default="http://localhost:8000",
        help="Backend API URL (default: http://localhost:8000)",
    )
    args = parser.parse_args()

    sim = Simulator(args.backend_url)

    try:
        asyncio.run(sim.run())
    except KeyboardInterrupt:
        console.print("\n[yellow]Simulator stopped.[/]")


if __name__ == "__main__":
    main()
