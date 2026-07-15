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
