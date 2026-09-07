const express = require('express');
const router = express.Router();
const integrationController = require('../controllers/integrationController');
const { authenticateToken } = require('../middlewares/authMiddleware');

router.use(authenticateToken);

router.get('/settings', integrationController.getIntegrationSettings);
router.get('/logs', integrationController.getIntegrationLogs);
router.post('/bitrix24/save', integrationController.saveBitrixSettings);
router.post('/bitrix24/test', integrationController.testBitrixConnection);
router.post('/bitrix24/sync', integrationController.syncBitrix);

router.post('/hubspot/save', integrationController.saveHubspotSettings);
router.post('/hubspot/test', integrationController.testHubspotConnection);
router.post('/hubspot/sync', integrationController.syncHubspot);

module.exports = router;
