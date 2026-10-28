import multer from "multer";
import path from "path";

// Use memory storage for serverless compatibility and to enable Data URI storage
const storage = multer.memoryStorage();

const fileFilter = (req: any, file: any, cb: multer.FileFilterCallback) => {
  const allowedTypes = /jpeg|jpg|png|pdf|mp4|webm|mov|avi|mkv/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype) || file.mimetype.startsWith('video/');

  if (extname || mimetype) {
    return cb(null, true);
  } else {
    cb(new Error("Only images (jpeg, jpg, png), PDFs, and video files are allowed"));
  }
};

export const upload = multer({ 
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit for videos
  fileFilter: fileFilter
});

// VOICE COMMENTS / audio attachments — the shared filter above only accepts
// images/PDF/video, which made audio uploads impossible platform-wide.
// Dedicated audio-accepting multer instance (voice notes in comments, etc.).
const audioFileFilter = (req: any, file: any, cb: multer.FileFilterCallback) => {
  const allowedAudio = /m4a|aac|mp3|mpeg|mpga|ogg|oga|wav|x-wav|webm|opus|amr|3gp/;
  const extname = allowedAudio.test(path.extname(file.originalname).toLowerCase());
  const mimetype = !!file.mimetype && (file.mimetype.startsWith("audio/") || file.mimetype === "video/webm");
  if (extname || mimetype) return cb(null, true);
  cb(new Error("Only audio files (m4a, aac, mp3, ogg, wav, webm, opus, amr) are allowed"));
};

export const uploadAudio = multer({
  storage: storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB ≈ 10+ minutes of compressed voice
  fileFilter: audioFileFilter,
});
