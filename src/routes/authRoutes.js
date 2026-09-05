const express = require('express');
const { register, login, impersonate, switchCompany } = require('../controllers/authController');
const { authenticateToken, authorizeRoles } = require('../middlewares/authMiddleware');
const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/impersonate', authenticateToken, authorizeRoles('SUPERADMIN'), impersonate);
router.post('/switch-company', authenticateToken, switchCompany);

module.exports = router;
