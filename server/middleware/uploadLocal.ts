import multer from "multer";
import path from "path";
import fs from "fs";

const isLambda = !!process.env.LAMBDA_TASK_ROOT || !!process.env.NETLIFY;

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const baseDir = isLambda ? path.join("/tmp") : process.cwd();
    const uploadDir = path.join(baseDir, "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req: any, file: any, cb: multer.FileFilterCallback) => {
  const allowedTypes = /jpeg|jpg|png|pdf/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    return cb(null, true);
  } else {
    cb(new Error("Only images (jpeg, jpg, png) and PDFs are allowed"));
  }
};

export const uploadLocal = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: fileFilter
});
