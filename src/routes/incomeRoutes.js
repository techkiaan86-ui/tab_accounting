const express = require('express');
const router = express.Router();
const { createIncome, getIncome, deleteIncome, updateIncome } = require('../controllers/incomeController');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { periodLockGuard } = require('../middlewares/periodLockMiddleware');

router.post('/', authenticateToken, periodLockGuard, createIncome);
router.get('/', authenticateToken, getIncome);
router.delete('/:voucherNumber', authenticateToken, deleteIncome);
router.put('/:voucherNumber', authenticateToken, periodLockGuard, updateIncome);

module.exports = router;
