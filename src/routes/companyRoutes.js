const express = require('express');
const {
    createCompany,
    createUserCompany,
    getUserCompanies,
    getCompanies,
    getCompanyById,
    updateCompany,
    deleteCompany,
    getNumberingSettings,
    updateNumberingSettings,
    getNextNumberEndpoint,
    getPeriodLockSettings,
    updatePeriodLockSettings
} = require('../controllers/companyController');
const {
    getSmtpSettings,
    updateSmtpSettings,
    testSmtpConnection,
    sendSmtpTestEmail,
    clearSmtpSettings
} = require('../controllers/smtpController');
const { authenticateToken, authorizeRoles } = require('../middlewares/authMiddleware');
const { upload } = require('../utils/cloudinaryConfig');

const router = express.Router();

// Middleware to check if user has access to this company
const checkCompanyAccess = (req, res, next) => {
    const userRole = (req.user.role || '').toUpperCase();

    if (userRole === 'SUPERADMIN') return next();

    // Convert to numbers for safe comparison
    const requestedCompanyId = Number(req.params.id);
    if (isNaN(requestedCompanyId)) {
        return next('route');
    }
    const userCompanyId = Number(req.user.companyId);

    if (userCompanyId === requestedCompanyId) {
        // Allow GET request for all roles within the company (COMPANY, ADMIN, USER, USERS, etc.)
        if (req.method === 'GET') return next();

        // For other requests (like PUT), only allow COMPANY and ADMIN roles
        if (['COMPANY', 'ADMIN'].includes(userRole)) return next();

        return res.status(403).json({
            message: 'Access denied: Your role does not have permission to modify this company',
            debug: { role: userRole, method: req.method }
        });
    }

    return res.status(403).json({
        message: 'Access denied: You do not belong to this company',
        debug: { userCompanyId, requestedCompanyId }
    });
};

// Direct Period Lock endpoints (using active companyId from token)
router.get('/period-lock', authenticateToken, getPeriodLockSettings);
router.put('/period-lock', authenticateToken, updatePeriodLockSettings);

// Direct SMTP Settings endpoints (using active companyId from token)
router.get('/smtp-settings', authenticateToken, getSmtpSettings);
router.put('/smtp-settings', authenticateToken, updateSmtpSettings);
router.delete('/smtp-settings', authenticateToken, clearSmtpSettings);
router.post('/smtp-test-connection', authenticateToken, testSmtpConnection);
router.post('/smtp-send-test-email', authenticateToken, sendSmtpTestEmail);

// User multi-company endpoints
router.post('/user-company', authenticateToken, upload.single('logo'), createUserCompany);
router.get('/user-companies', authenticateToken, getUserCompanies);

// Only Superadmin can create companies or view all companies
router.post('/', authenticateToken, authorizeRoles('SUPERADMIN'), upload.single('logo'), createCompany);
router.get('/', authenticateToken, authorizeRoles('SUPERADMIN'), getCompanies);

// Numbering configuration endpoints
router.get('/:id/numbering-settings', authenticateToken, checkCompanyAccess, getNumberingSettings);
router.put('/:id/numbering-settings', authenticateToken, checkCompanyAccess, updateNumberingSettings);
router.get('/:id/next-number', authenticateToken, checkCompanyAccess, getNextNumberEndpoint);

// Period Lock endpoints
router.get('/:id/period-lock', authenticateToken, checkCompanyAccess, getPeriodLockSettings);
router.put('/:id/period-lock', authenticateToken, checkCompanyAccess, updatePeriodLockSettings);

// SMTP Settings endpoints
router.get('/:id/smtp-settings', authenticateToken, checkCompanyAccess, getSmtpSettings);
router.put('/:id/smtp-settings', authenticateToken, checkCompanyAccess, updateSmtpSettings);
router.delete('/:id/smtp-settings', authenticateToken, checkCompanyAccess, clearSmtpSettings);
router.post('/:id/smtp-test-connection', authenticateToken, checkCompanyAccess, testSmtpConnection);
router.post('/:id/smtp-send-test-email', authenticateToken, checkCompanyAccess, sendSmtpTestEmail);

// Company by ID endpoints (must be defined AFTER specific sub-routes)
router.get('/:id', authenticateToken, checkCompanyAccess, getCompanyById);
router.put('/:id', authenticateToken, checkCompanyAccess, upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'invoiceLogo', maxCount: 1 }]), updateCompany);
router.delete('/:id', authenticateToken, checkCompanyAccess, authorizeRoles('SUPERADMIN'), deleteCompany);

module.exports = router;
