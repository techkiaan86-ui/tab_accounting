const crypto = require('crypto');

// Derive a 32-byte key from JWT_SECRET or ENCRYPTION_KEY using a fixed salt
const getEncryptionKey = () => {
    const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'tab-accounts-secure-encryption-key-2026';
    return crypto.scryptSync(secret, 'tab_accounts_smtp_salt', 32);
};

/**
 * Encrypt plaintext string using AES-256-GCM
 * @param {string} text Plaintext to encrypt
 * @returns {string} ivHex:authTagHex:cipherHex
 */
const encryptPassword = (text) => {
    if (!text || typeof text !== 'string') return null;
    try {
        const key = getEncryptionKey();
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag();
        return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
    } catch (err) {
        console.error('[cryptoUtils] Encryption error occurred');
        throw new Error('Failed to encrypt sensitive data');
    }
};

/**
 * Decrypt ciphertext string using AES-256-GCM
 * @param {string} encryptedString ivHex:authTagHex:cipherHex
 * @returns {string} Plaintext
 */
const decryptPassword = (encryptedString) => {
    if (!encryptedString || typeof encryptedString !== 'string') return '';
    const parts = encryptedString.split(':');
    if (parts.length !== 3) {
        return '';
    }
    try {
        const [ivHex, authTagHex, cipherHex] = parts;
        const key = getEncryptionKey();
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        console.error('[cryptoUtils] Decryption error occurred');
        return '';
    }
};

module.exports = {
    encryptPassword,
    decryptPassword
};
