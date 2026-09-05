const express = require('express');
const router = express.Router();
const multer = require('multer');
const { isCloudinaryConfigured, uploadToCloudinaryOrBase64 } = require('../utils/cloudinaryConfig');
const { authenticateToken } = require('../middlewares/authMiddleware');

// Use memory storage so we can handle the buffer ourselves
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

/**
 * POST /api/upload
 * Uploads a single file (image or any file) to Cloudinary or local storage.
 * Accepts: multipart/form-data with field "file"
 * Optional: query param ?folder=vendors|customers|products (default: "uploads")
 * Returns: { success: true, url: "..." }
 */
router.post('/', authenticateToken, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const folder = req.query.folder || 'uploads';
        const fileUrl = await uploadToCloudinaryOrBase64(req.file, folder);

        let finalUrl = fileUrl;
        if (fileUrl && typeof fileUrl === 'string' && fileUrl.startsWith('/uploads/')) {
            const host = req.get('host');
            const protocol = req.protocol;
            finalUrl = `${protocol}://${host}${fileUrl}`;
        }

        return res.status(200).json({
            success: true,
            url: finalUrl,
            original_name: req.file.originalname
        });

    } catch (error) {
        console.error('Upload Error:', error);
        if (req.file && req.file.buffer) {
            const dataUri = `data:${req.file.mimetype || 'image/png'};base64,${req.file.buffer.toString('base64')}`;
            return res.status(200).json({
                success: true,
                url: dataUri,
                original_name: req.file.originalname
            });
        }
        return res.status(500).json({ success: false, message: error.message || 'Upload failed' });
    }
});

module.exports = router;
