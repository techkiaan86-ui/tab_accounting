const prisma = require('../config/prisma');

/**
 * =========================================================================
 * BITRIX24 CRM API ENGINE
 * =========================================================================
 */

const cleanBitrixUrl = (url) => {
    if (!url) return '';
    return url.trim().replace(/\/+$/, '');
};

const callBitrix = async (webhookUrl, method, data = {}) => {
    const baseUrl = cleanBitrixUrl(webhookUrl);
    if (!baseUrl) {
        throw new Error('Bitrix24 Inbound Webhook URL is missing');
    }
    const endpoint = `${baseUrl}/${method}.json`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });

    const result = await response.json();
    if (!response.ok || result.error) {
        const errMsg = result.error_description || result.error || `HTTP ${response.status} ${response.statusText}`;
        throw new Error(`Bitrix24 API Error (${method}): ${errMsg}`);
    }
    return result;
};

const testBitrixConnection = async (webhookUrl) => {
    const result = await callBitrix(webhookUrl, 'crm.contact.list', {
        select: ['ID'],
        start: 0
    });
    return {
        success: true,
        message: 'Successfully connected to Bitrix24 CRM portal!',
        contactCount: Array.isArray(result.result) ? result.result.length : (result.total || 0)
    };
};

const syncContactsToBitrix = async (webhookUrl, companyId) => {
    const customers = await prisma.customer.findMany({
        where: { companyId },
        orderBy: { id: 'asc' },
        take: 100 // Safe batch size
    });

    let created = 0;
    let updated = 0;
    let failed = 0;
    const errors = [];

    for (const customer of customers) {
        try {
            const fullName = (customer.name || customer.billingName || 'Customer').trim();
            const nameParts = fullName.split(' ');
            const firstName = nameParts[0] || 'Customer';
            const lastName = nameParts.slice(1).join(' ') || '';

            // Check if contact already exists by email or phone
            let existingId = null;
            if (customer.email) {
                const searchRes = await callBitrix(webhookUrl, 'crm.contact.list', {
                    filter: { '=EMAIL': customer.email },
                    select: ['ID']
                });
                if (Array.isArray(searchRes.result) && searchRes.result.length > 0) {
                    existingId = searchRes.result[0].ID;
                }
            }

            if (!existingId && customer.phone) {
                const searchRes = await callBitrix(webhookUrl, 'crm.contact.list', {
                    filter: { '=PHONE': customer.phone },
                    select: ['ID']
                });
                if (Array.isArray(searchRes.result) && searchRes.result.length > 0) {
                    existingId = searchRes.result[0].ID;
                }
            }

            const fields = {
                NAME: firstName,
                LAST_NAME: lastName,
                OPENED: 'Y',
                COMMENTS: `Imported from TAB Accounts (Customer ID: ${customer.id})`
            };

            if (customer.email) {
                fields.EMAIL = [{ VALUE: customer.email, VALUE_TYPE: 'WORK' }];
            }
            if (customer.phone) {
                fields.PHONE = [{ VALUE: customer.phone, VALUE_TYPE: 'WORK' }];
            }
            if (customer.billingAddress) fields.ADDRESS = customer.billingAddress;
            if (customer.billingCity) fields.ADDRESS_CITY = customer.billingCity;
            if (customer.billingCountry) fields.ADDRESS_COUNTRY = customer.billingCountry;

            if (existingId) {
                await callBitrix(webhookUrl, 'crm.contact.update', { id: existingId, fields });
                updated++;
            } else {
                await callBitrix(webhookUrl, 'crm.contact.add', { fields });
                created++;
            }
        } catch (err) {
            failed++;
            errors.push(`Customer ${customer.id} (${customer.name}): ${err.message}`);
        }
    }

    return { created, updated, failed, total: customers.length, errors: errors.slice(0, 5) };
};

const syncInvoicesToBitrix = async (webhookUrl, companyId) => {
    const invoices = await prisma.invoice.findMany({
        where: { companyId },
        include: { customer: true },
        orderBy: { id: 'desc' },
        take: 100
    });

    let created = 0;
    let updated = 0;
    let failed = 0;
    const errors = [];

    for (const inv of invoices) {
        try {
            const title = `Invoice #${inv.invoiceNumber} - ${inv.customer?.name || 'Customer'}`;
            const searchRes = await callBitrix(webhookUrl, 'crm.deal.list', {
                filter: { '%TITLE': inv.invoiceNumber },
                select: ['ID', 'TITLE']
            });

            let existingDealId = null;
            if (Array.isArray(searchRes.result) && searchRes.result.length > 0) {
                existingDealId = searchRes.result[0].ID;
            }

            const stageId = inv.status === 'PAID' ? 'WON' : (inv.status === 'PARTIALLY_PAID' ? 'EXECUTING' : 'NEW');
            const fields = {
                TITLE: title,
                OPPORTUNITY: inv.totalAmount,
                CURRENCY_ID: inv.currency || 'EUR',
                STAGE_ID: stageId,
                OPENED: 'Y',
                COMMENTS: `Invoice #${inv.invoiceNumber}. Total: ${inv.totalAmount} ${inv.currency || 'EUR'}, Balance: ${inv.balanceAmount}. Status: ${inv.status}.`
            };

            if (inv.date) {
                fields.BEGINDATE = new Date(inv.date).toISOString().split('T')[0];
            }
            if (inv.dueDate) {
                fields.CLOSEDATE = new Date(inv.dueDate).toISOString().split('T')[0];
            }

            if (existingDealId) {
                await callBitrix(webhookUrl, 'crm.deal.update', { id: existingDealId, fields });
                updated++;
            } else {
                await callBitrix(webhookUrl, 'crm.deal.add', { fields });
                created++;
            }
        } catch (err) {
            failed++;
            errors.push(`Invoice #${inv.invoiceNumber}: ${err.message}`);
        }
    }

    return { created, updated, failed, total: invoices.length, errors: errors.slice(0, 5) };
};

const pullContactsFromBitrix = async (webhookUrl, companyId) => {
    let imported = 0;
    try {
        const res = await callBitrix(webhookUrl, 'crm.contact.list', {
            select: ['ID', 'NAME', 'LAST_NAME', 'EMAIL', 'PHONE', 'ADDRESS', 'ADDRESS_CITY', 'ADDRESS_COUNTRY'],
            order: { 'ID': 'DESC' }
        });

        const contacts = Array.isArray(res.result) ? res.result : [];
        for (const contact of contacts) {
            const email = Array.isArray(contact.EMAIL) && contact.EMAIL.length > 0 ? contact.EMAIL[0].VALUE : null;
            const phone = Array.isArray(contact.PHONE) && contact.PHONE.length > 0 ? contact.PHONE[0].VALUE : null;
            const name = `${contact.NAME || ''} ${contact.LAST_NAME || ''}`.trim() || `Bitrix Contact #${contact.ID}`;

            if (email) {
                const exists = await prisma.customer.findFirst({
                    where: { companyId, email }
                });
                if (!exists) {
                    await prisma.customer.create({
                        data: {
                            name,
                            email,
                            phone,
                            billingName: name,
                            billingAddress: contact.ADDRESS || null,
                            billingCity: contact.ADDRESS_CITY || null,
                            billingCountry: contact.ADDRESS_COUNTRY || null,
                            companyId
                        }
                    });
                    imported++;
                }
            }
        }
    } catch (e) {
        console.warn('Pull contacts from Bitrix encountered non-fatal issue:', e.message);
    }
    return imported;
};

/**
 * =========================================================================
 * HUBSPOT CRM API v3 ENGINE
 * =========================================================================
 */

const callHubspot = async (accessToken, path, options = {}) => {
    const token = (accessToken || '').trim();
    if (!token) {
        throw new Error('HubSpot Private App Access Token is missing');
    }

    const url = `https://api.hubapi.com${path}`;
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };

    const response = await fetch(url, {
        ...options,
        headers
    });

    if (response.status === 204) return {};

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        const errMsg = result.message || `HTTP ${response.status} ${response.statusText}`;
        throw new Error(`HubSpot API Error: ${errMsg}`);
    }
    return result;
};

const testHubspotConnection = async (accessToken) => {
    const result = await callHubspot(accessToken, '/crm/v3/objects/contacts?limit=1');
    return {
        success: true,
        message: 'Successfully authenticated with HubSpot API CRM portal!',
        contactCount: result.results ? result.results.length : 0
    };
};

const syncContactsToHubSpot = async (accessToken, companyId) => {
    const customers = await prisma.customer.findMany({
        where: { companyId },
        orderBy: { id: 'asc' },
        take: 100
    });

    let created = 0;
    let updated = 0;
    let failed = 0;
    const errors = [];

    for (const customer of customers) {
        try {
            const fullName = (customer.name || customer.billingName || 'Customer').trim();
            const nameParts = fullName.split(' ');
            const firstName = nameParts[0] || 'Customer';
            const lastName = nameParts.slice(1).join(' ') || '';

            let contactId = null;
            if (customer.email) {
                // Search contact by email
                const searchRes = await callHubspot(accessToken, '/crm/v3/objects/contacts/search', {
                    method: 'POST',
                    body: JSON.stringify({
                        filterGroups: [{
                            filters: [{
                                propertyName: 'email',
                                operator: 'EQ',
                                value: customer.email
                            }]
                        }],
                        limit: 1
                    })
                }).catch(() => null);

                if (searchRes && searchRes.results && searchRes.results.length > 0) {
                    contactId = searchRes.results[0].id;
                }
            }

            const properties = {
                firstname: firstName,
                lastname: lastName,
                company: customer.billingName || customer.name || 'TAB Accounts Customer'
            };

            if (customer.email) properties.email = customer.email;
            if (customer.phone) properties.phone = customer.phone;
            if (customer.billingAddress) properties.address = customer.billingAddress;
            if (customer.billingCity) properties.city = customer.billingCity;
            if (customer.billingCountry) properties.country = customer.billingCountry;

            if (contactId) {
                await callHubspot(accessToken, `/crm/v3/objects/contacts/${contactId}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ properties })
                });
                updated++;
            } else {
                await callHubspot(accessToken, '/crm/v3/objects/contacts', {
                    method: 'POST',
                    body: JSON.stringify({ properties })
                });
                created++;
            }
        } catch (err) {
            failed++;
            errors.push(`Customer ${customer.id} (${customer.name}): ${err.message}`);
        }
    }

    return { created, updated, failed, total: customers.length, errors: errors.slice(0, 5) };
};

const syncInvoicesToHubSpot = async (accessToken, companyId) => {
    const invoices = await prisma.invoice.findMany({
        where: { companyId },
        include: { customer: true },
        orderBy: { id: 'desc' },
        take: 100
    });

    let created = 0;
    let updated = 0;
    let failed = 0;
    const errors = [];

    for (const inv of invoices) {
        try {
            const dealName = `Invoice #${inv.invoiceNumber} - ${inv.customer?.name || 'Customer'}`;

            // Check if deal already exists
            const searchRes = await callHubspot(accessToken, '/crm/v3/objects/deals/search', {
                method: 'POST',
                body: JSON.stringify({
                    filterGroups: [{
                        filters: [{
                            propertyName: 'dealname',
                            operator: 'CONTAINS_TOKEN',
                            value: inv.invoiceNumber
                        }]
                    }],
                    limit: 1
                })
            }).catch(() => null);

            let dealId = null;
            if (searchRes && searchRes.results && searchRes.results.length > 0) {
                dealId = searchRes.results[0].id;
            }

            const dealStage = inv.status === 'PAID' ? 'closedwon' : 'appointmentscheduled';
            const closeDate = inv.dueDate ? new Date(inv.dueDate).toISOString() : new Date(inv.date).toISOString();

            const properties = {
                dealname: dealName,
                amount: String(inv.totalAmount || 0),
                dealstage: dealStage,
                pipeline: 'default',
                closedate: closeDate,
                description: `Invoice #${inv.invoiceNumber}. Total: ${inv.totalAmount} ${inv.currency || 'USD'}, Balance: ${inv.balanceAmount}. Status: ${inv.status}.`
            };

            if (dealId) {
                await callHubspot(accessToken, `/crm/v3/objects/deals/${dealId}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ properties })
                });
                updated++;
            } else {
                await callHubspot(accessToken, '/crm/v3/objects/deals', {
                    method: 'POST',
                    body: JSON.stringify({ properties })
                });
                created++;
            }
        } catch (err) {
            failed++;
            errors.push(`Invoice #${inv.invoiceNumber}: ${err.message}`);
        }
    }

    return { created, updated, failed, total: invoices.length, errors: errors.slice(0, 5) };
};

const pullContactsFromHubSpot = async (accessToken, companyId) => {
    let imported = 0;
    try {
        const res = await callHubspot(
            accessToken,
            '/crm/v3/objects/contacts?limit=50&properties=email,firstname,lastname,phone,address,city,country,company'
        );

        const contacts = Array.isArray(res.results) ? res.results : [];
        for (const item of contacts) {
            const props = item.properties || {};
            const email = props.email;
            const name = `${props.firstname || ''} ${props.lastname || ''}`.trim() || props.company || `HubSpot Contact #${item.id}`;

            if (email) {
                const exists = await prisma.customer.findFirst({
                    where: { companyId, email }
                });
                if (!exists) {
                    await prisma.customer.create({
                        data: {
                            name,
                            email,
                            phone: props.phone || null,
                            billingName: props.company || name,
                            billingAddress: props.address || null,
                            billingCity: props.city || null,
                            billingCountry: props.country || null,
                            companyId
                        }
                    });
                    imported++;
                }
            }
        }
    } catch (e) {
        console.warn('Pull contacts from HubSpot encountered non-fatal issue:', e.message);
    }
    return imported;
};

module.exports = {
    // Bitrix24
    testBitrixConnection,
    syncContactsToBitrix,
    syncInvoicesToBitrix,
    pullContactsFromBitrix,
    // HubSpot
    testHubspotConnection,
    syncContactsToHubSpot,
    syncInvoicesToHubSpot,
    pullContactsFromHubSpot
};
