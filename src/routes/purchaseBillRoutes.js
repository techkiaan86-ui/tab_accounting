const express = require('express');
const router = express.Router();
const purchaseBillController = require('../controllers/purchaseBillController');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { periodLockGuard } = require('../middlewares/periodLockMiddleware');

router.use(authenticateToken);

router.post('/cleanup-orphaned-journals', purchaseBillController.cleanupOrphanedJournals);
router.post('/', periodLockGuard, purchaseBillController.createBill);
router.get('/', purchaseBillController.getBills);
router.get('/next-number', purchaseBillController.getNextNumber);
router.get('/:id', purchaseBillController.getBillById);
router.put('/:id', periodLockGuard, purchaseBillController.updateBill);
router.delete('/:id', purchaseBillController.deleteBill);
router.post('/:id/unpay', purchaseBillController.unpayBill);

module.exports = router;
