const { logActivity } = require('./auditLogger');

/**
 * Helper to safely format numbers or return string representation
 */
const fmtNum = (val) => {
    if (val === null || val === undefined || isNaN(val)) return '0';
    return Number(val).toFixed(2).replace(/\.00$/, '');
};

/**
 * Safely format ISO dates to YYYY-MM-DD
 */
const fmtDate = (val) => {
    if (!val) return 'N/A';
    try {
        const d = new Date(val);
        return isNaN(d.getTime()) ? String(val) : d.toISOString().split('T')[0];
    } catch {
        return String(val);
    }
};

/**
 * 1. Log Invoice Created
 */
const logInvoiceCreated = (req, invoice, items = []) => {
    try {
        const summary = `Invoice #${invoice.invoiceNumber} created with total ${fmtNum(invoice.totalAmount)} (${items.length} item${items.length === 1 ? '' : 's'})`;

        const details = {
            invoiceNumber: invoice.invoiceNumber,
            invoiceId: invoice.id,
            action: 'CREATE',
            summary,
            changes: [
                { field: 'invoiceNumber', fieldLabel: 'Invoice Number', previousValue: null, newValue: invoice.invoiceNumber },
                { field: 'customerId', fieldLabel: 'Customer ID', previousValue: null, newValue: invoice.customerId },
                { field: 'date', fieldLabel: 'Invoice Date', previousValue: null, newValue: fmtDate(invoice.date) },
                { field: 'dueDate', fieldLabel: 'Due Date', previousValue: null, newValue: fmtDate(invoice.dueDate) },
                { field: 'subtotal', fieldLabel: 'Subtotal', previousValue: null, newValue: fmtNum(invoice.subtotal) },
                { field: 'discountAmount', fieldLabel: 'Discount Amount', previousValue: null, newValue: fmtNum(invoice.discountAmount) },
                { field: 'taxAmount', fieldLabel: 'VAT / Tax Amount', previousValue: null, newValue: fmtNum(invoice.taxAmount) },
                { field: 'totalAmount', fieldLabel: 'Total Amount', previousValue: null, newValue: fmtNum(invoice.totalAmount) },
                { field: 'status', fieldLabel: 'Status', previousValue: null, newValue: invoice.status || 'UNPAID' }
            ],
            previousValue: null,
            newValue: {
                invoiceNumber: invoice.invoiceNumber,
                customerId: invoice.customerId,
                date: fmtDate(invoice.date),
                dueDate: fmtDate(invoice.dueDate),
                subtotal: invoice.subtotal,
                discountAmount: invoice.discountAmount,
                taxAmount: invoice.taxAmount,
                totalAmount: invoice.totalAmount,
                status: invoice.status,
                items: items.map(i => ({
                    description: i.description || 'Sales Item',
                    quantity: parseFloat(i.quantity) || 0,
                    rate: parseFloat(i.rate) || 0,
                    discount: parseFloat(i.discount) || 0,
                    taxRate: parseFloat(i.taxRate) || 0,
                    amount: parseFloat(i.amount) || 0
                }))
            }
        };

        logActivity(req, 'CREATE', 'Invoice', invoice.id, details);
    } catch (err) {
        console.error('[InvoiceAudit Error] Failed to log invoice creation:', err.message);
    }
};

/**
 * 2. Log Invoice Edited (Detailed field diff including lines, customer, discount, tax, due date)
 */
const logInvoiceUpdated = (req, oldInvoice, newInvoice, newItems = []) => {
    try {
        if (!oldInvoice || !newInvoice) return;

        const changes = [];
        const changedFieldNames = [];

        // 1. Customer changed
        if (oldInvoice.customerId !== newInvoice.customerId) {
            changes.push({
                field: 'customerId',
                fieldLabel: 'Customer',
                previousValue: `Customer ID ${oldInvoice.customerId}`,
                newValue: `Customer ID ${newInvoice.customerId}`
            });
            changedFieldNames.push('Customer');
        }

        // 2. Due date changed
        if (fmtDate(oldInvoice.dueDate) !== fmtDate(newInvoice.dueDate)) {
            changes.push({
                field: 'dueDate',
                fieldLabel: 'Due Date',
                previousValue: fmtDate(oldInvoice.dueDate),
                newValue: fmtDate(newInvoice.dueDate)
            });
            changedFieldNames.push('Due Date');
        }

        // 3. Invoice date changed
        if (fmtDate(oldInvoice.date) !== fmtDate(newInvoice.date)) {
            changes.push({
                field: 'date',
                fieldLabel: 'Invoice Date',
                previousValue: fmtDate(oldInvoice.date),
                newValue: fmtDate(newInvoice.date)
            });
            changedFieldNames.push('Invoice Date');
        }

        // 4. Status changed
        if (oldInvoice.status !== newInvoice.status) {
            changes.push({
                field: 'status',
                fieldLabel: 'Status',
                previousValue: oldInvoice.status,
                newValue: newInvoice.status
            });
            changedFieldNames.push('Status');
        }

        // 5. Discount changed
        const oldDisc = parseFloat(oldInvoice.discountAmount) || 0;
        const newDisc = parseFloat(newInvoice.discountAmount) || 0;
        const oldOverall = parseFloat(oldInvoice.overallDiscount) || 0;
        const newOverall = parseFloat(newInvoice.overallDiscount) || 0;
        if (Math.abs(oldDisc - newDisc) > 0.009 || Math.abs(oldOverall - newOverall) > 0.009) {
            changes.push({
                field: 'discountAmount',
                fieldLabel: 'Discount',
                previousValue: `${fmtNum(oldDisc)} (Overall: ${oldOverall}${oldInvoice.overallDiscountType === 'percentage' ? '%' : ''})`,
                newValue: `${fmtNum(newDisc)} (Overall: ${newOverall}${newInvoice.overallDiscountType === 'percentage' ? '%' : ''})`
            });
            changedFieldNames.push('Discount');
        }

        // 6. VAT/Tax changed
        const oldTax = parseFloat(oldInvoice.taxAmount) || 0;
        const newTax = parseFloat(newInvoice.taxAmount) || 0;
        if (Math.abs(oldTax - newTax) > 0.009) {
            changes.push({
                field: 'taxAmount',
                fieldLabel: 'VAT / Tax Amount',
                previousValue: fmtNum(oldTax),
                newValue: fmtNum(newTax)
            });
            changedFieldNames.push('VAT/Tax');
        }

        // 7. Subtotal changed
        const oldSub = parseFloat(oldInvoice.subtotal) || 0;
        const newSub = parseFloat(newInvoice.subtotal) || 0;
        if (Math.abs(oldSub - newSub) > 0.009) {
            changes.push({
                field: 'subtotal',
                fieldLabel: 'Subtotal',
                previousValue: fmtNum(oldSub),
                newValue: fmtNum(newSub)
            });
        }

        // 8. Total amount changed
        const oldTotal = parseFloat(oldInvoice.totalAmount) || 0;
        const newTotal = parseFloat(newInvoice.totalAmount) || 0;
        if (Math.abs(oldTotal - newTotal) > 0.009) {
            changes.push({
                field: 'totalAmount',
                fieldLabel: 'Total Amount',
                previousValue: fmtNum(oldTotal),
                newValue: fmtNum(newTotal)
            });
            changedFieldNames.push('Total Amount');
        }

        // 9. Line items changes comparison
        const oldItems = oldInvoice.invoiceitem || [];
        const normNewItems = newItems || [];

        // Match items by ID or by index/product/desc
        const matchedOldItemIds = new Set();

        normNewItems.forEach((newItem, idx) => {
            // Find existing counterpart
            let match = null;
            if (newItem.id) {
                match = oldItems.find(o => o.id === newItem.id);
            }
            if (!match && newItem.productId) {
                match = oldItems.find(o => o.productId === newItem.productId && !matchedOldItemIds.has(o.id));
            }
            if (!match && idx < oldItems.length && !matchedOldItemIds.has(oldItems[idx].id)) {
                match = oldItems[idx];
            }

            if (match) {
                matchedOldItemIds.add(match.id);
                const desc = newItem.description || match.description || `Item #${idx + 1}`;

                // Quantity changed
                const oldQty = parseFloat(match.quantity) || 0;
                const newQty = parseFloat(newItem.quantity) || 0;
                if (Math.abs(oldQty - newQty) > 0.0001) {
                    changes.push({
                        field: 'itemQuantity',
                        fieldLabel: `Quantity (${desc})`,
                        previousValue: fmtNum(oldQty),
                        newValue: fmtNum(newQty)
                    });
                    changedFieldNames.push(`Quantity (${desc})`);
                }

                // Rate changed
                const oldRate = parseFloat(match.rate) || 0;
                const newRate = parseFloat(newItem.rate) || 0;
                if (Math.abs(oldRate - newRate) > 0.009) {
                    changes.push({
                        field: 'itemRate',
                        fieldLabel: `Rate (${desc})`,
                        previousValue: fmtNum(oldRate),
                        newValue: fmtNum(newRate)
                    });
                    changedFieldNames.push(`Rate (${desc})`);
                }

                // Item Discount changed
                const oldItemDisc = parseFloat(match.discount) || 0;
                const newItemDisc = parseFloat(newItem.discount) || 0;
                if (Math.abs(oldItemDisc - newItemDisc) > 0.009) {
                    changes.push({
                        field: 'itemDiscount',
                        fieldLabel: `Discount (${desc})`,
                        previousValue: fmtNum(oldItemDisc),
                        newValue: fmtNum(newItemDisc)
                    });
                    changedFieldNames.push(`Discount (${desc})`);
                }

                // Item Tax Rate changed
                const oldTaxRate = parseFloat(match.taxRate) || 0;
                const newTaxRate = parseFloat(newItem.taxRate) || 0;
                if (Math.abs(oldTaxRate - newTaxRate) > 0.009) {
                    changes.push({
                        field: 'itemTaxRate',
                        fieldLabel: `Tax Rate (${desc})`,
                        previousValue: `${oldTaxRate}%`,
                        newValue: `${newTaxRate}%`
                    });
                    changedFieldNames.push(`Tax Rate (${desc})`);
                }
            } else {
                // Line item added
                const desc = newItem.description || `Item #${idx + 1}`;
                changes.push({
                    field: 'lineItemAdded',
                    fieldLabel: 'Line Item Added',
                    previousValue: null,
                    newValue: `${desc} (Qty: ${newItem.quantity}, Rate: ${newItem.rate}, Total: ${fmtNum(newItem.amount || 0)})`
                });
                changedFieldNames.push(`Line Item Added (${desc})`);
            }
        });

        // Check for removed items
        oldItems.forEach(oldItem => {
            if (!matchedOldItemIds.has(oldItem.id)) {
                const desc = oldItem.description || `Item #${oldItem.id}`;
                changes.push({
                    field: 'lineItemRemoved',
                    fieldLabel: 'Line Item Removed',
                    previousValue: `${desc} (Qty: ${oldItem.quantity}, Rate: ${oldItem.rate}, Total: ${fmtNum(oldItem.amount)})`,
                    newValue: null
                });
                changedFieldNames.push(`Line Item Removed (${desc})`);
            }
        });

        // Construct summary
        let summary = `Invoice #${newInvoice.invoiceNumber} updated`;
        if (changedFieldNames.length > 0) {
            summary += `: ${changedFieldNames.slice(0, 4).join(', ')}${changedFieldNames.length > 4 ? ` and ${changedFieldNames.length - 4} more change(s)` : ''}`;
        } else {
            summary += ` (General settings / header information saved)`;
        }

        const details = {
            invoiceNumber: newInvoice.invoiceNumber,
            invoiceId: newInvoice.id,
            action: 'UPDATE',
            summary,
            changedFields: changedFieldNames,
            changes,
            previousValue: {
                customerId: oldInvoice.customerId,
                dueDate: fmtDate(oldInvoice.dueDate),
                subtotal: oldInvoice.subtotal,
                discountAmount: oldInvoice.discountAmount,
                taxAmount: oldInvoice.taxAmount,
                totalAmount: oldInvoice.totalAmount,
                status: oldInvoice.status,
                itemsCount: oldItems.length
            },
            newValue: {
                customerId: newInvoice.customerId,
                dueDate: fmtDate(newInvoice.dueDate),
                subtotal: newInvoice.subtotal,
                discountAmount: newInvoice.discountAmount,
                taxAmount: newInvoice.taxAmount,
                totalAmount: newInvoice.totalAmount,
                status: newInvoice.status,
                itemsCount: normNewItems.length
            }
        };

        logActivity(req, 'UPDATE', 'Invoice', newInvoice.id, details);
    } catch (err) {
        console.error('[InvoiceAudit Error] Failed to log invoice update:', err.message);
    }
};

/**
 * 3. Log Invoice Deleted
 */
const logInvoiceDeleted = (req, invoice) => {
    try {
        const summary = `Invoice #${invoice.invoiceNumber} deleted (Customer ID: ${invoice.customerId}, Amount: ${fmtNum(invoice.totalAmount)}, Status: ${invoice.status})`;

        const details = {
            invoiceNumber: invoice.invoiceNumber,
            invoiceId: invoice.id,
            action: 'DELETE',
            summary,
            changes: [
                { field: 'recordState', fieldLabel: 'Invoice Record', previousValue: `Active #${invoice.invoiceNumber}`, newValue: 'DELETED' }
            ],
            previousValue: {
                id: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
                customerId: invoice.customerId,
                date: fmtDate(invoice.date),
                dueDate: fmtDate(invoice.dueDate),
                subtotal: invoice.subtotal,
                discountAmount: invoice.discountAmount,
                taxAmount: invoice.taxAmount,
                totalAmount: invoice.totalAmount,
                paidAmount: invoice.paidAmount,
                balanceAmount: invoice.balanceAmount,
                status: invoice.status,
                itemsCount: (invoice.invoiceitem || []).length
            },
            newValue: null
        };

        logActivity(req, 'DELETE', 'Invoice', invoice.id, details);
    } catch (err) {
        console.error('[InvoiceAudit Error] Failed to log invoice deletion:', err.message);
    }
};

/**
 * 4. Log Payment Added
 */
const logInvoicePaymentAdded = (req, invoice, paymentInfo) => {
    try {
        const paymentAmt = parseFloat(paymentInfo.amount) || 0;
        const oldPaid = parseFloat(paymentInfo.previousPaidAmount !== undefined ? paymentInfo.previousPaidAmount : (invoice.paidAmount || 0));
        const newPaid = oldPaid + paymentAmt;
        const total = parseFloat(invoice.totalAmount) || 0;
        const newBalance = Math.max(0, total - newPaid);
        const oldStatus = invoice.status || 'UNPAID';
        const newStatus = newBalance <= 0.01 ? 'PAID' : (newPaid > 0 ? 'PARTIAL' : 'UNPAID');

        const summary = `Payment of ${fmtNum(paymentAmt)} added to Invoice #${invoice.invoiceNumber} via ${paymentInfo.paymentMode || 'Receipt'} (${paymentInfo.receiptNumber ? `#${paymentInfo.receiptNumber}` : 'Payment'}). Paid: ${fmtNum(oldPaid)} → ${fmtNum(newPaid)}, Status: ${oldStatus} → ${newStatus}`;

        const details = {
            invoiceNumber: invoice.invoiceNumber,
            invoiceId: invoice.id,
            action: 'PAYMENT_ADD',
            receiptNumber: paymentInfo.receiptNumber || null,
            receiptId: paymentInfo.receiptId || null,
            summary,
            changes: [
                { field: 'paymentAdded', fieldLabel: 'Payment Added', previousValue: '0', newValue: fmtNum(paymentAmt) },
                { field: 'paidAmount', fieldLabel: 'Paid Amount', previousValue: fmtNum(oldPaid), newValue: fmtNum(newPaid) },
                { field: 'balanceAmount', fieldLabel: 'Balance Amount', previousValue: fmtNum(invoice.balanceAmount), newValue: fmtNum(newBalance) },
                { field: 'status', fieldLabel: 'Status', previousValue: oldStatus, newValue: newStatus }
            ],
            previousValue: {
                paidAmount: oldPaid,
                balanceAmount: invoice.balanceAmount,
                status: oldStatus
            },
            newValue: {
                paidAmount: newPaid,
                balanceAmount: newBalance,
                status: newStatus,
                allocatedPayment: paymentAmt,
                paymentMode: paymentInfo.paymentMode || 'Cash/Bank',
                receiptNumber: paymentInfo.receiptNumber
            }
        };

        logActivity(req, 'PAYMENT_ADD', 'Invoice', invoice.id, details);
    } catch (err) {
        console.error('[InvoiceAudit Error] Failed to log payment added:', err.message);
    }
};

/**
 * 5. Log Payment Changed / Allocation Updated
 */
const logInvoicePaymentUpdated = (req, invoice, oldAllocAmt, newAllocAmt, receiptInfo = {}) => {
    try {
        const oldAmt = parseFloat(oldAllocAmt) || 0;
        const newAmt = parseFloat(newAllocAmt) || 0;
        const delta = newAmt - oldAmt;

        const summary = `Payment on Invoice #${invoice.invoiceNumber} updated from ${fmtNum(oldAmt)} to ${fmtNum(newAmt)} via Receipt #${receiptInfo.receiptNumber || ''}`;

        const details = {
            invoiceNumber: invoice.invoiceNumber,
            invoiceId: invoice.id,
            action: 'PAYMENT_UPDATE',
            receiptNumber: receiptInfo.receiptNumber || null,
            summary,
            changes: [
                { field: 'allocatedAmount', fieldLabel: 'Payment Allocation', previousValue: fmtNum(oldAmt), newValue: fmtNum(newAmt) },
                { field: 'delta', fieldLabel: 'Payment Adjustment', previousValue: null, newValue: `${delta >= 0 ? '+' : ''}${fmtNum(delta)}` }
            ],
            previousValue: { allocatedAmount: oldAmt },
            newValue: { allocatedAmount: newAmt }
        };

        logActivity(req, 'PAYMENT_UPDATE', 'Invoice', invoice.id, details);
    } catch (err) {
        console.error('[InvoiceAudit Error] Failed to log payment updated:', err.message);
    }
};

/**
 * 6. Log Payment Removed (Unpay or Receipt Deleted)
 */
const logInvoicePaymentRemoved = (req, invoice, removedAmount, reason = 'Payment reverted') => {
    try {
        const amt = parseFloat(removedAmount) || 0;
        const oldPaid = parseFloat(invoice.paidAmount) || 0;
        const newPaid = Math.max(0, oldPaid - amt);
        const oldStatus = invoice.status || 'PAID';
        const newStatus = newPaid <= 0.01 ? 'UNPAID' : 'PARTIAL';

        const summary = `Payment of ${fmtNum(amt)} removed from Invoice #${invoice.invoiceNumber} (${reason}). Paid: ${fmtNum(oldPaid)} → ${fmtNum(newPaid)}, Status: ${oldStatus} → ${newStatus}`;

        const details = {
            invoiceNumber: invoice.invoiceNumber,
            invoiceId: invoice.id,
            action: 'PAYMENT_REMOVE',
            summary,
            changes: [
                { field: 'paymentRemoved', fieldLabel: 'Payment Removed', previousValue: fmtNum(amt), newValue: '0' },
                { field: 'paidAmount', fieldLabel: 'Paid Amount', previousValue: fmtNum(oldPaid), newValue: fmtNum(newPaid) },
                { field: 'status', fieldLabel: 'Status', previousValue: oldStatus, newValue: newStatus }
            ],
            previousValue: {
                paidAmount: oldPaid,
                balanceAmount: invoice.balanceAmount,
                status: oldStatus
            },
            newValue: {
                paidAmount: newPaid,
                balanceAmount: (invoice.totalAmount || 0) - newPaid,
                status: newStatus
            }
        };

        logActivity(req, 'PAYMENT_REMOVE', 'Invoice', invoice.id, details);
    } catch (err) {
        console.error('[InvoiceAudit Error] Failed to log payment removed:', err.message);
    }
};

/**
 * 7. Log Status Changed
 */
const logInvoiceStatusChanged = (req, invoice, oldStatus, newStatus) => {
    try {
        if (oldStatus === newStatus) return;

        const summary = `Invoice #${invoice.invoiceNumber} status changed from ${oldStatus} to ${newStatus}`;

        const details = {
            invoiceNumber: invoice.invoiceNumber,
            invoiceId: invoice.id,
            action: 'STATUS_CHANGE',
            summary,
            changes: [
                { field: 'status', fieldLabel: 'Status', previousValue: oldStatus, newValue: newStatus }
            ],
            previousValue: { status: oldStatus },
            newValue: { status: newStatus }
        };

        logActivity(req, 'STATUS_CHANGE', 'Invoice', invoice.id, details);
    } catch (err) {
        console.error('[InvoiceAudit Error] Failed to log status changed:', err.message);
    }
};

module.exports = {
    logInvoiceCreated,
    logInvoiceUpdated,
    logInvoiceDeleted,
    logInvoicePaymentAdded,
    logInvoicePaymentUpdated,
    logInvoicePaymentRemoved,
    logInvoiceStatusChanged
};
