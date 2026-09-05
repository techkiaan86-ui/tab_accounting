const fs = require('fs');
const path = require('path');

const PERIOD_LOCK_FILE = path.join(__dirname, '../../period_lock_config.json');

const loadPeriodLocks = () => {
    try {
        if (fs.existsSync(PERIOD_LOCK_FILE)) {
            return JSON.parse(fs.readFileSync(PERIOD_LOCK_FILE, 'utf8'));
        }
    } catch (e) {
        console.warn('[periodLockMiddleware] Error reading lock config:', e.message);
    }
    return {};
};

/**
 * Checks whether a given transaction date falls in a locked accounting period.
 * @param {number|string} companyId 
 * @param {Date|string} transactionDate 
 * @returns {{ isLocked: boolean, lockedUntilDate: string|null, reason: string|null }}
 */
const checkPeriodLock = (companyId, transactionDate) => {
    if (!companyId || !transactionDate) return { isLocked: false };

    const locks = loadPeriodLocks();
    const config = locks[parseInt(companyId)];

    if (!config || !config.isLocked || !config.lockedUntilDate) {
        return { isLocked: false };
    }

    try {
        const txDateObj = new Date(transactionDate);
        if (isNaN(txDateObj.getTime())) return { isLocked: false };

        const txDateStr = txDateObj.toISOString().split('T')[0];
        const lockDateStr = new Date(config.lockedUntilDate).toISOString().split('T')[0];

        if (txDateStr <= lockDateStr) {
            return {
                isLocked: true,
                lockedUntilDate: lockDateStr,
                reason: config.reason || 'Year-End / Period Lock'
            };
        }
    } catch (e) {
        console.error('[periodLockMiddleware] Date parse error:', e);
    }

    return { isLocked: false };
};

/**
 * Express middleware to automatically guard routes receiving transaction dates in req.body
 */
const periodLockGuard = (req, res, next) => {
    try {
        const companyId = req.user?.companyId || req.body?.companyId || req.params?.companyId;
        const txDate = req.body?.date || req.body?.invoiceDate || req.body?.billDate || req.body?.voucherDate || req.body?.transactionDate;

        if (companyId && txDate) {
            const check = checkPeriodLock(companyId, txDate);
            if (check.isLocked) {
                return res.status(403).json({
                    success: false,
                    isPeriodLocked: true,
                    message: `Accounting period is locked up to ${check.lockedUntilDate} (${check.reason}). Transactions on or before this date cannot be created or modified.`
                });
            }
        }
        next();
    } catch (err) {
        next(err);
    }
};

module.exports = {
    checkPeriodLock,
    periodLockGuard,
    loadPeriodLocks
};
