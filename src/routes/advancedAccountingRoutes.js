const express = require('express');
const router = express.Router();
const controller = require('../controllers/advancedAccountingController');
const { authenticateToken } = require('../middlewares/authMiddleware');

// 1. Currency Revaluation
router.get('/currency-revaluation/preview', authenticateToken, controller.getCurrencyRevaluationPreview);
router.post('/currency-revaluation/post', authenticateToken, controller.postCurrencyRevaluationJournal);

// 2. Fiscal Year Rollover
router.get('/fiscal-rollover/preview', authenticateToken, controller.getFiscalYearRolloverPreview);
router.post('/fiscal-rollover/execute', authenticateToken, controller.executeFiscalYearRollover);

// 3. Fixed Assets & Depreciation
router.get('/assets', authenticateToken, controller.getFixedAssets);
router.post('/assets', authenticateToken, controller.createFixedAsset);
router.post('/assets/depreciate', authenticateToken, controller.runDepreciation);
router.delete('/assets/:id', authenticateToken, controller.deleteFixedAsset);

// 4. Budgets & Forecasts
router.get('/budgets', authenticateToken, controller.getBudgets);
router.post('/budgets', authenticateToken, controller.createBudget);
router.get('/budgets/:id/variance', authenticateToken, controller.getBudgetVarianceReport);
router.get('/cash-flow-forecast', authenticateToken, controller.getCashFlowForecast);

// 5. Recurring Transactions
router.get('/recurring', authenticateToken, controller.getRecurringTemplates);
router.post('/recurring', authenticateToken, controller.createRecurringTemplate);
router.post('/recurring/run-pending', authenticateToken, controller.runPendingRecurringTransactions);
router.delete('/recurring/:id', authenticateToken, controller.deleteRecurringTemplate);

module.exports = router;
