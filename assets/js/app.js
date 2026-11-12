// Reads lines from an Arduino over USB using the Web Serial API (Chrome / Edge).
//
// Expected line format (comma separated, newline terminated):
//   windSpeed_mph, windDir_deg, temp_C, pressure_hPa, humidity_pct
// Example:  12.4,270,21.5,985.2,48
// Only the first two values are required. Humidity is only needed for dew point.

// ----- Settings you should change -----
// Elevation of your station above sea level, in meters. Used for the altimeter setting.
const STATION_ELEVATION_M = 256;
// --------------------------------------

const $ = (id) => document.getElementById(id);

const connectBtn = $("connect-btn");
const disconnectBtn = $("disconnect-btn");
const downloadBtn = $("download-btn");
const baudSelect = $("baud");
const statusEl = $("status");
const windLogEl = $("wind-log");
const envLogEl = $("env-log");

const MAX_ROWS_SHOWN = 25;
const readings = []; // everything received this session (for CSV download)

let port = null;
let reader = null;
let keepReading = false;

function setStatus(text, cls = "") {
    statusEl.textContent = text;
    statusEl.className = "status " + cls;
}

// ---------- Conversions ----------
const cToF = (c) => c * 9 / 5 + 32;
const hpaToInHg = (h) => h * 0.02953;

function toCompass(deg) {
    const names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                   "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return names[Math.round(deg / 22.5) % 16];
}

// Magnus formula. Needs temperature (C) and relative humidity (%).
function dewPointC(tempC, rh) {
    if (tempC == null || rh == null || rh <= 0) return null;
    const a = 17.62, b = 243.12;
    const gamma = Math.log(rh / 100) + (a * tempC) / (b + tempC);
    return (b * gamma) / (a - gamma);
}

// Altimeter setting (hPa) from station pressure (hPa) and station elevation (m).
function altimeterHpa(stationHpa, elevM) {
    if (stationHpa == null) return null;
    const k = 0.1903;
    return Math.pow(Math.pow(stationHpa - 0.3, k) + 8.4217e-5 * elevM, 1 / k) + 0.3;
}

// ---------- Display helpers ----------
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? "\u2014" : v.toFixed(d));

function setText(id, text) {
    $(id).textContent = text;
}

function showWind(r) {
    setText("live-speed", fmt(r.speed));
    setText("live-dir", Math.round(r.dir));
    setText("live-compass", toCompass(r.dir));
    $("needle").style.transform = `rotate(${r.dir}deg)`;
}

function showEnv(r) {
    setText("live-temp", fmt(r.temp));
    setText("live-temp-f", r.temp == null ? "" : `${fmt(cToF(r.temp))} \u00b0F`);

    setText("live-humidity", fmt(r.humidity));

    setText("live-pressure", fmt(r.pressure));
    setText("live-pressure-inhg", r.pressure == null ? "" : `${fmt(hpaToInHg(r.pressure), 2)} inHg`);

    setText("live-dewpoint", fmt(r.dew));
    setText("live-dewpoint-f", r.dew == null
        ? (r.humidity == null ? "Needs humidity data" : "")
        : `${fmt(cToF(r.dew))} \u00b0F`);

    setText("live-altimeter", fmt(r.altInHg, 2));
    setText("live-altimeter-hpa", r.altHpa == null ? "" : `${fmt(r.altHpa)} hPa`);
}

function addRow(tbody, cells) {
    if (tbody.querySelector("td[colspan]")) tbody.innerHTML = "";
    const tr = document.createElement("tr");
    cells.forEach((v) => {
        const td = document.createElement("td");
        td.textContent = v;
        tr.appendChild(td);
    });
    tbody.prepend(tr);
    while (tbody.children.length > MAX_ROWS_SHOWN) {
        tbody.removeChild(tbody.lastChild);
    }
}

// ---------- Parsing ----------
function num(s) {
    if (s === undefined || s.trim() === "") return null;
    const v = parseFloat(s);
    return Number.isNaN(v) ? null : v;
}

function handleLine(line) {
    line = line.trim();
    if (!line) return;

    const p = line.split(",");
    if (p.length < 2) return; // ignore startup / debug text

    const speed = num(p[0]);
    const dir = num(p[1]);
    if (speed == null || dir == null) return;

    const temp = num(p[2]);
    const pressure = num(p[3]);
    const humidity = num(p[4]);

    const dew = dewPointC(temp, humidity);
    const altHpa = altimeterHpa(pressure, STATION_ELEVATION_M);
    const altInHg = altHpa == null ? null : hpaToInHg(altHpa);

    const r = { time: new Date(), speed, dir, temp, pressure, humidity, dew, altHpa, altInHg };
    readings.push(r);
    downloadBtn.disabled = false;

    showWind(r);
    showEnv(r);

    addRow(windLogEl, [r.time.toLocaleTimeString(), fmt(speed), Math.round(dir)]);
    addRow(envLogEl, [r.time.toLocaleTimeString(), fmt(temp), fmt(humidity), fmt(pressure), fmt(dew), fmt(altInHg, 2)]);
}

// ---------- Serial connection ----------
async function connect() {
    if (!("serial" in navigator)) {
        setStatus("Web Serial is not supported. Use Chrome or Edge on desktop.", "error");
        return;
    }

    try {
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: parseInt(baudSelect.value, 10) });
    } catch (err) {
        setStatus("Could not open port: " + err.message, "error");
        return;
    }

    setStatus("Connected", "connected");
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    baudSelect.disabled = true;

    keepReading = true;
    readLoop();
}

async function readLoop() {
    const decoder = new TextDecoderStream();
    const closed = port.readable.pipeTo(decoder.writable).catch(() => {});
    reader = decoder.readable.getReader();
    let buffer = "";

    try {
        while (keepReading) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop(); // keep any partial line
            lines.forEach(handleLine);
        }
    } catch (err) {
        setStatus("Read error: " + err.message, "error");
    } finally {
        reader.releaseLock();
        await closed;
    }
}

async function disconnect() {
    keepReading = false;
    try {
        if (reader) await reader.cancel();
        if (port) await port.close();
    } catch (err) {
        /* port may already be closed */
    }
    port = null;
    reader = null;
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    baudSelect.disabled = false;
    setStatus("Not connected");
}

// ---------- CSV download ----------
function downloadCsv() {
    const blank = (v) => (v == null ? "" : v);
    const rows = ["timestamp,wind_speed_mph,wind_direction_deg,temperature_c,pressure_hpa,humidity_pct,dew_point_c,altimeter_inhg"];
    readings.forEach((r) => {
        rows.push([
            r.time.toISOString(), r.speed, r.dir,
            blank(r.temp), blank(r.pressure), blank(r.humidity),
            blank(r.dew == null ? null : r.dew.toFixed(2)),
            blank(r.altInHg == null ? null : r.altInHg.toFixed(3)),
        ].join(","));
    });
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "weather-readings.csv";
    a.click();
    URL.revokeObjectURL(a.href);
}

connectBtn.addEventListener("click", connect);
disconnectBtn.addEventListener("click", disconnect);
downloadBtn.addEventListener("click", downloadCsv);

if (!("serial" in navigator)) {
    setStatus("Web Serial needs Chrome or Edge on desktop", "error");
    connectBtn.disabled = true;
}