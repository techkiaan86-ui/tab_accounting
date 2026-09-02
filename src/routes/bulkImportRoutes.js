const express = require('express');
const router = express.Router();
const bulkImportController = require('../controllers/bulkImportController');
const { authenticateToken } = require('../middlewares/authMiddleware');

router.post('/products', authenticateToken, bulkImportController.importProducts);
router.post('/customers', authenticateToken, bulkImportController.importCustomers);
router.post('/vendors', authenticateToken, bulkImportController.importVendors);
router.post('/chart-of-accounts', authenticateToken, bulkImportController.importChartOfAccounts);
router.post('/sales-invoices', authenticateToken, bulkImportController.importSalesInvoices);
router.post('/purchase-bills', authenticateToken, bulkImportController.importPurchaseBills);

module.exports = router;
