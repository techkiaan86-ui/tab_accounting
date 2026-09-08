const prisma = require('../config/prisma');
const { encryptPassword, decryptPassword } = require('../utils/cryptoUtils');
const emailService = require('../services/emailService');

/**
 * Helper to resolve and authorize target company ID
 */
const resolveCompanyId = (req) => {
    let companyId = null;
    if (req.params.id && !isNaN(parseInt(req.params.id))) {
        companyId = parseInt(req.params.id);
    } else if (req.query.companyId && !isNaN(parseInt(req.query.companyId))) {
        companyId = parseInt(req.query.companyId);
    } else if (req.body.companyId && !isNaN(parseInt(req.body.companyId))) {
        companyId = parseInt(req.body.companyId);
    } else if (req.user?.companyId) {
        companyId = parseInt(req.user.companyId);
    }
    return companyId;
};

/**
 * Check if the requesting user has access to the target company
 */
const authorizeCompanyAccess = (req, targetCompanyId) => {
    const userRole = (req.user?.role || '').toUpperCase();
    if (userRole === 'SUPERADMIN') return true;
    const userCompanyId = parseInt(req.user?.companyId);
    return userCompanyId === targetCompanyId;
};

/**
 * GET /api/companies/:id/smtp-settings or /api/companies/smtp-settings
 */
const getSmtpSettings = async (req, res) => {
    try {
        const companyId = resolveCompanyId(req);
        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        if (!authorizeCompanyAccess(req, companyId)) {
            return res.status(403).json({ success: false, message: 'Access denied to this company settings' });
        }

        const settings = await prisma.company_smtp_settings.findUnique({
            where: { companyId }
        });

        if (!settings) {
            return res.status(200).json({
                success: true,
                data: {
                    companyId,
                    host: '',
                    ip: '',
                    port: 587,
                    security: 'TLS',
                    username: '',
                    fromEmail: '',
                    fromName: '',
                    invoiceSubjectTemplate: 'Invoice #{InvoiceNumber} from {CompanyName}',
                    invoiceBodyTemplate: 'Dear {CustomerName},\n\nPlease find attached your invoice #{InvoiceNumber} for {InvoiceAmount}, due on {DueDate}.\n\nYou can also review and pay your invoice online through our secure portal.\n\nThank you for your business.\n\nKind regards,\n{CompanyName}',
                    hasPassword: false,
                    isConfigured: false,
                    lastTestedAt: null,
                    lastTestStatus: null
                }
            });
        }

        // Return configuration WITHOUT exposing the password
        return res.status(200).json({
            success: true,
            data: {
                id: settings.id,
                companyId: settings.companyId,
                host: settings.host || '',
                ip: settings.ip || '',
                port: settings.port || 587,
                security: settings.security || 'TLS',
                username: settings.username || '',
                fromEmail: settings.fromEmail || '',
                fromName: settings.fromName || '',
                invoiceSubjectTemplate: settings.invoiceSubjectTemplate || 'Invoice #{InvoiceNumber} from {CompanyName}',
                invoiceBodyTemplate: settings.invoiceBodyTemplate || 'Dear {CustomerName},\n\nPlease find attached your invoice #{InvoiceNumber} for {InvoiceAmount}, due on {DueDate}.\n\nYou can also review and pay your invoice online through our secure portal.\n\nThank you for your business.\n\nKind regards,\n{CompanyName}',
                hasPassword: Boolean(settings.password && settings.password.length > 0),
                isConfigured: settings.isConfigured,
                lastTestedAt: settings.lastTestedAt,
                lastTestStatus: settings.lastTestStatus
            }
        });
    } catch (error) {
        console.error('Error fetching SMTP settings:', error);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
};

/**
 * PUT /api/companies/:id/smtp-settings or /api/companies/smtp-settings
 */
const updateSmtpSettings = async (req, res) => {
    try {
        const companyId = resolveCompanyId(req);
        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        if (!authorizeCompanyAccess(req, companyId)) {
            return res.status(403).json({ success: false, message: 'Access denied: You cannot modify this company settings' });
        }

        const {
            host,
            ip,
            port,
            security,
            username,
            password,
            fromEmail,
            fromName,
            invoiceSubjectTemplate,
            invoiceBodyTemplate
        } = req.body;

        // Fetch existing settings
        const existingSettings = await prisma.company_smtp_settings.findUnique({
            where: { companyId }
        });

        let encryptedPassword = existingSettings?.password || null;

        // If new password provided, encrypt it (skip dummy mask like '••••••••')
        if (password && typeof password === 'string' && password.trim() !== '' && !password.includes('•••')) {
            encryptedPassword = encryptPassword(password.trim());
        }

        const trimmedHost = (host || '').trim();
        const trimmedUsername = (username || '').trim();
        const trimmedFromEmail = (fromEmail || '').trim();
        const parsedPort = parseInt(port) || 587;
        const selectedSecurity = (security || 'TLS').trim().toUpperCase();

        const isConfigured = Boolean(
            trimmedHost &&
            trimmedUsername &&
            trimmedFromEmail &&
            encryptedPassword
        );

        const dataToSave = {
            host: trimmedHost,
            ip: (ip || '').trim(),
            port: parsedPort,
            security: selectedSecurity,
            username: trimmedUsername,
            password: encryptedPassword,
            fromEmail: trimmedFromEmail,
            fromName: (fromName || '').trim(),
            isConfigured
        };

        if (invoiceSubjectTemplate !== undefined) {
            dataToSave.invoiceSubjectTemplate = invoiceSubjectTemplate ? invoiceSubjectTemplate.trim() : null;
        }
        if (invoiceBodyTemplate !== undefined) {
            dataToSave.invoiceBodyTemplate = invoiceBodyTemplate ? invoiceBodyTemplate.trim() : null;
        }

        const savedSettings = await prisma.company_smtp_settings.upsert({
            where: { companyId },
            update: dataToSave,
            create: {
                companyId,
                ...dataToSave
            }
        });

        return res.status(200).json({
            success: true,
            message: isConfigured ? 'SMTP settings saved and enabled successfully' : 'SMTP settings saved (Incomplete credentials)',
            data: {
                companyId: savedSettings.companyId,
                host: savedSettings.host,
                ip: savedSettings.ip,
                port: savedSettings.port,
                security: savedSettings.security,
                username: savedSettings.username,
                fromEmail: savedSettings.fromEmail,
                fromName: savedSettings.fromName,
                invoiceSubjectTemplate: savedSettings.invoiceSubjectTemplate || 'Invoice #{InvoiceNumber} from {CompanyName}',
                invoiceBodyTemplate: savedSettings.invoiceBodyTemplate || 'Dear {CustomerName},\n\nPlease find attached your invoice #{InvoiceNumber} for {InvoiceAmount}, due on {DueDate}.\n\nYou can also review and pay your invoice online through our secure portal.\n\nThank you for your business.\n\nKind regards,\n{CompanyName}',
                hasPassword: Boolean(savedSettings.password),
                isConfigured: savedSettings.isConfigured,
                lastTestedAt: savedSettings.lastTestedAt,
                lastTestStatus: savedSettings.lastTestStatus
            }
        });

    } catch (error) {
        console.error('Error saving SMTP settings:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to save SMTP settings' });
    }
};

/**
 * POST /api/companies/:id/smtp-test-connection
 */
const testSmtpConnection = async (req, res) => {
    try {
        const companyId = resolveCompanyId(req);
        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        if (!authorizeCompanyAccess(req, companyId)) {
            return res.status(403).json({ success: false, message: 'Access denied to this company settings' });
        }

        const {
            host: bodyHost,
            ip: bodyIp,
            port: bodyPort,
            security: bodySecurity,
            username: bodyUsername,
            password: bodyPassword
        } = req.body;

        let host = bodyHost;
        let ip = bodyIp;
        let port = bodyPort;
        let security = bodySecurity;
        let username = bodyUsername;
        let password = bodyPassword;

        // If credentials not passed in body or password is dummy mask, load from DB
        if (!host || !username || !password || password.includes('•••')) {
            const dbSettings = await prisma.company_smtp_settings.findUnique({
                where: { companyId }
            });

            if (!dbSettings || !dbSettings.host || !dbSettings.username || !dbSettings.password) {
                return res.status(400).json({
                    success: false,
                    message: 'Incomplete credentials. Please enter Host, Username, and Password to test connection.'
                });
            }

            host = host || dbSettings.host;
            ip = ip || dbSettings.ip;
            port = port || dbSettings.port;
            security = security || dbSettings.security;
            username = username || dbSettings.username;
            password = (!password || password.includes('•••')) ? decryptPassword(dbSettings.password) : password;
        }

        const smtpConfig = {
            host: (host || '').trim(),
            ip: (ip || '').trim(),
            port: parseInt(port) || 587,
            security: (security || 'TLS').trim().toUpperCase(),
            username: (username || '').trim(),
            password: (password || '').trim()
        };

        try {
            await emailService.verifySmtpConnection(smtpConfig);

            // Update DB test status if record exists
            try {
                await prisma.company_smtp_settings.updateMany({
                    where: { companyId },
                    data: {
                        lastTestedAt: new Date(),
                        lastTestStatus: 'SUCCESS'
                    }
                });
            } catch (dbErr) {}

            return res.status(200).json({
                success: true,
                message: `Connection to SMTP server (${smtpConfig.host}:${smtpConfig.port}) verified successfully!`
            });
        } catch (connErr) {
            try {
                await prisma.company_smtp_settings.updateMany({
                    where: { companyId },
                    data: {
                        lastTestedAt: new Date(),
                        lastTestStatus: 'FAILED'
                    }
                });
            } catch (dbErr) {}

            let errorMessage = connErr.message || 'Unknown network/authentication error';
            if ((connErr.code === 'EAUTH' || connErr.responseCode === 535 || (connErr.message && connErr.message.includes('BadCredentials'))) && (smtpConfig.host || '').includes('gmail.com')) {
                errorMessage = 'Authentication Failed (Invalid Credentials). For Gmail accounts, Google requires a 16-character "App Password" (generated at myaccount.google.com/apppasswords) instead of your regular Gmail account password.';
            } else if (connErr.code === 'ETIMEDOUT' || (connErr.message && connErr.message.toLowerCase().includes('timeout'))) {
                errorMessage = `Connection timed out connecting to ${smtpConfig.host}:${smtpConfig.port}. Cloud hosting providers (like Railway) block direct outbound SMTP ports (465/587) by default. Try switching to Port 587 (TLS), test locally, or request Railway to unblock SMTP.`;
            }

            return res.status(400).json({
                success: false,
                message: `SMTP Connection Failed: ${errorMessage}`
            });
        }

    } catch (error) {
        console.error('Error in testSmtpConnection:', error);
        res.status(500).json({ success: false, message: error.message || 'Internal server error' });
    }
};

/**
 * POST /api/companies/:id/smtp-send-test-email
 */
const sendSmtpTestEmail = async (req, res) => {
    try {
        const companyId = resolveCompanyId(req);
        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        if (!authorizeCompanyAccess(req, companyId)) {
            return res.status(403).json({ success: false, message: 'Access denied to this company settings' });
        }

        const {
            toEmail,
            host: bodyHost,
            ip: bodyIp,
            port: bodyPort,
            security: bodySecurity,
            username: bodyUsername,
            password: bodyPassword,
            fromEmail: bodyFromEmail,
            fromName: bodyFromName
        } = req.body;

        if (!toEmail || !toEmail.includes('@')) {
            return res.status(400).json({ success: false, message: 'A valid destination test email is required' });
        }

        let host = bodyHost;
        let ip = bodyIp;
        let port = bodyPort;
        let security = bodySecurity;
        let username = bodyUsername;
        let password = bodyPassword;
        let fromEmail = bodyFromEmail;
        let fromName = bodyFromName;

        // Fetch company name for display
        const company = await prisma.company.findUnique({
            where: { id: companyId },
            select: { name: true }
        });

        // If credentials not in body, load from DB
        if (!host || !username || !password || password.includes('•••')) {
            const dbSettings = await prisma.company_smtp_settings.findUnique({
                where: { companyId }
            });

            if (!dbSettings || !dbSettings.host || !dbSettings.username || !dbSettings.password) {
                return res.status(400).json({
                    success: false,
                    message: 'SMTP credentials not found in database. Please enter or save your credentials before sending a test email.'
                });
            }

            host = host || dbSettings.host;
            ip = ip || dbSettings.ip;
            port = port || dbSettings.port;
            security = security || dbSettings.security;
            username = username || dbSettings.username;
            password = (!password || password.includes('•••')) ? decryptPassword(dbSettings.password) : password;
            fromEmail = fromEmail || dbSettings.fromEmail;
            fromName = fromName || dbSettings.fromName;
        }

        const smtpConfig = {
            host: (host || '').trim(),
            ip: (ip || '').trim(),
            port: parseInt(port) || 587,
            security: (security || 'TLS').trim().toUpperCase(),
            username: (username || '').trim(),
            password: (password || '').trim(),
            fromEmail: (fromEmail || username || '').trim(),
            fromName: (fromName || company?.name || 'Tab Accounts').trim()
        };

        const result = await emailService.sendSmtpTestEmail({
            smtpConfig,
            toEmail: toEmail.trim(),
            companyName: company?.name || smtpConfig.fromName
        });

        // Update DB test status
        try {
            await prisma.company_smtp_settings.updateMany({
                where: { companyId },
                data: {
                    lastTestedAt: new Date(),
                    lastTestStatus: 'SUCCESS'
                }
            });
        } catch (dbErr) {}

        return res.status(200).json({
            success: true,
            message: `Test email sent successfully to ${toEmail.trim()}!`,
            data: result
        });

    } catch (error) {
        console.error('Error sending test email:', error);
        let errorMsg = error.message || 'SMTP transmission failure';
        if ((error.code === 'EAUTH' || error.responseCode === 535 || (error.message && error.message.includes('BadCredentials'))) && (bodyHost || '').includes('gmail.com')) {
            errorMsg = 'Authentication Failed (Invalid Credentials). For Gmail accounts, Google requires a 16-character "App Password" (generated at myaccount.google.com/apppasswords) instead of your regular Gmail account password.';
        } else if (error.code === 'ETIMEDOUT' || (error.message && error.message.toLowerCase().includes('timeout'))) {
            errorMsg = `Connection timed out connecting to ${bodyHost || 'SMTP server'}:${bodyPort || 587}. Cloud hosting providers (like Railway) block direct outbound SMTP ports (465/587) by default. Try switching to Port 587 (TLS), test locally, or request Railway to unblock SMTP.`;
        }
        return res.status(400).json({
            success: false,
            message: `Failed to send test email: ${errorMsg}`
        });
    }
};

module.exports = {
    getSmtpSettings,
    updateSmtpSettings,
    testSmtpConnection,
    sendSmtpTestEmail
};
