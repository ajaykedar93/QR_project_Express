// routes/convert.routes.js
import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { execa } from "execa";
import sharp from "sharp";

const router = Router();


const UPLOADS = path.join(process.cwd(), "uploads");
const OUTPUTS  = path.join(process.cwd(), "outputs");
for (const p of [UPLOADS, OUTPUTS]) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}


const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});


const isPdf   = (m, n) => /pdf/i.test(m || "") || /\.pdf$/i.test(n || "");
const isDocx  = (m, n) =>
  /officedocument\.wordprocessingml\.document|msword/i.test(m || "") ||
  /\.(docx|doc)$/i.test(n || "");
const isImg   = (m, n) =>
  /^image\//i.test(m || "") || /\.(jpe?g|png)$/i.test(n || "");

function safeBase(name = "file") {
  return (name.replace(/[^\w.\- ]+/g, "_") || "file").replace(/\s+/g, "_");
}
async function safeUnlink(p) {
  try { await fsp.unlink(p); } catch {}
}
function asDownload(res, filePath, downloadName, mime = undefined) {
  if (mime) res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `attachment; filename="${downloadName}"`);
  return res.download(filePath, downloadName);
}

router.post("/convert/docx-to-pdf", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file required" });
  const inPath = req.file.path;
  const orig = req.file.originalname || "document.docx";

  if (!isDocx(req.file.mimetype, orig)) {
    await safeUnlink(inPath);
    return res.status(400).json({ error: "Only DOC/DOCX allowed" });
  }

  try {
 
    await execa("soffice", ["--headless", "--convert-to", "pdf", "--outdir", OUTPUTS, inPath]);

   
    const tmpPdf = path.join(OUTPUTS, `${path.parse(inPath).name}.pdf`);
    const outName = safeBase(orig).replace(/\.(docx?|DOCX?)$/, "") + "-converted.pdf";
    const outPath = path.join(OUTPUTS, outName);
    await fsp.rename(tmpPdf, outPath);

    return asDownload(res, outPath, outName, "application/pdf");
  } catch (e) {
    console.error("DOCX_TO_PDF_ERROR", e);
    return res.status(500).json({ error: "Conversion failed" });
  } finally {
    await safeUnlink(inPath);
  }
});


router.post("/convert/pdf-to-jpg", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file required" });
  const inPath = req.file.path;
  const orig = req.file.originalname || "document.pdf";

  if (!isPdf(req.file.mimetype, orig)) {
    await safeUnlink(inPath);
    return res.status(400).json({ error: "Only PDF allowed" });
  }

  try {
    const base = path.join(OUTPUTS, safeBase(path.parse(orig).name));
   
    await execa("pdftoppm", ["-jpeg", "-r", "150", inPath, base]);

    const prefix = path.basename(base);
    const all = (await fsp.readdir(OUTPUTS))
      .filter((f) => f.startsWith(prefix) && /\.jpg$/i.test(f))
      .sort((a, b) => {
        
        const na = parseInt((a.match(/-(\d+)\.jpg$/i) || [])[1] || "0", 10);
        const nb = parseInt((b.match(/-(\d+)\.jpg$/i) || [])[1] || "0", 10);
        return na - nb;
      });

    const files = all.map((f) => `/file/${f}`);
    return res.json({ files });
  } catch (e) {
    console.error("PDF_TO_JPG_ERROR", e);
    return res.status(500).json({ error: "Conversion failed" });
  } finally {
    await safeUnlink(inPath);
  }
});


router.post("/compress/pdf", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file required" });
  const inPath = req.file.path;
  const orig = req.file.originalname || "document.pdf";

  if (!isPdf(req.file.mimetype, orig)) {
    await safeUnlink(inPath);
    return res.status(400).json({ error: "Only PDF allowed" });
  }

  const preset = String(req.query.preset || "screen").toLowerCase();
  const allowed = new Set(["screen", "ebook", "printer", "prepress"]);
  const level = allowed.has(preset) ? preset : "screen";

  const outName = safeBase(path.parse(orig).name) + "-compressed.pdf";
  const outPath = path.join(OUTPUTS, outName);

  try {
    await execa("gs", [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      `-dPDFSETTINGS=/${level}`,
      "-dNOPAUSE",
      "-dQUIET",
      "-dBATCH",
      `-sOutputFile=${outPath}`,
      inPath,
    ]);
    return asDownload(res, outPath, outName, "application/pdf");
  } catch (e) {
    console.error("PDF_COMPRESS_ERROR", e);
    return res.status(500).json({ error: "Compression failed" });
  } finally {
    await safeUnlink(inPath);
  }
});

router.post("/compress/image", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file required" });
  const inPath = req.file.path;
  const orig = req.file.originalname || "image.jpg";

  if (!isImg(req.file.mimetype, orig)) {
    await safeUnlink(inPath);
    return res.status(400).json({ error: "Only JPG/PNG allowed" });
  }

  const q = Math.max(1, Math.min(100, parseInt(req.query.q || "75", 10) || 75));
  const outName = safeBase(path.parse(orig).name) + "-min.jpg";
  const outPath = path.join(OUTPUTS, outName);

  try {
    await sharp(inPath)
     
      .jpeg({ quality: q, mozjpeg: true })
      .toFile(outPath);

    return asDownload(res, outPath, outName, "image/jpeg");
  } catch (e) {
    console.error("IMG_COMPRESS_ERROR", e);
    return res.status(500).json({ error: "Image compression failed" });
  } finally {
    await safeUnlink(inPath);
  }
});

export default router;
