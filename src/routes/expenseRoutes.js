const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expenseController');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { periodLockGuard } = require('../middlewares/periodLockMiddleware');

router.get('/', authenticateToken, expenseController.getExpenses);
router.post('/', authenticateToken, periodLockGuard, expenseController.createExpense);
router.delete('/:voucherNumber', authenticateToken, expenseController.deleteExpense);
router.put('/:voucherNumber', authenticateToken, periodLockGuard, expenseController.updateExpense);

module.exports = router;
