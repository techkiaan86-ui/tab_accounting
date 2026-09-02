const nodemailer = require('nodemailer');

/**
 * Configure Nodemailer Transporter
 */
const getTransporter = () => {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT) || 587;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;

    if (host && user && pass) {
        return nodemailer.createTransport({
            host,
            port,
            secure,
            auth: { user, pass },
            tls: {
                rejectUnauthorized: false
            }
        });
    }

    // Fallback: If no real SMTP is configured in .env, create JSON transport for simulation / development
    return nodemailer.createTransport({
        jsonTransport: true
    });
};

/**
 * Generate Responsive HTML Email Template for Invoices
 */
const generateInvoiceEmailHtml = ({ invoice, company, customMessage, publicUrl }) => {
    const companyName = company?.name || 'Tab Accounts';
    const vatNumber = company?.vatNumber || company?.gstNumber || '';
    const customerName = invoice?.customer?.name || 'Valued Customer';
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
                        ${invoice.balanceAmount > 0 && invoice.balanceAmount !== invoice.totalAmount ? `
                        <tr>
                            <td style="padding: 4px 0; color: #dc2626; font-size: 14px; font-weight: 800;">Balance Due:</td>
                            <td style="padding: 4px 0; text-align: right; color: #dc2626; font-size: 15px; font-weight: 800;">${currency} ${balanceAmount}</td>
                        </tr>` : ''}
                    </table>
                </div>

                ${publicUrl ? `
                <div class="cta-container">
                    <a href="${publicUrl}" class="btn-cta" target="_blank">View & Pay Invoice Online</a>
                </div>` : ''}

                ${hasBankDetails ? `
                <div class="bank-box">
                    <div class="bank-title">Payment & Bank Transfer Details</div>
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
 * Send Invoice Email via Nodemailer
 */
const sendInvoiceEmail = async ({ invoice, company, recipientEmail, subject, customMessage, publicUrl, attachPdf, pdfBuffer, bccEmail }) => {
    const transporter = getTransporter();

    const companyName = company?.name || 'Tab Accounts';
    const senderEmail = process.env.SMTP_FROM || company?.email || 'billing@tabaccounts.com';
    const fromAddress = `"${companyName}" <${senderEmail}>`;

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

    if (attachPdf && pdfBuffer) {
        mailOptions.attachments = [
            {
                filename: `Invoice_${invoiceNumber}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf'
            }
        ];
    }

    const info = await transporter.sendMail(mailOptions);
    console.log(`[EmailService] Invoice #${invoiceNumber} email dispatched to ${recipientEmail}. MessageId: ${info.messageId || 'simulation'}`);

    return {
        success: true,
        messageId: info.messageId,
        recipient: recipientEmail,
        isSimulated: !process.env.SMTP_HOST
    };
};

module.exports = {
    sendInvoiceEmail,
    generateInvoiceEmailHtml
};
