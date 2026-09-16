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
            const rawThemeColor = company?.invoiceColor || '#dedede';
            const isLightColor = (color) => {
                if (!color) return true;
                const c = color.toLowerCase().trim();
                if (c === '#dedede' || c === '#ffffff' || c === '#f1f5f9' || c === '#e2e8f0') return true;
                const hex = c.replace('#', '');
                if (hex.length !== 6) return false;
                const r = parseInt(hex.substring(0, 2), 16) / 255;
                const g = parseInt(hex.substring(2, 4), 16) / 255;
                const b = parseInt(hex.substring(4, 6), 16) / 255;
                const toLinear = v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
                const lum = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
                return lum > 0.5;
            };
            const isLight = isLightColor(rawThemeColor);
            const themeColor = rawThemeColor;
            const bannerBgColor = isLight ? '#dedede' : themeColor;
            const bannerTitleColor = isLight ? '#1e293b' : '#ffffff';
            const bannerSubColor = isLight ? '#475569' : '#cbd5e1';
            const bannerMetaColor = isLight ? '#475569' : '#e2e8f0';
            const tableHeaderBg = isLight ? '#dedede' : themeColor;
            const tableHeaderText = isLight ? '#555555' : '#ffffff';
            const sectionTitleColor = isLight ? '#1e293b' : themeColor;
            const docTitle = company?.isVatRegistered ? 'VAT INVOICE' : 'INVOICE';
            const poVal = (invoice?.poNumber && typeof invoice.poNumber === 'string' && invoice.poNumber.trim()) ? invoice.poNumber.trim() : null;

            // Header Background Accent (Light Grey / Company theme)
            doc.rect(40, 40, 515, 65).fill(bannerBgColor);

            // Company Title
            doc.fillColor(bannerTitleColor)
                .fontSize(18)
                .font('Helvetica-Bold')
                .text(companyName, 55, 52);

            doc.fontSize(9)
                .font('Helvetica')
                .fillColor(bannerMetaColor)
                .text(`VAT/Tax No: ${company?.vatNumber || company?.gstNumber || 'N/A'}`, 55, 74)
                .text(`${company?.email || ''} | ${company?.phone || ''}`, 55, 87);

            // Invoice Title & Number
            doc.fillColor(bannerTitleColor)
                .fontSize(20)
                .font('Helvetica-Bold')
                .text(docTitle, 380, 52, { align: 'right', width: 160 })
                .fontSize(11)
                .fillColor(bannerSubColor)
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
            const isCombinedInv = Boolean(invoice?.isCombined || (typeof invoice?.id === 'string' && invoice.id.toLowerCase().includes('combined')) || (Array.isArray(invoice?.invoices) && invoice.invoices.length > 0));
            const currentInvId = !isNaN(parseInt(invoice?.id)) ? parseInt(invoice.id) : null;
            const totalNum = parseFloat(invoice?.totalAmount || 0);
            let paidNum = 0;
            if (isCombinedInv && Array.isArray(invoice?.invoices) && invoice.invoices.length > 0) {
                invoice.invoices.forEach(ci => {
                    if (Array.isArray(ci.allocations) && ci.allocations.length > 0) {
                        ci.allocations.forEach(a => { paidNum += (parseFloat(a.amount) || 0); });
                    } else if (ci.paidAmount !== undefined && ci.paidAmount !== null) {
                        paidNum += (parseFloat(ci.paidAmount) || 0);
                    }
                });
            } else if (Array.isArray(invoice?.allocations) && invoice.allocations.length > 0) {
                paidNum = invoice.allocations.reduce((sum, a) => {
                    if (!isCombinedInv && currentInvId && a.invoiceId && parseInt(a.invoiceId) !== currentInvId) return sum;
                    return sum + (parseFloat(a.amount) || 0);
                }, 0);
            } else if (invoice?.paidAmount !== undefined && invoice?.paidAmount !== null) {
                paidNum = parseFloat(invoice.paidAmount) || 0;
            } else if (Array.isArray(invoice?.receipt) && invoice.receipt.length > 0 && invoice.receipt.every(r => r.balanceAfterPayment !== undefined)) {
                paidNum = invoice.receipt.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
            }
            if (isNaN(paidNum)) paidNum = 0;

            const rawBalanceNum = invoice?.balanceAmount !== undefined ? parseFloat(invoice.balanceAmount) : (totalNum - paidNum);
            const tol = 0.01;
            const balanceNum = Math.max(0, isNaN(rawBalanceNum) ? Math.max(0, totalNum - paidNum) : rawBalanceNum);
            const effectiveBalance = balanceNum <= tol ? 0 : balanceNum;
            const isDuePassed = Boolean(invoice?.dueDate && new Date(invoice.dueDate).setHours(0, 0, 0, 0) < new Date().setHours(0, 0, 0, 0));
            const rawStatus = String(invoice?.status || '').toUpperCase();

            const computedStatus = (() => {
                if (rawStatus === 'CANCELLED') return 'CANCELLED';
                if (effectiveBalance <= tol && (totalNum > 0 || paidNum >= totalNum - tol)) return 'PAID';
                if (effectiveBalance <= tol && totalNum === 0) return 'PAID';
                if (paidNum > 0 && effectiveBalance > tol) return 'PARTIALLY PAID';
                if (effectiveBalance > tol && isDuePassed) return 'OVERDUE';
                if (rawStatus && rawStatus !== 'UNPAID' && rawStatus !== 'DUE' && rawStatus !== 'PARTIAL') return rawStatus;
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
                doc.rect(40, headerY, 515, 22).fill(tableHeaderBg);
                doc.fillColor(tableHeaderText).font('Helvetica-Bold').fontSize(8.5);
                doc.text('ACTIVITY', 45, headerY + 6, { width: 100, align: 'left' });
                doc.text('DESCRIPTION', 150, headerY + 6, { width: 140, align: 'left' });
                doc.text('QUANTITY', 295, headerY + 6, { width: 40, align: 'right' });
                doc.text('RATE', 340, headerY + 6, { width: 45, align: 'right' });
                doc.text('DISCOUNT', 390, headerY + 6, { width: 50, align: 'center' });
                doc.text('TAX', 445, headerY + 6, { width: 45, align: 'center' });
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
                    const actHeight = doc.heightOfString(actName || '', { width: 100, lineGap: 0 });

                    doc.font('Helvetica').fontSize(8);
                    const descHeight = descText ? doc.heightOfString(descText, { width: 140, lineGap: 1.5 }) : 0;

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

                    // Top-aligned content ensuring horizontal row baseline alignment
                    const actY = y + 6;
                    const numY = y + 6;
                    const descY = y + 6;

                    // Activity (wrapping inside column width 100)
                    doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(8.5).lineGap(0);
                    doc.text(actName, 45, actY, { width: 100, align: 'left', lineGap: 0 });

                    // Description (wrapping cleanly without truncation)
                    if (descText) {
                        doc.fillColor('#475569').font('Helvetica').fontSize(8).lineGap(1.5);
                        doc.text(descText, 150, descY, { width: 140, align: 'left', lineGap: 1.5 });
                    }

                    const discText = discVal > 0 ? (discType === 'percentage' ? `${discVal}%` : `-${discVal.toFixed(2)}`) : '0%';
                    const taxText = tax === 0 ? 'No VAT' : `${tax}%`;

                    // Numeric columns vertically aligned with row
                    doc.fillColor('#1e293b').font('Helvetica').fontSize(8.5).lineGap(0);
                    doc.text(qty.toString(), 295, numY, { width: 40, align: 'right', lineGap: 0 });
                    doc.text(rate.toFixed(2), 340, numY, { width: 45, align: 'right', lineGap: 0 });
                    doc.text(discText, 390, numY, { width: 50, align: 'center', lineGap: 0 });
                    doc.text(taxText, 445, numY, { width: 45, align: 'center', lineGap: 0 });
                    doc.text(`${currency} ${amount.toFixed(2)}`, 495, numY, { width: 55, align: 'right', lineGap: 0 });

                    // Clean row bottom border
                    doc.moveTo(40, y + rowHeight).lineTo(555, y + rowHeight).strokeColor('#e2e8f0').lineWidth(0.5).stroke();

                    y += rowHeight;
                });
            } else {
                doc.rect(40, y, 515, 20).fill('#ffffff');
                doc.fillColor('#1e293b').font('Helvetica').fontSize(9);
                doc.text(`Invoice #${invoiceNumber} Services / Products`, 45, y + 5, { width: 245, align: 'left' });
                doc.text('1', 295, y + 5, { width: 40, align: 'right' });
                const amt = parseFloat(invoice?.totalAmount || 0);
                doc.text(amt.toFixed(2), 340, y + 5, { width: 45, align: 'right' });
                doc.text('0%', 390, y + 5, { width: 50, align: 'center' });
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

            // ── Compute payment history FIRST so we can use it in the totals ──
            const invTotal = parseFloat(invoice?.totalAmount || 0);
            let rawAllocations = [];
            if (isCombinedInv && Array.isArray(invoice?.invoices) && invoice.invoices.length > 0) {
                invoice.invoices.forEach(ci => {
                    if (Array.isArray(ci.allocations) && ci.allocations.length > 0) {
                        ci.allocations.forEach(a => rawAllocations.push(a));
                    } else if (Array.isArray(ci.receipt) && ci.receipt.length > 0) {
                        ci.receipt.forEach(r => rawAllocations.push({
                            id: r.id, receiptId: r.id, amount: r.amount,
                            balanceBeforePayment: r.balanceBeforePayment,
                            balanceAfterPayment: r.balanceAfterPayment, receipt: r
                        }));
                    }
                });
            }
            if (Array.isArray(invoice?.allocations) && invoice.allocations.length > 0) {
                const currentInvId2 = !isNaN(parseInt(invoice.id)) ? parseInt(invoice.id) : null;
                invoice.allocations.forEach(a => {
                    if (!isCombinedInv && currentInvId2 && a.invoiceId && a.invoiceId !== currentInvId2) return;
                    rawAllocations.push(a);
                });
            } else if (rawAllocations.length === 0 && Array.isArray(invoice?.receipt) && invoice.receipt.length > 0) {
                invoice.receipt.forEach(r => {
                    if (r.balanceAfterPayment !== undefined || (!isCombinedInv && currentInvId && r.invoiceId && parseInt(r.invoiceId) === currentInvId)) {
                        rawAllocations.push({
                            id: r.id, receiptId: r.id, amount: r.amount,
                            balanceBeforePayment: r.balanceBeforePayment,
                            balanceAfterPayment: r.balanceAfterPayment, receipt: r
                        });
                    }
                });
            }
            const pmtGroupMap = new Map();
            rawAllocations.forEach(item => {
                const r = item.receipt || item;
                const key = r.receiptNumber && r.receiptNumber !== '-' ? r.receiptNumber : (r.id ? `ID-${r.id}` : `ITEM-${item.id || Math.random()}`);
                if (!pmtGroupMap.has(key)) {
                    pmtGroupMap.set(key, {
                        id: r.id || item.receiptId,
                        receiptNumber: r.receiptNumber || (item.receiptId ? `RCV-${item.receiptId}` : '-'),
                        date: r.date || item.createdAt,
                        amount: 0,
                        paymentMode: r.paymentMode || item.paymentMode || 'BANK',
                        balanceAfterPayment: item.balanceAfterPayment
                    });
                }
                const entry = pmtGroupMap.get(key);
                entry.amount = parseFloat((entry.amount + (parseFloat(item.amount) || 0)).toFixed(2));
                if (!entry.date && (r.date || item.createdAt)) entry.date = r.date || item.createdAt;
            });
            const sortedHistory = Array.from(pmtGroupMap.values()).sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
            let rPaid = 0;
            const finalPaymentHistory = sortedHistory.map(p => {
                rPaid = parseFloat((rPaid + p.amount).toFixed(2));
                const calcBal = Math.max(0, parseFloat((invTotal - rPaid).toFixed(2)));
                let balAfter = calcBal;
                if (!isCombinedInv && p.balanceAfterPayment !== undefined && p.balanceAfterPayment !== null) {
                    balAfter = p.balanceAfterPayment;
                }
                return { ...p, balanceAfterPayment: balAfter };
            });

            // Summary Totals Box (Right aligned)
            const subtotalVal = parseFloat(invoice?.subtotal || subtotal || 0);
            const discountVal = parseFloat(invoice?.discountAmount || 0);
            const taxableVal = Math.max(0, subtotalVal - discountVal);
            const taxVal = parseFloat(invoice?.taxAmount || 0);
            const total = parseFloat(invoice?.totalAmount || (taxableVal + taxVal) || 0).toFixed(2);
            const paid = parseFloat(paidNum).toFixed(2);
            const balance = parseFloat(effectiveBalance).toFixed(2);

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

            // ── Individual per-payment lines in the totals area ──
            if (finalPaymentHistory.length > 0) {
                finalPaymentHistory.forEach(p => {
                    const pmtD = p.date ? new Date(p.date) : null;
                    const pmtLabel = pmtD && !isNaN(pmtD.getTime())
                        ? `Payment on ${String(pmtD.getDate()).padStart(2, '0')}-${String(pmtD.getMonth() + 1).padStart(2, '0')}-${pmtD.getFullYear()}`
                        : (p.receiptNumber && p.receiptNumber !== '-' ? `Payment (${p.receiptNumber})` : 'Payment');
                    doc.fontSize(9).font('Helvetica').fillColor('#2563eb').text(pmtLabel, totalsX, y);
                    doc.fillColor('#16a34a').text(`-${currency} ${Number(p.amount || 0).toFixed(2)}`, 440, y, { align: 'right', width: 115 });
                    y += 16;
                });
            } else if (parseFloat(paid) > 0) {
                doc.fontSize(9).font('Helvetica-Bold').fillColor('#64748b').text('Paid to Date:', totalsX, y);
                doc.font('Helvetica').fillColor('#16a34a').text(`-${currency} ${paid}`, 440, y, { align: 'right', width: 115 });
                y += 16;
            }

            // Total Amount Highlight (themeColor / light gray)
            doc.rect(totalsX - 10, y - 2, 235, 26).fill(bannerBgColor);
            doc.fillColor(bannerTitleColor).font('Helvetica-Bold').fontSize(11);
            doc.text('Grand Total:', totalsX, y + 6);
            doc.text(`${currency} ${total}`, 440, y + 6, { align: 'right', width: 115 });
            y += 34;

            // Balance Due Line
            doc.fillColor('#475569').font('Helvetica-Bold').fontSize(9.5);
            doc.text('BALANCE DUE:', totalsX, y);
            doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10);
            doc.text(`${currency} ${balance}`, 440, y, { align: 'right', width: 115 });
            y += 15;

            // Clean unboxed status text directly right-aligned under balance
            const isStatusPaid = computedStatus === 'PAID' || computedStatus === 'COMPLETED';
            const statusColor = isStatusPaid ? '#16a34a' : (computedStatus === 'OVERDUE' ? '#dc2626' : (computedStatus === 'PARTIALLY PAID' || computedStatus === 'PARTIAL' ? '#ea580c' : '#64748b'));
            doc.fillColor(statusColor).font('Helvetica-Bold').fontSize(11);
            doc.text(computedStatus, 440, y, { align: 'right', width: 115 });
            y += 22;

            // Bank details (if available)
            if (company?.iban || company?.accountNumber) {
                if (y + 55 > 750) {
                    doc.addPage();
                    y = 50;
                }
                doc.rect(40, y, 515, 50).fill('#f8fafc').strokeColor('#cbd5e1').stroke();
                doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(8.5).text('PAYMENT / BANK TRANSFER DETAILS', 50, y + 6);
                doc.font('Helvetica').fontSize(7.5).fillColor('#475569');
                let bankInfo = `Bank: ${company?.bankName || 'N/A'}   |   Account Name: ${company?.accountName || companyName}\n`;
                if (company?.iban) bankInfo += `IBAN: ${company.iban}   |   `;
                if (company?.bic) bankInfo += `BIC/SWIFT: ${company.bic}   |   `;
                if (company?.accountNumber) bankInfo += `Account No: ${company.accountNumber}   |   `;
                if (company?.sortCode) bankInfo += `Sort Code: ${company.sortCode}\n`;
                bankInfo += `Reference: ${invoiceNumber}`;
                doc.text(bankInfo, 50, y + 18, { width: 495, lineGap: 2 });
                y += 56;
            }

            /* // ── Payment History Table at bottom (commented out) ──
            if (finalPaymentHistory.length > 0) {
                const pmtEstHeight = 35 + (finalPaymentHistory.length * 16);
                if (y + pmtEstHeight > 750) {
                    doc.addPage();
                    y = 50;
                } else {
                    y += 6;
                }

                doc.fontSize(8.5).font('Helvetica-Bold').fillColor(sectionTitleColor).text('PAYMENT HISTORY', 40, y);
                y += 12;

                doc.rect(40, y, 515, 18).fill(tableHeaderBg);
                doc.fillColor(tableHeaderText).font('Helvetica-Bold').fontSize(7.5);
                doc.text('Payment Date', 45, y + 5, { width: 90, align: 'left' });
                doc.text('Receipt Number', 140, y + 5, { width: 100, align: 'left' });
                doc.text('Payment Amount', 245, y + 5, { width: 85, align: 'right' });
                doc.text('Payment Method', 335, y + 5, { width: 75, align: 'center' });
                doc.text('Balance After Payment', 415, y + 5, { width: 135, align: 'right' });
                y += 18;

                finalPaymentHistory.forEach((p, pIdx) => {
                    if (y + 16 > 750) {
                        doc.addPage();
                        y = 50;
                        doc.rect(40, y, 515, 18).fill(tableHeaderBg);
                        doc.fillColor(tableHeaderText).font('Helvetica-Bold').fontSize(7.5);
                        doc.text('Payment Date', 45, y + 5, { width: 90, align: 'left' });
                        doc.text('Receipt Number', 140, y + 5, { width: 100, align: 'left' });
                        doc.text('Payment Amount', 245, y + 5, { width: 85, align: 'right' });
                        doc.text('Payment Method', 335, y + 5, { width: 75, align: 'center' });
                        doc.text('Balance After Payment', 415, y + 5, { width: 135, align: 'right' });
                        y += 18;
                    }

                    const pRowBg = pIdx % 2 === 0 ? '#ffffff' : '#f8fafc';
                    doc.rect(40, y, 515, 16).fill(pRowBg);

                    const d = p.date ? new Date(p.date) : null;
                    const dateStr = d && !isNaN(d.getTime())
                        ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
                        : '-';
                    const amtStr = `${currency} ${Number(p.amount || 0).toFixed(2)}`;
                    const balAfterStr = (p.balanceAfterPayment !== undefined && p.balanceAfterPayment !== null)
                        ? `${currency} ${Number(p.balanceAfterPayment).toFixed(2)}`
                        : '-';

                    doc.fillColor('#334155').font('Helvetica').fontSize(7.5);
                    doc.text(dateStr, 45, y + 4, { width: 90, align: 'left' });
                    doc.font('Helvetica-Bold').fillColor('#0f172a').text(p.receiptNumber || '-', 140, y + 4, { width: 100, align: 'left' });
                    doc.text(amtStr, 245, y + 4, { width: 85, align: 'right' });
                    doc.font('Helvetica').fillColor('#475569').text((p.paymentMode || 'BANK').toUpperCase(), 335, y + 4, { width: 75, align: 'center' });
                    doc.font('Helvetica-Bold').fillColor('#0f172a').text(balAfterStr, 415, y + 4, { width: 135, align: 'right' });

                    doc.moveTo(40, y + 16).lineTo(555, y + 16).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
                    y += 16;
                });
            }
            */

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
