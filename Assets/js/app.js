// Reads lines like "12.4,270" (wind speed mph, wind direction degrees)
// from an Arduino over USB using the Web Serial API (Chrome / Edge).

const connectBtn = document.getElementById("connect-btn");
const disconnectBtn = document.getElementById("disconnect-btn");
const downloadBtn = document.getElementById("download-btn");
const baudSelect = document.getElementById("baud");
const statusEl = document.getElementById("status");
const speedEl = document.getElementById("live-speed");
const dirEl = document.getElementById("live-dir");
const compassEl = document.getElementById("live-compass");
const needleEl = document.getElementById("needle");
const logEl = document.getElementById("log");

const MAX_ROWS_SHOWN = 25;
const readings = []; // everything received this session (for CSV download)

let port = null;
let reader = null;
let keepReading = false;

function setStatus(text, cls = "") {
    statusEl.textContent = text;
    statusEl.className = "status " + cls;
}

function toCompass(deg) {
    const names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                   "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return names[Math.round(deg / 22.5) % 16];
}

function handleLine(line) {
    line = line.trim();
    if (!line) return;

    const parts = line.split(",");
    if (parts.length < 2) return; // ignore startup / debug text

    const speed = parseFloat(parts[0]);
    const dir = parseFloat(parts[1]);
    if (Number.isNaN(speed) || Number.isNaN(dir)) return;

    const time = new Date();
    readings.push({ time, speed, dir });
    downloadBtn.disabled = false;

    speedEl.textContent = speed.toFixed(1);
    dirEl.textContent = Math.round(dir);
    compassEl.textContent = toCompass(dir);
    needleEl.style.transform = `rotate(${dir}deg)`;

    addRow(time, speed, dir);
}

function addRow(time, speed, dir) {
    if (logEl.querySelector("td[colspan]")) logEl.innerHTML = "";

    const tr = document.createElement("tr");
    [time.toLocaleTimeString(), speed.toFixed(1), Math.round(dir)].forEach((v) => {
        const td = document.createElement("td");
        td.textContent = v;
        tr.appendChild(td);
    });
    logEl.prepend(tr);

    while (logEl.children.length > MAX_ROWS_SHOWN) {
        logEl.removeChild(logEl.lastChild);
    }
}

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

function downloadCsv() {
    const rows = ["timestamp,wind_speed_mph,wind_direction_deg"];
    readings.forEach((r) => {
        rows.push(`${r.time.toISOString()},${r.speed},${r.dir}`);
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
