const prisma = require('../config/prisma');
const integrationService = require('./integrationService');

const INTERVAL_MS_MAP = {
    'HOURLY': 60 * 60 * 1000,
    'EVERY_6_HOURS': 6 * 60 * 60 * 1000,
    'DAILY': 24 * 60 * 60 * 1000,
    'WEEKLY': 7 * 24 * 60 * 60 * 1000
};

const isSyncDue = (integration) => {
    if (!integration.enabled) return false;
    if (!integration.lastSync) return true;

    const intervalMs = INTERVAL_MS_MAP[integration.autoSyncInterval] || INTERVAL_MS_MAP['DAILY'];
    const elapsed = Date.now() - new Date(integration.lastSync).getTime();
    return elapsed >= intervalMs;
};

const runSyncForIntegration = async (integration) => {
    const { companyId, provider, webhookUrl, accessToken, syncContacts, syncInvoices } = integration;
    console.log(`[Auto-Sync Worker] Starting background sync for Company ${companyId} - Provider: ${provider}`);

    try {
        let summaryDetails = [];

        if (provider === 'bitrix24') {
            if (!webhookUrl) return;

            if (syncContacts) {
                const contactResult = await integrationService.syncContactsToBitrix(webhookUrl, companyId);
                const pulled = await integrationService.pullContactsFromBitrix(webhookUrl, companyId);
                summaryDetails.push(`Contacts: ${contactResult.created} created, ${contactResult.updated} updated, ${pulled} imported`);
            }

            if (syncInvoices) {
                const invoiceResult = await integrationService.syncInvoicesToBitrix(webhookUrl, companyId);
                summaryDetails.push(`Invoices/Deals: ${invoiceResult.created} created, ${invoiceResult.updated} updated`);
            }
        } else if (provider === 'hubspot') {
            if (!accessToken) return;

            if (syncContacts) {
                const contactResult = await integrationService.syncContactsToHubSpot(accessToken, companyId);
                const pulled = await integrationService.pullContactsFromHubSpot(accessToken, companyId);
                summaryDetails.push(`Contacts: ${contactResult.created} created, ${contactResult.updated} updated, ${pulled} imported`);
            }

            if (syncInvoices) {
                const dealResult = await integrationService.syncInvoicesToHubSpot(accessToken, companyId);
                summaryDetails.push(`Deals: ${dealResult.created} created, ${dealResult.updated} updated`);
            }
        }

        const detailsStr = summaryDetails.join(' | ') || 'Automatic synchronization completed.';

        // Record log and update status
        await prisma.integration_log.create({
            data: {
                companyId,
                provider,
                action: 'Automatic Scheduled Sync',
                status: 'SUCCESS',
                details: detailsStr
            }
        });

        await prisma.company_integration.update({
            where: { id: integration.id },
            data: {
                lastSync: new Date(),
                status: 'CONNECTED'
            }
        });

        console.log(`[Auto-Sync Worker] Completed sync for Company ${companyId} (${provider}): ${detailsStr}`);
    } catch (err) {
        console.error(`[Auto-Sync Worker] Error during sync for Company ${companyId} (${provider}):`, err.message);

        await prisma.integration_log.create({
            data: {
                companyId,
                provider,
                action: 'Automatic Scheduled Sync',
                status: 'ERROR',
                details: `Sync failed: ${err.message}`
            }
        }).catch(() => null);
    }
};

const checkAndExecuteDueSyncs = async () => {
    try {
        const activeIntegrations = await prisma.company_integration.findMany({
            where: { enabled: true }
        });

        for (const integration of activeIntegrations) {
            if (isSyncDue(integration)) {
                await runSyncForIntegration(integration);
            }
        }
    } catch (error) {
        console.error('[Auto-Sync Worker] Error in check loop:', error.message);
    }
};

let workerTimer = null;

const startIntegrationSyncWorker = (intervalMinutes = 30) => {
    if (workerTimer) {
        clearInterval(workerTimer);
    }
    console.log(`[Auto-Sync Worker] Initializing CRM auto-sync worker (Interval: ${intervalMinutes}m)...`);

    // Run first check after a short delay (e.g. 1 minute after server boot)
    setTimeout(checkAndExecuteDueSyncs, 60 * 1000);

    // Schedule regular checks
    workerTimer = setInterval(checkAndExecuteDueSyncs, intervalMinutes * 60 * 1000);
};

module.exports = {
    startIntegrationSyncWorker,
    runSyncForIntegration
};
