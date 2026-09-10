const nodemailer = require('nodemailer');
const dns = require('dns');
const prisma = require('../config/prisma');
const { decryptPassword } = require('../utils/cryptoUtils');
const { generateInvoicePdfBuffer } = require('../utils/pdfGenerator');

// Force IPv4 lookup globally to prevent ENETUNREACH in cloud/container environments (Railway, Docker, etc.)
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

// Filter Nodemailer's internal network interface cache to IPv4 only.
// This prevents Nodemailer from attempting IPv6 socket connections on hosts without IPv6 routing.
try {
    const shared = require('nodemailer/lib/shared');
    if (shared && shared.networkInterfaces) {
        for (const k in shared.networkInterfaces) {
            if (Array.isArray(shared.networkInterfaces[k])) {
                shared.networkInterfaces[k] = shared.networkInterfaces[k].filter(
                    i => i.family === 'IPv4' || i.family === 4
                );
            }
        }
    }
} catch (e) {
    // Ignore if nodemailer internals differ
}

/**
 * Helper to wrap any async SMTP operation with a hard timeout guarantee
 */
const executeWithTimeout = (promise, ms, opName = 'SMTP operation') => {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error(`${opName} timed out after ${ms / 1000}s`);
            err.code = 'ETIMEDOUT';
            reject(err);
        }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timer);
    });
};

/**
 * Configure Nodemailer Transporter using Company's SMTP Credentials
 * @param {Object} smtpConfig
 * @param {string} smtpConfig.host
 * @param {number|string} smtpConfig.port
 * @param {string} [smtpConfig.security] 'TLS', 'SSL', 'NONE'
 * @param {string} smtpConfig.username
 * @param {string} smtpConfig.password Plaintext decrypted password
 * @param {string} [smtpConfig.ip]
 */
const createCompanyTransporter = (smtpConfig) => {
    if (!smtpConfig || !smtpConfig.host || !smtpConfig.username || !smtpConfig.password) {
        throw new Error('Incomplete SMTP configuration: host, username, and password are required.');
    }

    const port = parseInt(smtpConfig.port) || 587;
    const isSsl = (smtpConfig.security || '').toUpperCase() === 'SSL' || port === 465;

    const transportOptions = {
        host: smtpConfig.host,
        port: port,
        secure: isSsl,
        auth: {
            user: smtpConfig.username,
            pass: smtpConfig.password
        },
        tls: {
            rejectUnauthorized: false,
            servername: smtpConfig.host
        },
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 6000
    };

    // If a custom Server IP is provided, use it for localAddress
    if (smtpConfig.ip && smtpConfig.ip.trim()) {
        transportOptions.localAddress = smtpConfig.ip.trim();
    }

    return nodemailer.createTransport(transportOptions);
};

/**
 * Test & Verify an SMTP Connection
 * @param {Object} smtpConfig Plaintext credentials
 */
const verifySmtpConnection = async (smtpConfig) => {
    const transporter = createCompanyTransporter(smtpConfig);
    try {
        await executeWithTimeout(transporter.verify(), 6500, 'Verifying SMTP connection');
        return { success: true, message: 'SMTP connection established successfully!' };
    } finally {
        try { transporter.close(); } catch (e) {}
    }
};

/**
 * Send a Test Email using Company's SMTP Credentials
 * @param {Object} params
 * @param {Object} params.smtpConfig Plaintext credentials
 * @param {string} params.toEmail
 * @param {string} [params.companyName]
 */
const sendSmtpTestEmail = async ({ smtpConfig, toEmail, companyName }) => {
    if (!toEmail) {
        throw new Error('Recipient test email address is required.');
    }

    const transporter = createCompanyTransporter(smtpConfig);
    try {
        const compName = companyName || smtpConfig.fromName || 'Tab Accounts';
        const fromEmail = smtpConfig.fromEmail || smtpConfig.username;
        const fromAddress = `"${compName}" <${fromEmail}>`;

        const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b; }
        .card { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
        .header { background: #1e293b; color: #ffffff; padding: 24px; text-align: center; }
        .body { padding: 24px; }
        .badge { display: inline-block; background: #dcfce7; color: #166534; font-weight: 700; font-size: 12px; padding: 4px 10px; border-radius: 9999px; margin-bottom: 12px; }
        .details-table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px; }
        .details-table td { padding: 8px 12px; border-bottom: 1px solid #f1f5f9; }
        .details-table td.label { color: #64748b; font-weight: 600; width: 35%; }
        .details-table td.val { color: #0f172a; font-weight: 700; }
        .footer { padding: 16px 24px; background: #f8fafc; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #f1f5f9; }
    </style>
</head>
<body>
    <div class="card">
        <div class="header">
            <h2 style="margin:0; font-size: 20px;">SMTP Connection Verified</h2>
            <p style="margin:4px 0 0 0; font-size: 13px; color: #94a3b8;">Tab Accounts Email System</p>
        </div>
        <div class="body">
            <span class="badge">Connection Successful</span>
            <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.5;">
                This test email confirms that your company SMTP configuration is valid and can successfully deliver automated emails (including customer invoices).
            </p>
            <table class="details-table">
                <tr>
                    <td class="label">SMTP Host:</td>
                    <td class="val">${smtpConfig.host}</td>
                </tr>
                <tr>
                    <td class="label">Port / Security:</td>
                    <td class="val">${smtpConfig.port} (${smtpConfig.security || 'TLS'})</td>
                </tr>
                <tr>
                    <td class="label">Username:</td>
                    <td class="val">${smtpConfig.username}</td>
                </tr>
                <tr>
                    <td class="label">From Address:</td>
                    <td class="val">&quot;${compName}&quot; &lt;${fromEmail}&gt;</td>
                </tr>
                <tr>
                    <td class="label">Timestamp:</td>
                    <td class="val">${new Date().toUTCString()}</td>
                </tr>
            </table>
        </div>
        <div class="footer">
            Sent by Tab Accounts Multi-Company SMTP Engine
        </div>
    </div>
</body>
</html>
    `;

        const info = await executeWithTimeout(transporter.sendMail({
            from: fromAddress,
            to: toEmail,
            subject: `Test Email from ${compName} - SMTP Configuration Verified`,
            html: htmlContent,
            text: `Test email from ${compName}. Your SMTP settings (${smtpConfig.host}:${smtpConfig.port}) are working correctly.`
        }), 7500, 'Sending test email');

        return {
            success: true,
            messageId: info.messageId,
            message: `Test email sent successfully to ${toEmail}`
        };
    } finally {
        try { transporter.close(); } catch (e) {}
    }
};

/**
 * Generate Responsive HTML Email Template for Invoices
 */
const generateInvoiceEmailHtml = ({ invoice, company, customMessage, publicUrl }) => {
    const companyName = company?.name || 'Tab Accounts';
    const vatNumber = company?.vatNumber || company?.gstNumber || '';
    const customerName = invoice?.customer?.name || invoice?.customerName || 'Valued Customer';
    const invoiceNumber = invoice?.invoiceNumber || `INV-${invoice?.id}`;
    const invoiceDate = invoice?.date ? new Date(invoice.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
    const dueDate = invoice?.dueDate ? new Date(invoice.dueDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Due upon receipt';
    const currency = invoice?.currency || 'EUR';
    const totalAmount = parseFloat(invoice?.totalAmount || 0).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const balanceAmount = parseFloat(invoice?.balanceAmount !== undefined ? invoice.balanceAmount : invoice?.totalAmount || 0).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const bankName = company?.bankName || '';
    const accountName = company?.accountName || companyName;
    const iban = company?.iban || '';
    const bic = company?.bic || company?.swiftCode || '';
    const sortCode = company?.sortCode || '';
    const accountNumber = company?.accountNumber || '';

    const hasBankDetails = iban || accountNumber;

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Invoice #${invoiceNumber} from ${companyName}</title>
    <style>
        body { margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; line-height: 1.5; }
        .wrapper { width: 100%; max-width: 600px; margin: 0 auto; padding: 24px 12px; }
        .card { background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(15, 23, 42, 0.06); border: 1px solid #e2e8f0; }
        .header { background: #1e293b; color: #ffffff; padding: 28px 24px; text-align: left; }
        .brand-badge { display: inline-block; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; background: rgba(255, 255, 255, 0.15); padding: 4px 8px; border-radius: 4px; margin-bottom: 8px; }
        .company-name { font-size: 20px; font-weight: 800; margin: 0; }
        .vat-badge { font-size: 12px; color: #94a3b8; margin-top: 4px; }
        .body { padding: 24px; }
        .greeting { font-size: 15px; font-weight: 600; color: #0f172a; margin-bottom: 12px; }
        .custom-message { font-size: 14px; color: #334155; margin-bottom: 20px; white-space: pre-line; }
        .invoice-box { background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px 20px; margin-bottom: 20px; }
        .inv-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; color: #64748b; }
        .inv-row:last-child { margin-bottom: 0; }
        .inv-label { font-weight: 600; }
        .inv-value { font-weight: 700; color: #0f172a; }
        .total-row { border-top: 1px solid #e2e8f0; padding-top: 10px; margin-top: 10px; font-size: 16px; color: #0f172a; }
        .total-row .inv-value { font-size: 18px; font-weight: 800; color: #0f172a; }
        .cta-container { text-align: center; margin: 24px 0; }
        .btn-cta { display: inline-block; background: #1e293b; color: #ffffff !important; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 700; letter-spacing: 0.02em; box-shadow: 0 4px 8px rgba(30, 41, 59, 0.2); }
        .btn-cta:hover { background: #334155; }
        .bank-box { background: #ffffff; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 14px 18px; margin-bottom: 20px; font-size: 12px; color: #475569; }
        .bank-title { font-weight: 800; color: #0f172a; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; font-size: 11px; }
        .footer { background: #f8fafc; border-top: 1px solid #f1f5f9; padding: 16px 24px; text-align: center; font-size: 11px; color: #94a3b8; }
    </style>
</head>
<body>
    <div class="wrapper">
        <div class="card">
            <div class="header">
                <span class="brand-badge">Official Invoice</span>
                <h1 class="company-name">${companyName}</h1>
                ${vatNumber ? `<div class="vat-badge">VAT / Tax No: ${vatNumber}</div>` : ''}
            </div>
            <div class="body">
                <div class="greeting">Dear ${customerName},</div>
                <div class="custom-message">
                    ${customMessage || `Please find attached your invoice #${invoiceNumber} from ${companyName}. An overview of the charges is provided below.`}
                </div>

                <div class="invoice-box">
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr>
                            <td style="padding: 4px 0; color: #64748b; font-size: 13px; font-weight: 600;">Invoice Number:</td>
                            <td style="padding: 4px 0; text-align: right; color: #0f172a; font-size: 13px; font-weight: 700;">${invoiceNumber}</td>
                        </tr>
                        <tr>
                            <td style="padding: 4px 0; color: #64748b; font-size: 13px; font-weight: 600;">Issue Date:</td>
                            <td style="padding: 4px 0; text-align: right; color: #0f172a; font-size: 13px; font-weight: 700;">${invoiceDate}</td>
                        </tr>
                        <tr>
                            <td style="padding: 4px 0; color: #64748b; font-size: 13px; font-weight: 600;">Due Date:</td>
                            <td style="padding: 4px 0; text-align: right; color: #0f172a; font-size: 13px; font-weight: 700;">${dueDate}</td>
                        </tr>
                        <tr style="border-top: 1px solid #cbd5e1;">
                            <td style="padding: 8px 0 4px 0; color: #0f172a; font-size: 15px; font-weight: 800;">Total Amount:</td>
                            <td style="padding: 8px 0 4px 0; text-align: right; color: #0f172a; font-size: 16px; font-weight: 800;">${currency} ${totalAmount}</td>
                        </tr>
                        ${parseFloat(balanceAmount) > 0 && parseFloat(balanceAmount) !== parseFloat(totalAmount) ? `
                        <tr>
                            <td style="padding: 4px 0; color: #dc2626; font-size: 14px; font-weight: 800;">Balance Due:</td>
                            <td style="padding: 4px 0; text-align: right; color: #dc2626; font-size: 15px; font-weight: 800;">${currency} ${balanceAmount}</td>
                        </tr>` : ''}
                    </table>
                </div>

                ${publicUrl ? `
                <div class="cta-container">
                    <a href="${publicUrl}" class="btn-cta" target="_blank">View &amp; Pay Invoice Online</a>
                </div>` : ''}

                ${hasBankDetails ? `
                <div class="bank-box">
                    <div class="bank-title">Payment &amp; Bank Transfer Details</div>
                    ${bankName ? `<div><strong>Bank:</strong> ${bankName}</div>` : ''}
                    ${accountName ? `<div><strong>Account Name:</strong> ${accountName}</div>` : ''}
                    ${iban ? `<div><strong>IBAN:</strong> ${iban}</div>` : ''}
                    ${bic ? `<div><strong>BIC / SWIFT:</strong> ${bic}</div>` : ''}
                    ${sortCode ? `<div><strong>Sort Code:</strong> ${sortCode}</div>` : ''}
                    ${accountNumber ? `<div><strong>Account No:</strong> ${accountNumber}</div>` : ''}
                    <div style="margin-top: 4px; color: #0f172a;"><strong>Payment Reference:</strong> ${invoiceNumber}</div>
                </div>` : ''}

                <div style="font-size: 13px; color: #64748b; margin-top: 16px;">
                    If you have any questions or require assistance, please reply directly to this email or contact us at ${company?.email || 'accounts@tabaccounts.com'}.
                </div>
            </div>
            <div class="footer">
                &copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.<br>
                Powered by <strong>Tab Accounts</strong>
            </div>
        </div>
    </div>
</body>
</html>
    `;
};

/**
 * Send Invoice Email using Company-Specific SMTP Configuration
 * @param {Object} params
 * @param {Object} params.invoice
 * @param {Object} params.company
 * @param {string} params.recipientEmail
 * @param {string} [params.subject]
 * @param {string} [params.customMessage]
 * @param {string} [params.publicUrl]
 * @param {boolean} [params.attachPdf=true]
 * @param {Buffer} [params.pdfBuffer]
 * @param {string} [params.pdfBase64]
 * @param {string} [params.bccEmail]
 */
const sendInvoiceEmail = async ({
    invoice,
    company,
    recipientEmail,
    subject,
    customMessage,
    publicUrl,
    attachPdf = true,
    pdfBuffer,
    pdfBase64,
    bccEmail
}) => {
    const companyId = company?.id || invoice?.companyId;
    if (!companyId) {
        throw new Error('Company ID is required to determine SMTP configuration.');
    }

    // Strictly fetch SMTP settings for this company/tenant
    const smtpSettings = await prisma.company_smtp_settings.findUnique({
        where: { companyId: parseInt(companyId) }
    });

    if (!smtpSettings || !smtpSettings.isConfigured || !smtpSettings.host || !smtpSettings.username || !smtpSettings.password) {
        throw new Error('SMTP not configured for this company. Please configure your SMTP settings in Settings > Email / SMTP Settings before sending invoice emails.');
    }

    const decryptedPassword = decryptPassword(smtpSettings.password);
    if (!decryptedPassword) {
        throw new Error('Unable to decrypt SMTP password. Please re-enter and save your SMTP password in Settings > Email / SMTP Settings.');
    }

    const transporter = createCompanyTransporter({
        host: smtpSettings.host,
        port: smtpSettings.port,
        security: smtpSettings.security,
        username: smtpSettings.username,
        password: decryptedPassword,
        ip: smtpSettings.ip
    });

    try {
        const companyName = company?.name || smtpSettings.fromName || 'Tab Accounts';
        const senderEmail = smtpSettings.fromEmail || smtpSettings.username;
        const fromAddress = `"${smtpSettings.fromName || companyName}" <${senderEmail}>`;

        const invoiceNumber = invoice?.invoiceNumber || `INV-${invoice?.id}`;
        const mailSubject = subject || `Invoice #${invoiceNumber} from ${companyName}`;

        const htmlContent = generateInvoiceEmailHtml({
            invoice,
            company,
            customMessage,
            publicUrl
        });

        const mailOptions = {
            from: fromAddress,
            to: recipientEmail,
            subject: mailSubject,
            html: htmlContent,
            text: `Invoice #${invoiceNumber} from ${companyName}\nTotal Amount: ${invoice?.currency || 'EUR'} ${invoice?.totalAmount}\nDue Date: ${invoice?.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : 'Upon receipt'}\n\nView invoice online: ${publicUrl || ''}`
        };

        if (bccEmail) {
            mailOptions.bcc = bccEmail;
        }

        // Attach PDF if requested
        if (attachPdf) {
            let finalBuffer = pdfBuffer;

            if (!finalBuffer && pdfBase64) {
                const cleanBase64 = pdfBase64.replace(/^data:application\/pdf;base64,/, '');
                finalBuffer = Buffer.from(cleanBase64, 'base64');
            }

            if (!finalBuffer) {
                try {
                    finalBuffer = await generateInvoicePdfBuffer({ invoice, company });
                } catch (pdfErr) {
                    console.warn('[EmailService] Failed to generate automatic PDF buffer:', pdfErr.message);
                }
            }

            if (finalBuffer) {
                mailOptions.attachments = [
                    {
                        filename: `Invoice_${invoiceNumber}.pdf`,
                        content: finalBuffer,
                        contentType: 'application/pdf'
                    }
                ];
            }
        }

        const info = await executeWithTimeout(transporter.sendMail(mailOptions), 8000, 'Sending invoice email');
        console.log(`[EmailService] Invoice #${invoiceNumber} sent to ${recipientEmail} via ${smtpSettings.host}. MessageId: ${info.messageId}`);

        return {
            success: true,
            messageId: info.messageId,
            recipient: recipientEmail,
            isSimulated: false
        };
    } finally {
        try { transporter.close(); } catch (e) {}
    }
};

module.exports = {
    createCompanyTransporter,
    verifySmtpConnection,
    sendSmtpTestEmail,
    sendInvoiceEmail,
    generateInvoiceEmailHtml
};
