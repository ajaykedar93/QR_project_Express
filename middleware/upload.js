// middleware/upload.js
import multer from "multer";
import { v4 as uuid } from "uuid";
import path from "path";
import fs from "fs";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join("uploads", req.user?.user_id || "anonymous");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuid() + ext);
  },
});

export const upload = multer({ storage });
