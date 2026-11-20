import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticate } from '../../middleware/authenticate.js';
import { AppError, ValidationError } from '../../middleware/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// ── Multer: in-memory storage, images only, max 5 MB ──────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new ValidationError('Only JPEG, PNG, and WebP images are accepted') as any);
    }
  },
});

// ── Paths ──────────────────────────────────────────────────────────────────────
const SCRIPT_PATH = path.resolve(__dirname, '../../../../scripts/infer_face.py');
const MODEL_PATH  = path.resolve(__dirname, '../../../../models/deepfake_head.pth');

// ── Run Python inference (one subprocess per request; simple & robust) ─────────
function runInference(imageBuffer: Buffer): Promise<{
  prediction: 'real' | 'fake';
  scores: { fake: number; real: number };
  confidence: number;
}> {
  return new Promise((resolve, reject) => {
    // Try the known Python 3.11 path on Windows, fall back to system python/python3
    const pythonBin =
      process.platform === 'win32'
        ? (process.env.PYTHON_BIN ||
           'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python311\\python.exe')
        : (process.env.PYTHON_BIN || 'python3');

    const proc = spawn(pythonBin, [SCRIPT_PATH, MODEL_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      reject(
        new AppError(
          `Face analysis unavailable: could not start Python. ` +
          `Ensure Python 3 is installed and 'python' is on PATH, ` +
          `and run: pip install torch torchvision Pillow. Details: ${err.message}`,
          503,
          'SIDECAR_UNAVAILABLE',
        ),
      );
    });

    proc.on('close', (code) => {
      // Parse all JSON lines from stdout; take the last non-"ready" one
      const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      let result: any = null;

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.status === 'ready') continue; // skip ready signal
          result = parsed;
        } catch { /* skip malformed */ }
      }

      if (result?.error) {
        return reject(new AppError(result.error, 500, 'INFERENCE_ERROR'));
      }

      if (result?.prediction) {
        return resolve(result);
      }

      // Fallback: something went wrong
      const errMsg = stderr.trim() || `Python exited with code ${code}`;
      reject(new AppError(`Inference failed: ${errMsg}`, 500, 'INFERENCE_ERROR'));
    });

    // Send image as base64 JSON line and close stdin
    const b64 = imageBuffer.toString('base64');
    proc.stdin.write(JSON.stringify({ image_b64: b64 }) + '\n');
    proc.stdin.end();
  });
}

// ── POST /api/v1/face-analysis ─────────────────────────────────────────────────
router.post(
  '/face-analysis',
  authenticate,
  upload.single('image'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.file) {
        throw new ValidationError('An image file is required (field name: "image")');
      }

      const result = await runInference(req.file.buffer);

      res.status(200).json({
        success: true,
        data: {
          prediction: result.prediction,
          scores: result.scores,
          confidence: result.confidence,
          disclaimer:
            'This is an experimental model estimate (\u224879% validation accuracy on training dataset). ' +
            'It is not a definitive authenticity verdict and does not apply to videos.',
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
