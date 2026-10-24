// Renders SUNDAY's app icon (in the style of her orb) and writes
// electron/icon.png (256px) and electron/sunday.ico (16–256px).
// Run with:  electron electron/make-icon.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SIZES = [256, 64, 48, 32, 24, 16];

const draw = `(size) => {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const m = size / 2, s = size / 256;
  // dark disc
  g.fillStyle = "#06070d";
  g.beginPath(); g.arc(m, m, 124 * s, 0, Math.PI * 2); g.fill();
  // violet core glow
  const glow = g.createRadialGradient(m, m, 4 * s, m, m, 78 * s);
  glow.addColorStop(0, "rgba(255,226,170,1)");
  glow.addColorStop(0.25, "rgba(196,170,255,0.95)");
  glow.addColorStop(0.6, "rgba(140,110,255,0.45)");
  glow.addColorStop(1, "rgba(140,110,255,0)");
  g.fillStyle = glow;
  g.beginPath(); g.arc(m, m, 78 * s, 0, Math.PI * 2); g.fill();
  // amber ring
  g.strokeStyle = "#ffc56b";
  g.lineWidth = Math.max(1.5, 13 * s);
  g.beginPath(); g.arc(m, m, 100 * s, 0, Math.PI * 2); g.stroke();
  // tick marks (skip at tiny sizes)
  if (size >= 48) {
    g.strokeStyle = "rgba(255,197,107,0.75)";
    g.lineWidth = Math.max(1, 3 * s);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      g.beginPath();
      g.moveTo(m + Math.cos(a) * 112 * s, m + Math.sin(a) * 112 * s);
      g.lineTo(m + Math.cos(a) * 121 * s, m + Math.sin(a) * 121 * s);
      g.stroke();
    }
  }
  return c.toDataURL("image/png");
}`;

function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const pngs = [];
  const source = path.join(__dirname, "logo-source.png");
  if (fs.existsSync(source)) {
    // The designed logo (generated with Higgsfield), scaled to every icon size.
    const { nativeImage } = require("electron");
    const img = nativeImage.createFromPath(source);
    for (const size of SIZES) pngs.push({ size, data: img.resize({ width: size, height: size, quality: "best" }).toPNG() });
  } else {
    // Fallback: draw the simple ring icon.
    const win = new BrowserWindow({ show: false });
    await win.loadURL("data:text/html,<html><body></body></html>");
    for (const size of SIZES) {
      const url = await win.webContents.executeJavaScript(`(${draw})(${size})`);
      pngs.push({ size, data: Buffer.from(url.split(",")[1], "base64") });
    }
  }
  fs.writeFileSync(path.join(__dirname, "icon.png"), pngs[0].data);
  fs.writeFileSync(path.join(__dirname, "sunday.ico"), ico(pngs));
  console.log("wrote electron/icon.png and electron/sunday.ico");
  app.quit();
});
