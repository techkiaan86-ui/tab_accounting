const prisma = require('../config/prisma');
const { logActivity } = require('../utils/auditLogger');
const integrationService = require('../services/integrationService');

/**
 * Get Integration status, configuration, and recent audit logs
 */
const getIntegrationSettings = async (req, res) => {
    try {
        const companyId = req.user.companyId;

        // Fetch company integration records from MySQL
        const integrations = await prisma.company_integration.findMany({
            where: { companyId }
        });

        const bitrix = integrations.find(i => i.provider === 'bitrix24');
        const hubspot = integrations.find(i => i.provider === 'hubspot');

        // Fetch the 25 most recent integration logs for this company
        const logs = await prisma.integration_log.findMany({
            where: { companyId },
            orderBy: { createdAt: 'desc' },
            take: 25
        });

        const safeConfig = {
            bitrix24: {
                enabled: bitrix ? bitrix.enabled : false,
                webhookUrl: bitrix && bitrix.webhookUrl
                    ? bitrix.webhookUrl.replace(/(\/rest\/[0-9]+\/)([^/]+)(\/)/, '$1********$3')
                    : '',
                syncContacts: bitrix ? bitrix.syncContacts : true,
                syncInvoices: bitrix ? bitrix.syncInvoices : true,
                autoSyncInterval: bitrix ? bitrix.autoSyncInterval : 'DAILY',
                lastSync: bitrix ? bitrix.lastSync : null,
                status: bitrix ? bitrix.status : 'NOT_CONFIGURED'
            },
            hubspot: {
                enabled: hubspot ? hubspot.enabled : false,
                accessToken: hubspot && hubspot.accessToken
                    ? `••••••••••••${hubspot.accessToken.slice(-4)}`
                    : '',
                syncContacts: hubspot ? hubspot.syncContacts : true,
                syncDeals: hubspot ? hubspot.syncInvoices : true,
                autoSyncInterval: hubspot ? hubspot.autoSyncInterval : 'DAILY',
                lastSync: hubspot ? hubspot.lastSync : null,
                status: hubspot ? hubspot.status : 'NOT_CONFIGURED'
            }
        };

        const formattedLogs = logs.map(l => ({
            id: l.id,
            crm: l.provider === 'bitrix24' ? 'Bitrix24 CRM' : 'HubSpot CRM',
            action: l.action,
            timestamp: new Date(l.createdAt).toLocaleString(),
            status: l.status,
            details: l.details || ''
        }));

        res.status(200).json({
            success: true,
            data: safeConfig,
            logs: formattedLogs
        });
    } catch (err) {
        console.error('Error in getIntegrationSettings:', err);
        res.status(500).json({ success: false, message: 'Failed to load integration settings', error: err.message });
    }
};

/**
 * Save Bitrix24 Settings
 */
const saveBitrixSettings = async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const { webhookUrl, enabled, syncContacts, syncInvoices, autoSyncInterval } = req.body;

        const existing = await prisma.company_integration.findUnique({
            where: {
                companyId_provider: {
                    companyId,
                    provider: 'bitrix24'
                }
            }
        });

        // If webhookUrl wasn't modified (or was submitted with masked asterisks), keep existing
        let finalWebhookUrl = webhookUrl;
        if (webhookUrl && webhookUrl.includes('********') && existing) {
            finalWebhookUrl = existing.webhookUrl;
        }

        const status = finalWebhookUrl ? (existing?.status === 'CONNECTED' ? 'CONNECTED' : 'CONFIGURED') : 'NOT_CONFIGURED';

        await prisma.company_integration.upsert({
            where: {
                companyId_provider: {
                    companyId,
                    provider: 'bitrix24'
                }
            },
            update: {
                enabled: !!enabled,
                webhookUrl: finalWebhookUrl || existing?.webhookUrl || '',
                syncContacts: syncContacts !== undefined ? !!syncContacts : true,
                syncInvoices: syncInvoices !== undefined ? !!syncInvoices : true,
                autoSyncInterval: autoSyncInterval || 'DAILY',
                status
            },
            create: {
                companyId,
                provider: 'bitrix24',
                enabled: !!enabled,
                webhookUrl: finalWebhookUrl || '',
                syncContacts: syncContacts !== undefined ? !!syncContacts : true,
                syncInvoices: syncInvoices !== undefined ? !!syncInvoices : true,
                autoSyncInterval: autoSyncInterval || 'DAILY',
                status
            }
        });

        logActivity(req, 'UPDATE', 'Integration', companyId, 'Updated Bitrix24 CRM settings');

        res.status(200).json({
            success: true,
            message: 'Bitrix24 settings saved successfully!'
        });
    } catch (err) {
        console.error('Error saving Bitrix24 settings:', err);
        res.status(500).json({ success: false, message: 'Failed to save Bitrix24 settings', error: err.message });
    }
};

/**
 * Test Bitrix24 Connection
 */
const testBitrixConnection = async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const { webhookUrl } = req.body;

        let targetUrl = webhookUrl;
        if (!targetUrl || targetUrl.includes('********')) {
            const existing = await prisma.company_integration.findUnique({
                where: { companyId_provider: { companyId, provider: 'bitrix24' } }
            });
            targetUrl = existing?.webhookUrl;
        }

        if (!targetUrl) {
            return res.status(400).json({ success: false, message: 'Bitrix24 Inbound Webhook URL is required' });
        }

        const testResult = await integrationService.testBitrixConnection(targetUrl);

        // Update status in DB
        await prisma.company_integration.upsert({
            where: { companyId_provider: { companyId, provider: 'bitrix24' } },
            update: { status: 'CONNECTED', webhookUrl: targetUrl },
            create: { companyId, provider: 'bitrix24', status: 'CONNECTED', webhookUrl: targetUrl }
        });

        await prisma.integration_log.create({
            data: {
                companyId,
                provider: 'bitrix24',
                action: 'Connection Test',
                status: 'SUCCESS',
                details: 'Connection test passed. Webhook authenticated with Bitrix24 CRM.'
            }
        });

        res.status(200).json({
            success: true,
            message: testResult.message,
            contactCount: testResult.contactCount
        });
    } catch (err) {
        console.error('Error testing Bitrix24 connection:', err);

        await prisma.integration_log.create({
            data: {
                companyId: req.user.companyId,
                provider: 'bitrix24',
                action: 'Connection Test',
                status: 'ERROR',
                details: err.message
            }
        }).catch(() => null);

        res.status(400).json({ success: false, message: err.message || 'Failed to verify Bitrix24 connection' });
    }
};

/**
 * Trigger Bitrix24 Synchronization
 */
const syncBitrix = async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const integration = await prisma.company_integration.findUnique({
            where: { companyId_provider: { companyId, provider: 'bitrix24' } }
        });

        if (!integration || !integration.webhookUrl) {
            return res.status(400).json({
                success: false,
                message: 'Please configure and save your Bitrix24 Webhook URL before syncing'
            });
        }

        const summaryParts = [];
        let totalContactsPushed = 0;
        let totalInvoicesPushed = 0;
        let totalImported = 0;

        if (integration.syncContacts) {
            const contactRes = await integrationService.syncContactsToBitrix(integration.webhookUrl, companyId);
            totalContactsPushed = contactRes.created + contactRes.updated;
            summaryParts.push(`Contacts: ${contactRes.created} added, ${contactRes.updated} updated`);

            const pullCount = await integrationService.pullContactsFromBitrix(integration.webhookUrl, companyId);
            totalImported = pullCount;
            if (pullCount > 0) summaryParts.push(`${pullCount} imported from Bitrix24`);
        }

        if (integration.syncInvoices) {
            const invoiceRes = await integrationService.syncInvoicesToBitrix(integration.webhookUrl, companyId);
            totalInvoicesPushed = invoiceRes.created + invoiceRes.updated;
            summaryParts.push(`Invoices/Deals: ${invoiceRes.created} added, ${invoiceRes.updated} updated`);
        }

        const detailsText = summaryParts.join(' | ') || 'No records matched synchronization criteria.';

        // Update integration lastSync timestamp
        await prisma.company_integration.update({
            where: { id: integration.id },
            data: {
                lastSync: new Date(),
                status: 'CONNECTED'
            }
        });

        // Record audit log
        await prisma.integration_log.create({
            data: {
                companyId,
                provider: 'bitrix24',
                action: 'Manual User Sync',
                status: 'SUCCESS',
                details: detailsText
            }
        });

        logActivity(req, 'SYNC', 'Bitrix24', companyId, detailsText);

        res.status(200).json({
            success: true,
            message: `Bitrix24 synchronization complete! ${detailsText}`,
            data: {
                syncedContacts: totalContactsPushed,
                syncedDeals: totalInvoicesPushed,
                importedContacts: totalImported,
                timestamp: new Date().toISOString()
            }
        });
    } catch (err) {
        console.error('Error syncing Bitrix24:', err);

        await prisma.integration_log.create({
            data: {
                companyId: req.user.companyId,
                provider: 'bitrix24',
                action: 'Manual User Sync',
                status: 'ERROR',
                details: `Sync error: ${err.message}`
            }
        }).catch(() => null);

        res.status(500).json({ success: false, message: err.message || 'Bitrix24 sync failed' });
    }
};

/**
 * Save HubSpot Settings
 */
const saveHubspotSettings = async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const { accessToken, enabled, syncContacts, syncDeals, autoSyncInterval } = req.body;

        const existing = await prisma.company_integration.findUnique({
            where: {
                companyId_provider: {
                    companyId,
                    provider: 'hubspot'
                }
            }
        });

        let finalToken = accessToken;
        if (accessToken && accessToken.includes('••••') && existing) {
            finalToken = existing.accessToken;
        }

        const status = finalToken ? (existing?.status === 'CONNECTED' ? 'CONNECTED' : 'CONFIGURED') : 'NOT_CONFIGURED';

        await prisma.company_integration.upsert({
            where: {
                companyId_provider: {
                    companyId,
                    provider: 'hubspot'
                }
            },
            update: {
                enabled: !!enabled,
                accessToken: finalToken || existing?.accessToken || '',
                syncContacts: syncContacts !== undefined ? !!syncContacts : true,
                syncInvoices: syncDeals !== undefined ? !!syncDeals : true,
                autoSyncInterval: autoSyncInterval || 'DAILY',
                status
            },
            create: {
                companyId,
                provider: 'hubspot',
                enabled: !!enabled,
                accessToken: finalToken || '',
                syncContacts: syncContacts !== undefined ? !!syncContacts : true,
                syncInvoices: syncDeals !== undefined ? !!syncDeals : true,
                autoSyncInterval: autoSyncInterval || 'DAILY',
                status
            }
        });

        logActivity(req, 'UPDATE', 'Integration', companyId, 'Updated HubSpot CRM credentials');

        res.status(200).json({
            success: true,
            message: 'HubSpot settings saved successfully!'
        });
    } catch (err) {
        console.error('Error saving HubSpot settings:', err);
        res.status(500).json({ success: false, message: 'Failed to save HubSpot settings', error: err.message });
    }
};

/**
 * Test HubSpot Connection
 */
const testHubspotConnection = async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const { accessToken } = req.body;

        let token = accessToken;
        if (!token || token.includes('••••')) {
            const existing = await prisma.company_integration.findUnique({
                where: { companyId_provider: { companyId, provider: 'hubspot' } }
            });
            token = existing?.accessToken;
        }

        if (!token) {
            return res.status(400).json({ success: false, message: 'HubSpot Private App Token is required' });
        }

        const testResult = await integrationService.testHubspotConnection(token);

        await prisma.company_integration.upsert({
            where: { companyId_provider: { companyId, provider: 'hubspot' } },
            update: { status: 'CONNECTED', accessToken: token },
            create: { companyId, provider: 'hubspot', status: 'CONNECTED', accessToken: token }
        });

        await prisma.integration_log.create({
            data: {
                companyId,
                provider: 'hubspot',
                action: 'Connection Test',
                status: 'SUCCESS',
                details: 'Connection test passed. Authenticated with HubSpot API.'
            }
        });

        res.status(200).json({
            success: true,
            message: testResult.message
        });
    } catch (err) {
        console.error('Error testing HubSpot connection:', err);

        await prisma.integration_log.create({
            data: {
                companyId: req.user.companyId,
                provider: 'hubspot',
                action: 'Connection Test',
                status: 'ERROR',
                details: err.message
            }
        }).catch(() => null);

        res.status(400).json({ success: false, message: err.message || 'Failed to verify HubSpot connection' });
    }
};

/**
 * Trigger HubSpot Synchronization
 */
const syncHubspot = async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const integration = await prisma.company_integration.findUnique({
            where: { companyId_provider: { companyId, provider: 'hubspot' } }
        });

        if (!integration || !integration.accessToken) {
            return res.status(400).json({
                success: false,
                message: 'Please configure and save your HubSpot Private App Token before syncing'
            });
        }

        const summaryParts = [];
        let totalContactsPushed = 0;
        let totalInvoicesPushed = 0;
        let totalImported = 0;

        if (integration.syncContacts) {
            const contactRes = await integrationService.syncContactsToHubSpot(integration.accessToken, companyId);
            totalContactsPushed = contactRes.created + contactRes.updated;
            summaryParts.push(`Contacts: ${contactRes.created} added, ${contactRes.updated} updated`);

            const pullCount = await integrationService.pullContactsFromHubSpot(integration.accessToken, companyId);
            totalImported = pullCount;
            if (pullCount > 0) summaryParts.push(`${pullCount} imported from HubSpot`);
        }

        if (integration.syncInvoices) {
            const invoiceRes = await integrationService.syncInvoicesToHubSpot(integration.accessToken, companyId);
            totalInvoicesPushed = invoiceRes.created + invoiceRes.updated;
            summaryParts.push(`Deals: ${invoiceRes.created} added, ${invoiceRes.updated} updated`);
        }

        const detailsText = summaryParts.join(' | ') || 'No records matched synchronization criteria.';

        await prisma.company_integration.update({
            where: { id: integration.id },
            data: {
                lastSync: new Date(),
                status: 'CONNECTED'
            }
        });

        await prisma.integration_log.create({
            data: {
                companyId,
                provider: 'hubspot',
                action: 'Manual User Sync',
                status: 'SUCCESS',
                details: detailsText
            }
        });

        logActivity(req, 'SYNC', 'HubSpot', companyId, detailsText);

        res.status(200).json({
            success: true,
            message: `HubSpot synchronization complete! ${detailsText}`,
            data: {
                syncedContacts: totalContactsPushed,
                syncedDeals: totalInvoicesPushed,
                importedContacts: totalImported,
                timestamp: new Date().toISOString()
            }
        });
    } catch (err) {
        console.error('Error syncing HubSpot:', err);

        await prisma.integration_log.create({
            data: {
                companyId: req.user.companyId,
                provider: 'hubspot',
                action: 'Manual User Sync',
                status: 'ERROR',
                details: `Sync error: ${err.message}`
            }
        }).catch(() => null);

        res.status(500).json({ success: false, message: err.message || 'HubSpot sync failed' });
    }
};

/**
 * Get recent sync logs
 */
const getIntegrationLogs = async (req, res) => {
    try {
        const companyId = req.user.companyId;
        const logs = await prisma.integration_log.findMany({
            where: { companyId },
            orderBy: { createdAt: 'desc' },
            take: 50
        });

        res.status(200).json({
            success: true,
            logs: logs.map(l => ({
                id: l.id,
                crm: l.provider === 'bitrix24' ? 'Bitrix24 CRM' : 'HubSpot CRM',
                action: l.action,
                timestamp: new Date(l.createdAt).toLocaleString(),
                status: l.status,
                details: l.details || ''
            }))
        });
    } catch (err) {
        console.error('Error fetching integration logs:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch logs' });
    }
};

module.exports = {
    getIntegrationSettings,
    saveBitrixSettings,
    testBitrixConnection,
    syncBitrix,
    saveHubspotSettings,
    testHubspotConnection,
    syncHubspot,
    getIntegrationLogs
};
