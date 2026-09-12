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
            const themeColor = company?.invoiceColor || '#475569';
            const docTitle = company?.isVatRegistered ? 'VAT INVOICE' : 'INVOICE';
            const poVal = (invoice?.poNumber && typeof invoice.poNumber === 'string' && invoice.poNumber.trim()) ? invoice.poNumber.trim() : null;

            // Header Background Accent (Light Grey / Company theme)
            doc.rect(40, 40, 515, 65).fill(themeColor);

            // Company Title
            doc.fillColor('#ffffff')
                .fontSize(18)
                .font('Helvetica-Bold')
                .text(companyName, 55, 52);

            doc.fontSize(9)
                .font('Helvetica')
                .fillColor('#e2e8f0')
                .text(`VAT/Tax No: ${company?.vatNumber || company?.gstNumber || 'N/A'}`, 55, 74)
                .text(`${company?.email || ''} | ${company?.phone || ''}`, 55, 87);

            // Invoice Title & Number
            doc.fillColor('#ffffff')
                .fontSize(20)
                .font('Helvetica-Bold')
                .text(docTitle, 380, 52, { align: 'right', width: 160 })
                .fontSize(11)
                .fillColor('#cbd5e1')
                .text(`#${String(invoiceNumber).replace(/^#/, '')}`, 380, 75, { align: 'right', width: 160 });

            // Billing & Invoice Metadata
            let y = 125;
            doc.fillColor('#0f172a');

            // Left side: Bill To
            doc.fontSize(10).font('Helvetica-Bold').fillColor('#64748b').text('BILLED TO:', 45, y);
            doc.fontSize(12).font('Helvetica-Bold').fillColor('#0f172a').text(customerName, 45, y + 14);
            if (customerEmail) {
                doc.fontSize(9).font('Helvetica').fillColor('#475569').text(customerEmail, 45, y + 30);
            }

            // Calculate dynamic status and balance
            const totalNum = parseFloat(invoice?.totalAmount || 0);
            let paidNum = parseFloat(invoice?.paidAmount || 0);
            if (isNaN(paidNum)) paidNum = 0;
            if (Array.isArray(invoice?.allocations) && invoice.allocations.length > 0) {
                const allocSum = invoice.allocations.reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);
                if (allocSum > paidNum) paidNum = allocSum;
            }
            const rawBalanceNum = invoice?.balanceAmount !== undefined ? parseFloat(invoice.balanceAmount) : (totalNum - paidNum);
            const tol = 0.01;
            const balanceNum = Math.max(0, isNaN(rawBalanceNum) ? Math.max(0, totalNum - paidNum) : rawBalanceNum);
            const effectiveBalance = balanceNum <= tol ? 0 : balanceNum;
            const isDuePassed = Boolean(invoice?.dueDate && new Date(invoice.dueDate).setHours(0, 0, 0, 0) < new Date().setHours(0, 0, 0, 0));
            const rawStatus = String(invoice?.status || '').toUpperCase();

            const computedStatus = (() => {
                if (rawStatus === 'CANCELLED') return 'CANCELLED';
                if (effectiveBalance <= tol && (totalNum > 0 || paidNum > 0)) return 'PAID';
                if (effectiveBalance <= tol && totalNum === 0) return 'PAID';
                if (rawStatus === 'PAID' && effectiveBalance <= tol) return 'PAID';
                if (effectiveBalance > tol && isDuePassed) return 'OVERDUE';
                if (paidNum > tol && effectiveBalance > tol) return 'PARTIAL';
                if (rawStatus && rawStatus !== 'UNPAID' && rawStatus !== 'DUE') return rawStatus;
                return 'UNPAID';
            })();

            // Right side: Metadata (Issue Date, P.O. # if present, Due Date, Status)
            let metaY = y;
            doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text('Issue Date:', 350, metaY);
            doc.font('Helvetica').fillColor('#0f172a').text(issueDate, 440, metaY, { align: 'right', width: 115 });
            metaY += 15;

            if (poVal) {
                doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text('P.O. #:', 350, metaY);
                doc.font('Helvetica').fillColor('#0f172a').text(poVal, 440, metaY, { align: 'right', width: 115 });
                metaY += 15;
            }

            doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text('Due Date:', 350, metaY);
            doc.font('Helvetica').fillColor('#0f172a').text(dueDate, 440, metaY, { align: 'right', width: 115 });
            metaY += 15;

            doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text('Status:', 350, metaY);
            doc.font('Helvetica-Bold').fillColor(computedStatus === 'PAID' ? '#16a34a' : (computedStatus === 'OVERDUE' ? '#dc2626' : '#ea580c'))
                .text(computedStatus, 440, metaY, { align: 'right', width: 115 });

            // Table Header Function
            const drawTableHeader = (headerY) => {
                doc.rect(40, headerY, 515, 22).fill('#f1f5f9');
                doc.fillColor('#334155').font('Helvetica-Bold').fontSize(8.5);
                doc.text('ACTIVITY', 45, headerY + 6, { width: 85, align: 'left' });
                doc.text('DESCRIPTION', 135, headerY + 6, { width: 170, align: 'left' });
                doc.text('QTY', 310, headerY + 6, { width: 30, align: 'right' });
                doc.text('RATE', 345, headerY + 6, { width: 45, align: 'right' });
                doc.text('DISCOUNT', 395, headerY + 6, { width: 45, align: 'right' });
                doc.text('VAT', 445, headerY + 6, { width: 45, align: 'center' });
                doc.text('PRICE', 495, headerY + 6, { width: 55, align: 'right' });
            };

            y = Math.max(195, metaY + 15);
            drawTableHeader(y);
            y += 22;

            // Table Rows
            const items = invoice?.invoiceitem || invoice?.items || [];
            let subtotal = 0;

            let cfObj = {};
            if (invoice?.customFields) {
                try {
                    cfObj = typeof invoice.customFields === 'string' ? JSON.parse(invoice.customFields) : invoice.customFields;
                } catch (e) {
                    cfObj = {};
                }
            }
            const itemsMeta = Array.isArray(cfObj?._itemsDiscountMeta) ? cfObj._itemsDiscountMeta : [];

            if (items.length > 0) {
                items.forEach((item, idx) => {
                    const meta = itemsMeta[idx];
                    const actName = meta?.itemName || item.service?.name || item.product?.name || item.name || item.activity || item.description || (item.serviceId ? 'Service' : 'Item');
                    const descText = item.description || meta?.description || '';

                    const qty = parseFloat(item.quantity !== undefined ? item.quantity : (item.qty || 1));
                    const rate = parseFloat(item.rate !== undefined ? item.rate : (item.price || 0));
                    const discType = meta?.discountType || item.discountType || (item.discount > 0 && item.discount <= 100 && (Math.abs((qty * rate * item.discount) / 100 - (item.discountAmount || 0)) < 0.01) ? 'percentage' : 'fixed');
                    const discVal = meta?.discount !== undefined ? meta.discount : (item.discountValue !== undefined ? item.discountValue : parseFloat(item.discount || 0));
                    const tax = parseFloat(item.taxRate !== undefined ? item.taxRate : (item.tax || 0));

                    const lineGross = qty * rate;
                    let itemDisc = 0;
                    if (discType === 'fixed' || discType === 'amount') {
                        itemDisc = Math.min(lineGross, Math.max(0, discVal));
                    } else {
                        itemDisc = (lineGross * Math.min(100, Math.max(0, discVal))) / 100;
                    }

                    const amount = (item.amount !== undefined && item.amount !== null && !isNaN(parseFloat(item.amount)))
                        ? parseFloat(item.amount)
                        : Math.max(0, lineGross - itemDisc);
                    subtotal += lineGross;

                    // Calculate required height based on wrapped text length
                    doc.font('Helvetica-Bold').fontSize(8.5);
                    const actHeight = doc.heightOfString(actName || '', { width: 85, lineGap: 0 });

                    doc.font('Helvetica').fontSize(8);
                    const descHeight = descText ? doc.heightOfString(descText, { width: 170, lineGap: 1.5 }) : 0;

                    const contentHeight = Math.max(actHeight, descHeight, 14);
                    const rowPadding = 12;
                    const rowHeight = contentHeight + rowPadding;

                    // Page break handling
                    if (y + rowHeight > 730) {
                        doc.addPage();
                        y = 50;
                        drawTableHeader(y);
                        y += 22;
                    }

                    const rowBg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
                    doc.rect(40, y, 515, rowHeight).fill(rowBg);

                    // Centering calculations for activity, description, and numeric columns
                    const actY = y + Math.max(6, (rowHeight - actHeight) / 2);
                    const numY = y + Math.max(6, (rowHeight - 10) / 2);
                    const descY = y + Math.max(6, (rowHeight - descHeight) / 2);

                    // Activity
                    doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(8.5).lineGap(0);
                    doc.text(actName, 45, actY, { width: 85, align: 'left', lineGap: 0 });

                    // Description (wrapping cleanly without truncation)
                    if (descText) {
                        doc.fillColor('#475569').font('Helvetica').fontSize(8).lineGap(1.5);
                        doc.text(descText, 135, descY, { width: 170, align: 'left', lineGap: 1.5 });
                    }

                    const discText = discVal > 0 ? (discType === 'percentage' ? `${discVal}%` : `-${discVal.toFixed(2)}`) : '0%';
                    const taxText = tax === 0 ? 'No VAT' : `${tax}%`;

                    // Numeric columns vertically aligned with row
                    doc.fillColor('#1e293b').font('Helvetica').fontSize(8.5).lineGap(0);
                    doc.text(qty.toString(), 310, numY, { width: 30, align: 'right', lineGap: 0 });
                    doc.text(rate.toFixed(2), 345, numY, { width: 45, align: 'right', lineGap: 0 });
                    doc.text(discText, 395, numY, { width: 45, align: 'right', lineGap: 0 });
                    doc.text(taxText, 445, numY, { width: 45, align: 'center', lineGap: 0 });
                    doc.text(`${currency} ${amount.toFixed(2)}`, 495, numY, { width: 55, align: 'right', lineGap: 0 });

                    // Clean row bottom border
                    doc.moveTo(40, y + rowHeight).lineTo(555, y + rowHeight).strokeColor('#e2e8f0').lineWidth(0.5).stroke();

                    y += rowHeight;
                });
            } else {
                doc.rect(40, y, 515, 20).fill('#ffffff');
                doc.fillColor('#1e293b').font('Helvetica').fontSize(9);
                doc.text(`Invoice #${invoiceNumber} Services / Products`, 45, y + 5, { width: 250, align: 'left' });
                doc.text('1', 310, y + 5, { width: 30, align: 'right' });
                const amt = parseFloat(invoice?.totalAmount || 0);
                doc.text(amt.toFixed(2), 345, y + 5, { width: 45, align: 'right' });
                doc.text('0%', 395, y + 5, { width: 45, align: 'right' });
                doc.text('No VAT', 445, y + 5, { width: 45, align: 'center' });
                doc.text(`${currency} ${amt.toFixed(2)}`, 495, y + 5, { width: 55, align: 'right' });
                y += 20;
            }

            // Check if page break is needed before Totals section
            if (y + 130 > 750) {
                doc.addPage();
                y = 50;
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

            doc.fontSize(9).font('Helvetica-Bold').fillColor(discountVal > 0 ? '#dc2626' : '#64748b').text('Discount:', totalsX, y);
            doc.font('Helvetica').fillColor(discountVal > 0 ? '#dc2626' : '#0f172a').text(discountVal > 0 ? `-${currency} ${discountVal.toFixed(2)}` : `${currency} 0.00`, 440, y, { align: 'right', width: 115 });
            y += 16;

            doc.fontSize(9).font('Helvetica-Bold').fillColor('#475569').text('Taxable Amount:', totalsX, y);
            doc.font('Helvetica').fillColor('#0f172a').text(`${currency} ${taxableVal.toFixed(2)}`, 440, y, { align: 'right', width: 115 });
            y += 16;

            doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text('VAT:', totalsX, y);
            doc.font('Helvetica').fillColor('#0f172a').text(`${currency} ${taxVal.toFixed(2)}`, 440, y, { align: 'right', width: 115 });
            y += 16;

            if (parseFloat(paid) > 0) {
                doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text('Paid to Date:', totalsX, y);
                doc.font('Helvetica').fillColor('#16a34a').text(`-${currency} ${paid}`, 440, y, { align: 'right', width: 115 });
                y += 16;
            }

            // Total Amount Highlight (themeColor)
            doc.rect(totalsX - 10, y - 2, 235, 26).fill(themeColor);
            doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11);
            doc.text('Grand Total:', totalsX, y + 6);
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
