const PDFDocument = require('pdfkit');

/**
 * Generate a clean, professional Invoice PDF Buffer
 * @param {Object} options
 * @param {Object} options.invoice
 * @param {Object} options.company
 * @returns {Promise<Buffer>}
 */
const generateInvoicePdfBuffer = ({ invoice, company }) => {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 40, size: 'A4' });
            const buffers = [];

            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                const pdfData = Buffer.concat(buffers);
                resolve(pdfData);
            });

            const companyName = company?.name || 'Tab Accounts';
            const invoiceNumber = invoice?.invoiceNumber || `INV-${invoice?.id}`;
            const currency = invoice?.currency || company?.currency || 'EUR';
            const issueDate = invoice?.date ? new Date(invoice.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
            const dueDate = invoice?.dueDate ? new Date(invoice.dueDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Due upon receipt';
            const customerName = invoice?.customer?.name || invoice?.customerName || 'Valued Customer';
            const customerEmail = invoice?.customer?.email || invoice?.customerEmail || '';

            // Header Background Accent
            doc.rect(40, 40, 515, 65).fill('#1e293b');

            // Company Title
            doc.fillColor('#ffffff')
                .fontSize(18)
                .font('Helvetica-Bold')
                .text(companyName, 55, 52);

            doc.fontSize(9)
                .font('Helvetica')
                .fillColor('#cbd5e1')
                .text(`VAT/Tax No: ${company?.vatNumber || company?.gstNumber || 'N/A'}`, 55, 74)
                .text(`${company?.email || ''} | ${company?.phone || ''}`, 55, 87);

            // Invoice Title & Number
            doc.fillColor('#ffffff')
                .fontSize(20)
                .font('Helvetica-Bold')
                .text('INVOICE', 380, 52, { align: 'right', width: 160 })
                .fontSize(11)
                .fillColor('#93c5fd')
                .text(`#${invoiceNumber}`, 380, 75, { align: 'right', width: 160 });

            // Billing & Invoice Metadata
            let y = 125;
            doc.fillColor('#0f172a');

            // Left side: Bill To
            doc.fontSize(10).font('Helvetica-Bold').fillColor('#64748b').text('BILLED TO:', 45, y);
            doc.fontSize(12).font('Helvetica-Bold').fillColor('#0f172a').text(customerName, 45, y + 14);
            if (customerEmail) {
                doc.fontSize(9).font('Helvetica').fillColor('#475569').text(customerEmail, 45, y + 30);
            }

            // Right side: Dates & Status
            doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b')
                .text('Issue Date:', 350, y)
                .text('Due Date:', 350, y + 15)
                .text('Status:', 350, y + 30);

            doc.font('Helvetica').fillColor('#0f172a')
                .text(issueDate, 440, y, { align: 'right', width: 115 })
                .text(dueDate, 440, y + 15, { align: 'right', width: 115 })
                .font('Helvetica-Bold').fillColor(invoice?.status === 'PAID' ? '#16a34a' : '#ea580c')
                .text(invoice?.status || 'UNPAID', 440, y + 30, { align: 'right', width: 115 });

            // Table Header
            y = 190;
            doc.rect(40, y, 515, 24).fill('#f1f5f9');
            doc.fillColor('#334155').font('Helvetica-Bold').fontSize(9);
            doc.text('ITEM / DESCRIPTION', 50, y + 7);
            doc.text('QTY', 310, y + 7, { align: 'right', width: 40 });
            doc.text('RATE', 360, y + 7, { align: 'right', width: 60 });
            doc.text('TAX', 430, y + 7, { align: 'right', width: 40 });
            doc.text('AMOUNT', 480, y + 7, { align: 'right', width: 65 });

            // Table Rows
            y += 24;
            const items = invoice?.invoiceitem || invoice?.items || [];
            let subtotal = 0;

            if (items.length > 0) {
                items.forEach((item, idx) => {
                    const itemName = item.product?.name || item.name || item.description || `Item #${idx + 1}`;
                    const qty = parseFloat(item.quantity || 1);
                    const rate = parseFloat(item.rate || item.price || 0);
                    const tax = parseFloat(item.taxRate || item.tax || 0);
                    const amount = parseFloat(item.amount || (qty * rate));
                    subtotal += amount;

                    const rowBg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
                    doc.rect(40, y, 515, 20).fill(rowBg);

                    doc.fillColor('#1e293b').font('Helvetica').fontSize(9);
                    doc.text(itemName.substring(0, 45), 50, y + 5);
                    doc.text(qty.toString(), 310, y + 5, { align: 'right', width: 40 });
                    doc.text(rate.toFixed(2), 360, y + 5, { align: 'right', width: 60 });
                    doc.text(`${tax}%`, 430, y + 5, { align: 'right', width: 40 });
                    doc.text(`${currency} ${amount.toFixed(2)}`, 480, y + 5, { align: 'right', width: 65 });

                    y += 20;
                });
            } else {
                doc.rect(40, y, 515, 20).fill('#ffffff');
                doc.fillColor('#1e293b').font('Helvetica').fontSize(9);
                doc.text(`Invoice #${invoiceNumber} Services / Products`, 50, y + 5);
                doc.text('1', 310, y + 5, { align: 'right', width: 40 });
                const amt = parseFloat(invoice?.totalAmount || 0);
                doc.text(amt.toFixed(2), 360, y + 5, { align: 'right', width: 60 });
                doc.text('0%', 430, y + 5, { align: 'right', width: 40 });
                doc.text(`${currency} ${amt.toFixed(2)}`, 480, y + 5, { align: 'right', width: 65 });
                y += 20;
            }

            // Line separator
            doc.moveTo(40, y).lineTo(555, y).strokeColor('#cbd5e1').stroke();
            y += 15;

            // Summary Totals Box (Right aligned)
            const subtotalVal = parseFloat(invoice?.subtotal || subtotal || 0);
            const discountVal = parseFloat(invoice?.discountAmount || 0);
            const taxableVal = Math.max(0, subtotalVal - discountVal);
            const taxVal = parseFloat(invoice?.taxAmount || 0);
            const total = parseFloat(invoice?.totalAmount || (taxableVal + taxVal) || 0).toFixed(2);
            const paid = parseFloat(invoice?.paidAmount || 0).toFixed(2);
            const balance = parseFloat(invoice?.balanceAmount !== undefined ? invoice.balanceAmount : (parseFloat(total) - parseFloat(paid))).toFixed(2);

            const totalsX = 330;
            doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text('Subtotal:', totalsX, y);
            doc.font('Helvetica').fillColor('#0f172a').text(`${currency} ${subtotalVal.toFixed(2)}`, 440, y, { align: 'right', width: 115 });
            y += 16;

            if (discountVal > 0) {
                doc.fontSize(9).font('Helvetica-Bold').fillColor('#dc2626').text('Discount:', totalsX, y);
                doc.font('Helvetica').fillColor('#dc2626').text(`-${currency} ${discountVal.toFixed(2)}`, 440, y, { align: 'right', width: 115 });
                y += 16;

                doc.fontSize(9).font('Helvetica-Bold').fillColor('#475569').text('Taxable Amount:', totalsX, y);
                doc.font('Helvetica').fillColor('#0f172a').text(`${currency} ${taxableVal.toFixed(2)}`, 440, y, { align: 'right', width: 115 });
                y += 16;
            }

            if (taxVal > 0) {
                doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text('Tax (VAT):', totalsX, y);
                doc.font('Helvetica').fillColor('#0f172a').text(`+${currency} ${taxVal.toFixed(2)}`, 440, y, { align: 'right', width: 115 });
                y += 16;
            }

            if (parseFloat(paid) > 0) {
                doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text('Paid to Date:', totalsX, y);
                doc.font('Helvetica').fillColor('#16a34a').text(`-${currency} ${paid}`, 440, y, { align: 'right', width: 115 });
                y += 16;
            }

            // Total Amount Highlight
            doc.rect(totalsX - 10, y - 2, 235, 26).fill('#1e293b');
            doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11);
            doc.text('TOTAL AMOUNT:', totalsX, y + 6);
            doc.text(`${currency} ${total}`, 440, y + 6, { align: 'right', width: 115 });
            y += 34;

            if (parseFloat(balance) > 0 && parseFloat(balance) !== parseFloat(total)) {
                doc.fillColor('#dc2626').font('Helvetica-Bold').fontSize(10);
                doc.text('BALANCE DUE:', totalsX, y);
                doc.text(`${currency} ${balance}`, 440, y, { align: 'right', width: 115 });
                y += 20;
            }

            // Bank details (if available)
            if (company?.iban || company?.accountNumber) {
                y = Math.max(y, 480);
                doc.rect(40, y, 515, 60).fill('#f8fafc').strokeColor('#cbd5e1').stroke();
                doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(9).text('PAYMENT / BANK TRANSFER DETAILS', 50, y + 8);
                doc.font('Helvetica').fontSize(8).fillColor('#475569');
                let bankInfo = `Bank: ${company?.bankName || 'N/A'}   |   Account Name: ${company?.accountName || companyName}\n`;
                if (company?.iban) bankInfo += `IBAN: ${company.iban}   |   `;
                if (company?.bic) bankInfo += `BIC/SWIFT: ${company.bic}   |   `;
                if (company?.accountNumber) bankInfo += `Account No: ${company.accountNumber}   |   `;
                if (company?.sortCode) bankInfo += `Sort Code: ${company.sortCode}\n`;
                bankInfo += `Reference: ${invoiceNumber}`;
                doc.text(bankInfo, 50, y + 22, { width: 495, lineGap: 3 });
            }

            // Footer
            doc.fontSize(8).fillColor('#94a3b8').font('Helvetica')
                .text(`Thank you for your business! - ${companyName}`, 40, 780, { align: 'center', width: 515 });

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
};

module.exports = {
    generateInvoicePdfBuffer
};
