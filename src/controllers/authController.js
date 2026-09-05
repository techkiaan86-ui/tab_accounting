const prisma = require('../config/prisma');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const register = async (req, res) => {
    try {
        const { name, email, password, role, companyId } = req.body;

        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ message: 'User already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const user = await prisma.user.create({
            data: {
                name,
                email,
                password: hashedPassword,
                role: role || 'USER', // Default to USER if not provided
                companyId: companyId ? parseInt(companyId) : undefined,
            },
        });

        res.status(201).json({ message: 'User created successfully', user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

const login = async (req, res) => {
    try {
        const { email, password } = req.body;
        const normalizedEmail = email.toLowerCase();

        const user = await prisma.user.findUnique({
            where: { email: normalizedEmail },
            include: {
                company: {
                    include: {
                        plan: true
                    }
                }
            }
        });
        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        if (user.loginEnabled === false) {
            return res.status(403).json({ message: 'Your account has been disabled. Please contact your administrator.' });
        }

        // Fetch all linked companies for this user via company_user
        let linkedCompanies = await prisma.company_user.findMany({
            where: { userId: user.id },
            include: {
                company: {
                    include: { plan: true }
                }
            },
            orderBy: { createdAt: 'asc' }
        });

        // If user has a companyId but no company_user record yet, auto-link
        if (user.companyId && !linkedCompanies.some(lc => lc.companyId === user.companyId)) {
            try {
                const autoLink = await prisma.company_user.create({
                    data: {
                        userId: user.id,
                        companyId: user.companyId,
                        role: user.role,
                        roleId: user.roleId
                    },
                    include: {
                        company: {
                            include: { plan: true }
                        }
                    }
                });
                linkedCompanies.push(autoLink);
            } catch (e) {
                console.error("Auto-link companyId error:", e);
            }
        }

        // Also check if any other company has matching email and not yet linked
        const matchingEmailCompanies = await prisma.company.findMany({
            where: {
                email: normalizedEmail,
                id: { notIn: linkedCompanies.map(lc => lc.companyId) }
            },
            include: { plan: true }
        });
        for (const mc of matchingEmailCompanies) {
            try {
                const autoLink = await prisma.company_user.create({
                    data: {
                        userId: user.id,
                        companyId: mc.id,
                        role: 'COMPANY'
                    },
                    include: {
                        company: {
                            include: { plan: true }
                        }
                    }
                });
                linkedCompanies.push(autoLink);
            } catch (e) {}
        }

        // Determine active company
        let activeCompanyId = user.companyId;
        let activeLink = linkedCompanies.find(lc => lc.companyId === activeCompanyId);
        if (!activeLink && linkedCompanies.length > 0) {
            activeLink = linkedCompanies[0];
            activeCompanyId = activeLink.companyId;
            try {
                await prisma.user.update({
                    where: { id: user.id },
                    data: { companyId: activeCompanyId }
                });
            } catch (e) {}
        }

        let activeCompany = activeLink?.company || user.company;
        let activeRole = activeLink ? activeLink.role : user.role;
        let activeRoleId = activeLink ? activeLink.roleId : user.roleId;

        // Check for company plan expiration
        if (activeRole !== 'SUPERADMIN' && activeCompany && activeCompany.endDate) {
            const expiryDate = new Date(activeCompany.endDate);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            if (expiryDate < today) {
                return res.status(403).json({ 
                    message: 'Your company plan has expired. Please contact super admin to renew your plan.',
                    isExpired: true 
                });
            }
        }

        let permissions = [];
        let planModules = [];

        try {
            // Fetch Role Permissions
            if (activeRole && activeRole !== 'SUPERADMIN' && activeCompanyId) {
                const whereClause = {
                    companyId: activeCompanyId
                };

                if (activeRoleId) {
                    whereClause.id = activeRoleId;
                } else {
                    whereClause.name = activeRole;
                }

                let roleData = await prisma.role.findFirst({
                    where: whereClause
                });

                if (!roleData && activeRole === 'COMPANY') {
                    roleData = await prisma.role.findFirst({
                        where: { companyId: activeCompanyId }
                    });
                }

                if (roleData && roleData.permissions) {
                    permissions = JSON.parse(roleData.permissions);
                } else if (activeRole === 'COMPANY') {
                    permissions = [
                        "show dashboard",
                        "manage voucher", "create voucher", "edit voucher", "delete voucher",
                        "manage reports", "view reports",
                        "manage user", "create user", "edit user", "delete user",
                        "manage role", "create role", "edit role", "delete role",
                        "manage settings", "edit settings", "view settings",
                        "manage accounts", "create accounts", "edit accounts", "delete accounts", "view accounts",
                        "manage inventory", "create inventory", "edit inventory", "delete inventory", "view inventory",
                        "manage sales", "create sales", "edit sales", "delete sales", "show sales", "send sales", "view sales",
                        "manage purchases", "create purchases", "edit purchases", "delete purchases", "view purchases",
                        "manage pos", "create pos", "edit pos", "delete pos", "view pos"
                    ];
                }
            }

            // Extract Plan Modules if available
            if (activeCompany && activeCompany.plan && activeCompany.plan.modules) {
                try {
                    planModules = JSON.parse(activeCompany.plan.modules);
                } catch (pe) {
                    console.error("Plan module parse error", pe);
                }
            }
        } catch (e) {
            console.log("Perm fetch error", e);
        }

        const userCompanies = linkedCompanies.map(lc => ({
            id: lc.company.id,
            name: lc.company.name,
            email: lc.company.email,
            logo: lc.company.logo,
            currency: lc.company.currency,
            role: lc.role,
            roleId: lc.roleId,
            plan: lc.company.plan,
            isDefault: lc.companyId === activeCompanyId
        }));

        const token = jwt.sign(
            { 
                userId: user.id, 
                role: activeRole, 
                companyId: activeCompanyId,
                email: user.email,
                name: user.name,
                permissions: permissions,
                planModules: planModules
            },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: activeRole,
                companyId: activeCompanyId,
                company: activeCompany,
                companies: userCompanies,
                permissions: permissions,
                planModules: planModules
            },
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

const switchCompany = async (req, res) => {
    try {
        const { companyId } = req.body;
        const targetCompanyId = parseInt(companyId);
        if (!targetCompanyId) {
            return res.status(400).json({ message: 'Company ID is required' });
        }

        const userId = req.user?.userId || req.user?.id;
        if (!userId) {
            return res.status(401).json({ message: 'User ID missing from token' });
        }

        const user = await prisma.user.findUnique({
            where: { id: userId }
        });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        let companyUser = null;
        let targetCompany = null;

        if (user.role === 'SUPERADMIN') {
            targetCompany = await prisma.company.findUnique({
                where: { id: targetCompanyId },
                include: { plan: true }
            });
        } else {
            companyUser = await prisma.company_user.findUnique({
                where: {
                    userId_companyId: {
                        userId: userId,
                        companyId: targetCompanyId
                    }
                },
                include: {
                    company: {
                        include: { plan: true }
                    }
                }
            });

            if (!companyUser) {
                // Check if matching email
                const matchedCompany = await prisma.company.findFirst({
                    where: {
                        id: targetCompanyId,
                        email: { equals: user.email }
                    },
                    include: { plan: true }
                });
                if (matchedCompany) {
                    companyUser = await prisma.company_user.create({
                        data: {
                            userId: user.id,
                            companyId: matchedCompany.id,
                            role: 'COMPANY'
                        },
                        include: {
                            company: {
                                include: { plan: true }
                            }
                        }
                    });
                }
            }

            if (!companyUser) {
                return res.status(403).json({ message: 'Access denied: You do not have access to this company' });
            }
            targetCompany = companyUser.company;
        }

        if (!targetCompany) {
            return res.status(404).json({ message: 'Target company not found' });
        }

        // Check for company plan expiration
        if (user.role !== 'SUPERADMIN' && targetCompany.endDate) {
            const expiryDate = new Date(targetCompany.endDate);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            if (expiryDate < today) {
                return res.status(403).json({ 
                    message: 'Cannot switch: This company plan has expired.',
                    isExpired: true 
                });
            }
        }

        // Update user's active companyId in DB
        await prisma.user.update({
            where: { id: userId },
            data: { companyId: targetCompany.id }
        });

        const targetRole = companyUser ? companyUser.role : user.role;
        const targetRoleId = companyUser ? companyUser.roleId : user.roleId;

        let permissions = [];
        let planModules = [];

        try {
            if (targetRole && targetRole !== 'SUPERADMIN') {
                const whereClause = { companyId: targetCompany.id };
                if (targetRoleId) {
                    whereClause.id = targetRoleId;
                } else {
                    whereClause.name = targetRole;
                }

                let roleData = await prisma.role.findFirst({ where: whereClause });
                if (!roleData && targetRole === 'COMPANY') {
                    roleData = await prisma.role.findFirst({ where: { companyId: targetCompany.id } });
                }

                if (roleData && roleData.permissions) {
                    permissions = JSON.parse(roleData.permissions);
                } else if (targetRole === 'COMPANY') {
                    permissions = [
                        "show dashboard",
                        "manage voucher", "create voucher", "edit voucher", "delete voucher",
                        "manage reports", "view reports",
                        "manage user", "create user", "edit user", "delete user",
                        "manage role", "create role", "edit role", "delete role",
                        "manage settings", "edit settings", "view settings",
                        "manage accounts", "create accounts", "edit accounts", "delete accounts", "view accounts",
                        "manage inventory", "create inventory", "edit inventory", "delete inventory", "view inventory",
                        "manage sales", "create sales", "edit sales", "delete sales", "show sales", "send sales", "view sales",
                        "manage purchases", "create purchases", "edit purchases", "delete purchases", "view purchases",
                        "manage pos", "create pos", "edit pos", "delete pos", "view pos"
                    ];
                }
            }

            if (targetCompany.plan && targetCompany.plan.modules) {
                try {
                    planModules = JSON.parse(targetCompany.plan.modules);
                } catch (pe) {
                    console.error("Plan module parse error in switch:", pe);
                }
            }
        } catch (e) {
            console.error("Permission fetch error in switch:", e);
        }

        // Fetch all linked companies for user payload
        const allCompanyUsers = await prisma.company_user.findMany({
            where: { userId: user.id },
            include: {
                company: {
                    include: { plan: true }
                }
            },
            orderBy: { createdAt: 'asc' }
        });

        const userCompanies = allCompanyUsers.map(cu => ({
            id: cu.company.id,
            name: cu.company.name,
            email: cu.company.email,
            logo: cu.company.logo,
            currency: cu.company.currency,
            role: cu.role,
            roleId: cu.roleId,
            plan: cu.company.plan,
            isDefault: cu.company.id === targetCompany.id
        }));

        const token = jwt.sign(
            { 
                userId: user.id, 
                role: targetRole, 
                companyId: targetCompany.id,
                email: user.email,
                name: user.name,
                permissions: permissions,
                planModules: planModules
            },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        res.json({
            message: `Switched to ${targetCompany.name}`,
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: targetRole,
                companyId: targetCompany.id,
                company: targetCompany,
                companies: userCompanies,
                permissions: permissions,
                planModules: planModules
            },
        });
    } catch (error) {
        console.error("Error in switchCompany:", error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

const impersonate = async (req, res) => {
    try {
        const { companyId } = req.body;
        
        if (!companyId) {
            return res.status(400).json({ message: 'Company ID is required' });
        }

        // Find the admin user (role='COMPANY') for this company
        const user = await prisma.user.findFirst({
            where: { 
                companyId: parseInt(companyId),
                role: 'COMPANY'
            },
            include: {
                company: {
                    include: {
                        plan: true
                    }
                }
            }
        });

        if (!user) {
            return res.status(404).json({ message: 'No admin user found for this company' });
        }

        // Check for company plan expiration during impersonation
        if (user.company && user.company.endDate) {
            const expiryDate = new Date(user.company.endDate);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            if (expiryDate < today) {
                return res.status(403).json({ 
                    message: 'Cannot login: This company plan has expired.',
                    isExpired: true 
                });
            }
        }

        let permissions = [];
        let planModules = [];

        try {
            const roleData = await prisma.role.findFirst({
                where: { 
                    companyId: user.companyId,
                    name: 'COMPANY'
                }
            });

            if (roleData && roleData.permissions) {
                permissions = JSON.parse(roleData.permissions);
            }

            if (user.company && user.company.plan && user.company.plan.modules) {
                planModules = JSON.parse(user.company.plan.modules);
            }
        } catch (e) {
            console.error("Perm fetch error in impersonate:", e);
        }

        const token = jwt.sign(
            { 
                userId: user.id, 
                role: user.role, 
                companyId: user.companyId,
                email: user.email,
                name: user.name,
                permissions: permissions,
                planModules: planModules,
                isImpersonated: true
            },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        res.json({
            message: 'Impersonation successful',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                companyId: user.companyId,
                company: user.company,
                permissions: permissions,
                planModules: planModules
            },
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = { register, login, impersonate, switchCompany };
