require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
const api_key = process.env.CLOUDINARY_API_KEY;
const api_secret = process.env.CLOUDINARY_API_SECRET;

const isConfigured = Boolean(cloud_name && api_key && api_secret &&
    cloud_name !== 'your_cloud_name' &&
    api_key !== 'your_api_key' &&
    api_secret !== 'your_api_secret');

if (!isConfigured) {
    console.warn('--- WARNING: Cloudinary is not configured correctly. Uploads will fallback to Base64. ---');
}

cloudinary.config({
    cloud_name: isConfigured ? cloud_name : 'placeholder',
    api_key: isConfigured ? api_key : 'placeholder',
    api_secret: isConfigured ? api_secret : 'placeholder',
});

// Memory storage keeps file buffers accessible for direct Cloudinary upload or Base64 fallback
const storage = multer.memoryStorage();

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const fs = require('fs');
const path = require('path');

const saveToLocalDisk = (buffer, mimetype, folderName) => {
    try {
        const uploadDir = path.join(__dirname, '../../uploads', folderName);
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        const ext = mimetype ? (mimetype.split('/')[1] || 'png') : 'png';
        const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;
        const filePath = path.join(uploadDir, filename);
        fs.writeFileSync(filePath, buffer);
        return `/uploads/${folderName}/${filename}`;
    } catch (e) {
        console.error('Local disk save error:', e);
        return `data:${mimetype || 'image/png'};base64,${buffer.toString('base64')}`;
    }
};

/**
 * Helper function to upload a file (from req.file or req.files field) to Cloudinary,
 * or fallback to local disk / base64 Data URI if Cloudinary is not configured or fails.
 */
const uploadToCloudinaryOrBase64 = async (file, folder = 'company_logos') => {
    if (!file) return null;

    if (typeof file === 'string') {
        // If string is a large base64 string, convert and save locally to prevent MySQL max_allowed_packet crash
        if (file.startsWith('data:') && file.length > 100000) {
            const matches = file.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                const mimetype = matches[1];
                const buffer = Buffer.from(matches[2], 'base64');
                return saveToLocalDisk(buffer, mimetype, folder);
            }
        }
        return file;
    }

    if (file.secure_url) return file.secure_url;
    if (file.url) return file.url;

    if (file.buffer) {
        if (isConfigured) {
            try {
                const base64Data = file.buffer.toString('base64');
                const dataUri = `data:${file.mimetype || 'image/png'};base64,${base64Data}`;
                const result = await cloudinary.uploader.upload(dataUri, {
                    folder: folder,
                    resource_type: 'auto',
                    use_filename: true,
                    unique_filename: true
                });
                return result.secure_url || result.url;
            } catch (err) {
                console.error('Cloudinary upload error:', err);
                return saveToLocalDisk(file.buffer, file.mimetype, folder);
            }
        } else {
            return saveToLocalDisk(file.buffer, file.mimetype, folder);
        }
    }

    if (file.path && typeof file.path === 'string' && file.path.startsWith('http')) {
        return file.path;
    }

    return null;
};

module.exports = {
    cloudinary,
    upload,
    isCloudinaryConfigured: isConfigured,
    uploadToCloudinaryOrBase64
};