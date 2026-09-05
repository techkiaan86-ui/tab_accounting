const express = require('express');
const router = express.Router();
const controller = require('../controllers/bankingController');
const { authenticateToken } = require('../middlewares/authMiddleware');

// All banking routes require authentication
router.use(authenticateToken);

// 1. Bank Accounts CRUD
router.get('/accounts', controller.getBankAccounts);
router.post('/accounts', controller.createBankAccount);
router.put('/accounts/:id', controller.updateBankAccount);
router.delete('/accounts/:id', controller.deleteBankAccount);

// 2. Statement Import
router.post('/import', controller.importBankStatement);

// 3. Bank Feeds & Transaction Matching
router.get('/transactions', controller.getBankTransactions);
router.get('/transactions/:id/matches', controller.findMatchesForTransaction);
router.post('/transactions/:id/match', controller.matchTransaction);
router.post('/transactions/:id/categorize', controller.categorizeTransaction);
router.post('/transactions/:id/unmatch', controller.unmatchTransaction);

// 4. Bank Reconciliation
router.get('/reconciliation/preview', controller.getReconciliationData);
router.post('/reconciliation/toggle-clear', controller.toggleClearTransaction);
router.post('/reconciliation/commit', controller.commitReconciliation);
router.get('/reconciliation/history', controller.getReconciliationHistory);

module.exports = router;
