// routes/reduce.js
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { execFile } from "child_process";
import { pool } from "../db/db.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const TEMP_DIR = path.join(__dirname, "..", "uploads", "temp");
const OUT_DIR  = path.join(__dirname, "..", "uploads", "reduced");
for (const d of [TEMP_DIR, OUT_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

const upload = multer({ dest: TEMP_DIR });


let GS_BIN = process.env.GS_BIN || "gs"; 

if (process.platform === "win32" && !process.env.GS_BIN) {

  GS_BIN = "gswin64c"; 
}

async function hasGhostscript() {
  try {
    await execFileAsync(GS_BIN, ["-v"]); 
    return true;
  } catch {
    return false;
  }
}

let GS_AVAILABLE = false;
(async () => {
  GS_AVAILABLE = await hasGhostscript();
  if (!GS_AVAILABLE) {
    console.warn(`[reduce] Ghostscript not found. Set GS_BIN or install it. Current GS_BIN="${GS_BIN}"`);
  } else {
    console.log(`[reduce] Ghostscript detected at "${GS_BIN}"`);
  }
})();

async function compressPdf(input, output, preset = "/ebook") {
  const args = [
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    `-dPDFSETTINGS=${preset}`,   // /screen /ebook /printer /prepress
    "-dDetectDuplicateImages=true",
    "-dColorImageDownsampleType=/Average",
    "-dColorImageResolution=110",
    "-dGrayImageDownsampleType=/Average",
    "-dGrayImageResolution=110",
    "-dMonoImageDownsampleType=/Subsample",
    "-dMonoImageResolution=300",
    "-dCompressFonts=true",
    "-dNOPAUSE",
    "-dQUIET",
    "-dBATCH",
    `-sOutputFile=${output}`,
    input,
  ];
  await execFileAsync(GS_BIN, args); 
  if (!fs.existsSync(output)) throw new Error("Ghostscript did not produce output");
}


router.post("/upload", upload.single("file"), async (req, res) => {
  if (!GS_AVAILABLE) {

    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(501).json({
      error: "Ghostscript not available on the server. Install Ghostscript or set GS_BIN.",
      hint: process.platform === "win32"
        ? "On Windows, install Ghostscript and set GS_BIN to the full path of gswin64c.exe or add it to PATH."
        : "Install with apt-get/apk/brew or in your Docker image.",
    });
  }

  const client = await pool.connect();
  try {
    const { user_id } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ext !== ".pdf") {
      fs.unlinkSync(file.path);
      return res.status(400).json({ error: "Only PDF is supported in this endpoint" });
    }

    const inputPath = file.path;
    const outName = `${Date.now()}-${file.originalname.replace(/[^\w.\-() ]+/g, "_")}`;
    const outPath  = path.join(OUT_DIR, outName);

  
    await compressPdf(inputPath, outPath, "/ebook");
    const origSize = file.size;
    let newSize = fs.statSync(outPath).size;

    if (newSize >= origSize) {
     
      await compressPdf(inputPath, outPath, "/screen");
      newSize = fs.statSync(outPath).size;
    }

    const { rows } = await client.query(
      `INSERT INTO size_reductions
       (user_id, original_filename, original_mime, original_size_bytes,
        optimized_filename, optimized_mime, optimized_size_bytes,
        method, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        user_id || null,
        file.originalname,
        file.mimetype || "application/pdf",
        origSize,
        outName,
        "application/pdf",
        newSize,
        "ghostscript_pdf",
        "success",
      ]
    );

    fs.unlinkSync(inputPath);
    return res.json({
      ...rows[0],
      saving_bytes: origSize - newSize,
      saving_percent: origSize > 0 ? Math.round(((origSize - newSize) / origSize) * 100) : 0,
      note: newSize < origSize
        ? "Compressed"
        : "No significant reduction (PDF may already be optimized).",
    });
  } catch (err) {
    console.error("PDF reduce error:", err);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: "Failed to compress PDF with Ghostscript." });
  } finally {
    client.release();
  }
});


router.get("/:id/preview", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM size_reductions WHERE id=$1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const row = rows[0];
    const fpath = path.join(OUT_DIR, row.optimized_filename);
    if (!fs.existsSync(fpath)) return res.status(404).json({ error: "File missing" });
    res.setHeader("Content-Type", "application/pdf");
    fs.createReadStream(fpath).pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Preview failed" });
  }
});


router.get("/:id/download", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM size_reductions WHERE id=$1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const row = rows[0];
    const fpath = path.join(OUT_DIR, row.optimized_filename);
    if (!fs.existsSync(fpath)) return res.status(404).json({ error: "File missing" });
    res.download(fpath, row.optimized_filename);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Download failed" });
  }
});


router.delete("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("DELETE FROM size_reductions WHERE id=$1 RETURNING *", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const outFile = path.join(OUT_DIR, rows[0].optimized_filename);
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
