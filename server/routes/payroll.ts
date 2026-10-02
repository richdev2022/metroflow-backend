import express from "express";
import { query } from "../db";
import { AuthenticatedRequest, authenticateToken, checkSubscriptionStatus, checkFeaturePermission, checkKycStatus } from "../middleware/auth";
import { requireTeamPermission } from "../middleware/teamAuth";
import { sendPayrollAdjustmentNotification, sendEmail, generateInviteEmailHtml } from "../services/email";
import { accountLookup } from "../services/transfer";
import crypto from "crypto";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Payroll
 *   description: Payroll management and adjustments
 */

/**
 * @swagger
 * /payroll/adjustments:
 *   post:
 *     summary: Add a payroll adjustment (bonus or deduction)
 *     tags: [Payroll]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - type
 *               - amount
 *               - reason
 *             properties:
 *               userId:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [bonus, deduction]
 *               amount:
 *                 type: number
 *               currency:
 *                 type: string
 *                 enum: [USD, NGN]
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Adjustment added
 */
router.post("/adjustments", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), checkKycStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { userId, type, amount, reason, currency } = req.body;

        if (!['bonus', 'deduction'].includes(type)) {
            return res.status(400).json({ success: false, error: "Invalid type. Must be 'bonus' or 'deduction'." });
        }

        if (amount <= 0) {
            return res.status(400).json({ success: false, error: "Amount must be greater than 0." });
        }

        if (currency && !['USD', 'NGN'].includes(currency)) {
            return res.status(400).json({ success: false, error: "Invalid currency. Must be USD or NGN." });
        }

        // Check if user belongs to business
        const userCheck = await query(`SELECT * FROM users WHERE id = $1 AND business_id = $2`, [userId, businessId]);
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ success: false, error: "User not found." });
        }
        const user = userCheck.rows[0];

        // Determine currency: provided > user's salary currency > business default > NGN
        let finalCurrency = currency;
        if (!finalCurrency) {
            if (user.salary_currency) {
                finalCurrency = user.salary_currency;
            } else {
                const businessRes = await query(`SELECT currency FROM businesses WHERE id = $1`, [businessId]);
                finalCurrency = businessRes.rows[0]?.currency || 'NGN';
            }
        }

        // Create adjustment
        await query(
            `INSERT INTO payroll_adjustments (business_id, user_id, type, amount, currency, reason, status) 
             VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
            [businessId, userId, type, amount, finalCurrency, reason]
        );

        // Send Notifications
        // 1. Get Admins
        const admins = await query(`SELECT email FROM users WHERE business_id = $1 AND role IN ('admin', 'manager') AND email_verified = TRUE`, [businessId]);
        const emailList = admins.rows.map(r => r.email);
        
        // 2. Add User Email
        if (user.email_verified) {
            emailList.push(user.email);
        }

        // 3. Deduplicate
        const uniqueEmails: string[] = Array.from(new Set(emailList));

        // 4. Get Business Name
        const businessRes = await query(`SELECT name FROM businesses WHERE id = $1`, [businessId]);
        const businessName = businessRes.rows[0].name;

        // 5. Send Email
        await sendPayrollAdjustmentNotification(
            uniqueEmails,
            user.name,
            type,
            amount,
            finalCurrency,
            reason,
            businessName
        );

        res.json({ success: true, message: "Adjustment added and notifications sent." });

    } catch (error) {
        console.error("Add adjustment error:", error);
        res.status(500).json({ success: false, error: "Failed to add adjustment" });
    }
});

/**
 * @swagger
 * /payroll/adjustments:
 *   get:
 *     summary: Get pending payroll adjustments
 *     tags: [Payroll]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of adjustments
 */
router.get("/adjustments", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), checkKycStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { userId } = req.query;

        let queryText = `
            SELECT pa.*, u.name as user_name, u.email as user_email
            FROM payroll_adjustments pa
            JOIN users u ON pa.user_id = u.id
            WHERE pa.business_id = $1 AND pa.status = 'pending'
        `;
        const params: any[] = [businessId];

        if (userId) {
            queryText += ` AND pa.user_id = $2`;
            params.push(userId);
        }

        queryText += ` ORDER BY pa.created_at DESC`;

        const result = await query(queryText, params);
        res.json({ success: true, adjustments: result.rows });
    } catch (error) {
        console.error("Get adjustments error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch adjustments" });
    }
});

/**
 * @swagger
 * /payroll/adjustments/{id}:
 *   delete:
 *     summary: Delete/Cancel a pending adjustment
 *     tags: [Payroll]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Adjustment deleted
 */
router.delete("/adjustments/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), checkKycStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { id } = req.params;

        const result = await query(
            `DELETE FROM payroll_adjustments WHERE id = $1 AND business_id = $2 AND status = 'pending'`,
            [id, businessId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, error: "Adjustment not found or already processed" });
        }

        res.json({ success: true, message: "Adjustment removed" });
    } catch (error) {
        console.error("Delete adjustment error:", error);
        res.status(500).json({ success: false, error: "Failed to delete adjustment" });
    }
});

/**
 * @swagger
 * /payroll/summary:
 *   get:
 *     summary: Get payroll summary for all team members
 *     tags: [Payroll]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by name or email
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *         description: Filter by user role
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter adjustments start date (YYYY-MM-DD)
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter adjustments end date (YYYY-MM-DD)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Items per page
 *     responses:
 *       200:
 *         description: List of team members with payroll calculations
 */
router.get("/summary", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), checkKycStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { search, role, startDate, endDate, page = 1, limit = 10 } = req.query;
        const offset = (Number(page) - 1) * Number(limit);

        // Get business payroll configuration
    const businessCheck = await query(`SELECT salary_interval, salary_custom_date FROM businesses WHERE id = $1`, [businessId]);
    
    // Build User Query
    let userQuery = `
            SELECT id, name, email, salary_currency, account_number as bank_account_number, bank_code, account_name, role, salary_amount as salary, contract_start_date,
            COUNT(*) OVER() as total_count
            FROM users 
            WHERE business_id = $1 AND status = 'active'
        `;
        const userParams: any[] = [businessId];
        let paramIndex = 2;

        if (search) {
            userQuery += ` AND (name ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
            userParams.push(`%${search}%`);
            paramIndex++;
        }

        if (role) {
            userQuery += ` AND role = $${paramIndex}`;
            userParams.push(role);
            paramIndex++;
        }

        userQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        userParams.push(Number(limit), offset);

        // Fetch users
        const users = await query(userQuery, userParams);
        
        const totalUsers = users.rows.length > 0 ? parseInt(users.rows[0].total_count) : 0;
        const totalPages = Math.ceil(totalUsers / Number(limit));

        if (users.rows.length === 0) {
             return res.json({ 
                success: true, 
                payroll: [],
                pagination: {
                    total: totalUsers,
                    page: Number(page),
                    limit: Number(limit),
                    totalPages: totalPages
                }
            });
        }

        const userIds = users.rows.map(u => u.id);

        // Build Adjustment Query
        let adjQuery = `
            SELECT user_id, type, amount, currency 
            FROM payroll_adjustments 
            WHERE business_id = $1 AND status = 'pending' AND user_id = ANY($2)
        `;
        const adjParams: any[] = [businessId, userIds];
        let adjParamIndex = 3;

        if (startDate) {
             adjQuery += ` AND created_at >= $${adjParamIndex}`;
             adjParams.push(startDate);
             adjParamIndex++;
        }
        
        if (endDate) {
             adjQuery += ` AND created_at <= $${adjParamIndex}`;
             adjParams.push(endDate);
             adjParamIndex++;
        }

        // Fetch pending adjustments
        const adjustments = await query(adjQuery, adjParams);

        // Group adjustments by user
        const adjMap: Record<string, { bonuses: number, deductions: number, bonus_list: any[], deduction_list: any[] }> = {};
        
        adjustments.rows.forEach(adj => {
            if (!adjMap[adj.user_id]) {
                adjMap[adj.user_id] = { bonuses: 0, deductions: 0, bonus_list: [], deduction_list: [] };
            }
            // Simple currency conversion (assuming same currency for now, or just sum)
            // Ideally, we should convert everything to user's salary currency.
            // For this MVP, we sum raw amounts if currencies match or just display.
            // We'll assume amounts are in user's salary currency for calculation.
            if (adj.type === 'bonus') {
                adjMap[adj.user_id].bonuses += parseFloat(adj.amount);
                adjMap[adj.user_id].bonus_list.push(adj);
            } else {
                adjMap[adj.user_id].deductions += parseFloat(adj.amount);
                adjMap[adj.user_id].deduction_list.push(adj);
            }
        });

        const payrollData = users.rows.map(user => {
            const userAdj = adjMap[user.id] || { bonuses: 0, deductions: 0, bonus_list: [], deduction_list: [] };
            const salary = parseFloat((user as any).salary || '0');
            // const net = salary + userAdj.bonuses - userAdj.deductions; // Removed to avoid duplication and unused variable
            
            // Calculate Next Pay Date & Pay Period Start
            const today = new Date();
            let nextPayDate = new Date();
            let periodStartDate = new Date();
            const { salary_interval, salary_custom_date } = businessCheck.rows[0];

            if (salary_interval === 'daily') {
                nextPayDate.setDate(today.getDate() + 1);
                periodStartDate = new Date(today); // Today is the start
            } else if (salary_interval === 'weekly') {
                nextPayDate.setDate(today.getDate() + 7);
                periodStartDate.setDate(today.getDate() - 6); // 7 days window ending today (approx) or forward looking?
                // Standardizing: Let's assume period ends on nextPayDate - 1 day, or nextPayDate is the payday for PREVIOUS period.
                // Simplified: Daily Pay = Salary / 7. Days worked = days in current week user was active.
                // For simplicity in MVP: Assume period starts 7 days before nextPayDate.
                const nextPayTime = nextPayDate.getTime();
                periodStartDate = new Date(nextPayTime - 7 * 24 * 60 * 60 * 1000);
            } else if (salary_interval === 'yearly') {
                nextPayDate.setFullYear(today.getFullYear() + 1);
                periodStartDate.setFullYear(today.getFullYear()); // Start of this year
            } else if (salary_interval === 'custom' && salary_custom_date) {
                nextPayDate = new Date(salary_custom_date);
                // Assume monthly duration for custom date for now, or just undefined period start (default to 30 days back)
                periodStartDate = new Date(nextPayDate);
                periodStartDate.setDate(periodStartDate.getDate() - 30);
            } else {
                 // Default to Monthly (Last day of current month)
                nextPayDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
                periodStartDate = new Date(today.getFullYear(), today.getMonth(), 1); // 1st of current month
            }
            
            // Calculate Prorated Salary
            let finalSalary = salary;
            let daysWorked = 0;
            let totalDaysInPeriod = 0;
            let calculationType = 'standard'; // 'standard', 'prorated', 'not_started'

            if (user.contract_start_date) {
                const contractStart = new Date(user.contract_start_date);
                
                // Determine Total Days in Period
                const diffTime = nextPayDate.getTime() - periodStartDate.getTime();
                totalDaysInPeriod = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
                if (totalDaysInPeriod === 0) totalDaysInPeriod = 30; // Fallback

                // Determine Daily Pay
                const dailyPay = salary / totalDaysInPeriod;

                // Determine Days Worked in this Period
                // If contract starts AFTER period ends, pay 0.
                // If contract starts BEFORE period starts, pay Full (daysWorked = totalDaysInPeriod).
                // If contract starts WITHIN period, pay partial.
                
                if (contractStart > nextPayDate) {
                    daysWorked = 0;
                    calculationType = 'not_started';
                } else if (contractStart <= periodStartDate) {
                    daysWorked = totalDaysInPeriod;
                    calculationType = 'standard';
                } else {
                    // Starts within period
                    const workedTime = nextPayDate.getTime() - contractStart.getTime();
                    daysWorked = Math.ceil(workedTime / (1000 * 60 * 60 * 24));
                    // Ensure we don't exceed total days (though logic implies we won't)
                    if (daysWorked > totalDaysInPeriod) daysWorked = totalDaysInPeriod;
                    if (daysWorked < 0) daysWorked = 0;
                    
                    calculationType = 'prorated';
                }

                finalSalary = dailyPay * daysWorked;
            }

            const finalNet = finalSalary + userAdj.bonuses - userAdj.deductions;
            
            return {
                ...user,
                // Remove total_count from user object in response
                total_count: undefined,
                currency: user.salary_currency || 'NGN', // Explicitly return currency for display
                bonuses_total: userAdj.bonuses,
                deductions_total: userAdj.deductions,
                net_salary: finalNet > 0 ? finalNet : 0,
                next_pay_date: nextPayDate.toISOString().split('T')[0],
                adjustments: userAdj,
                contract_start_date: user.contract_start_date, // Return this for frontend
                days_worked: daysWorked > 0 ? daysWorked : undefined, // Optional info
                salary_calculation_status: calculationType
            };
        });

        res.json({ 
            success: true, 
            payroll: payrollData,
            pagination: {
                total: totalUsers,
                page: Number(page),
                limit: Number(limit),
                totalPages: totalPages
            }
        });

    } catch (error: any) {
        console.error("Get payroll summary error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch payroll summary", details: error.message });
    }
});

/**
 * @swagger
 * /payroll/user/{id}:
 *   put:
 *     summary: Update user payroll details
 *     tags: [Payroll]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               salary:
 *                 type: number
 *               salary_currency:
 *                 type: string
 *               bank_account_number:
 *                 type: string
 *               bank_code:
 *                 type: string
 *               account_name:
 *                 type: string
 *               contract_start_date:
 *                 type: string
 *                 format: date
 *     responses:
 *       200:
 *         description: User payroll details updated
 */
router.put("/user/:id", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), checkKycStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { id } = req.params;
        const { salary, salary_currency, bank_account_number, bank_code, account_name, contract_start_date } = req.body;

        const check = await query(`SELECT id FROM users WHERE id = $1 AND business_id = $2`, [id, businessId]);
        if (check.rows.length === 0) return res.status(404).json({ success: false, error: "User not found" });

        await query(
            `UPDATE users SET 
                salary_amount = COALESCE($1, salary_amount), 
                salary_currency = COALESCE($2, salary_currency), 
                account_number = COALESCE($3, account_number), 
                bank_code = COALESCE($4, bank_code), 
                account_name = COALESCE($5, account_name),
                contract_start_date = COALESCE($6, contract_start_date)
             WHERE id = $7`,
            [salary, salary_currency, bank_account_number, bank_code, account_name, contract_start_date, id]
        );

        res.json({ success: true, message: "Payroll details updated" });

    } catch (error) {
        console.error("Update payroll details error:", error);
        res.status(500).json({ success: false, error: "Failed to update payroll details" });
    }
});

/**
 * @swagger
 * /payroll/config:
 *   get:
 *     summary: Get payroll configuration (salary interval)
 *     tags: [Payroll]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current payroll configuration
 */
router.get("/config", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), checkKycStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const result = await query(`SELECT salary_interval, salary_custom_date FROM businesses WHERE id = $1`, [businessId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Business not found" });
        }

        res.json({ success: true, config: result.rows[0] });
    } catch (error) {
        console.error("Get payroll config error:", error);
        res.status(500).json({ success: false, error: "Failed to get payroll config" });
    }
});

/**
 * @swagger
 * /payroll/config:
 *   put:
 *     summary: Update payroll configuration
 *     tags: [Payroll]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - salary_interval
 *             properties:
 *               salary_interval:
 *                 type: string
 *                 enum: [daily, weekly, monthly, yearly, custom]
 *               salary_custom_date:
 *                 type: string
 *                 format: date-time
 *                 description: Required if interval is custom
 *     responses:
 *       200:
 *         description: Configuration updated
 */
router.put("/config", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), checkKycStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { salary_interval, salary_custom_date } = req.body;

        const validIntervals = ['daily', 'weekly', 'monthly', 'yearly', 'custom'];
        if (!validIntervals.includes(salary_interval)) {
            return res.status(400).json({ success: false, error: "Invalid salary interval" });
        }

        if (salary_interval === 'custom' && !salary_custom_date) {
            return res.status(400).json({ success: false, error: "Custom date is required for custom interval" });
        }

        await query(
            `UPDATE businesses SET salary_interval = $1, salary_custom_date = $2 WHERE id = $3`,
            [salary_interval, salary_custom_date || null, businessId]
        );

        res.json({ success: true, message: "Payroll configuration updated" });
    } catch (error) {
        console.error("Update payroll config error:", error);
        res.status(500).json({ success: false, error: "Failed to update payroll config" });
    }
});

/**
 * Bulk employee import for payroll (Excel/CSV upload companion).
 * The client parses the spreadsheet and posts normalized rows; this endpoint
 * creates invited users (or updates existing ones) with their payroll details
 * and sends invite emails best-effort.
 */
router.post("/employees/import", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), checkKycStatus, async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const userId = req.user?.userId;
        const rows: any[] = Array.isArray(req.body?.employees) ? req.body.employees : [];

        if (rows.length === 0) {
            return res.status(400).json({ success: false, error: "employees array is required" });
        }
        if (rows.length > 500) {
            return res.status(400).json({ success: false, error: "A maximum of 500 employees can be imported at once" });
        }

        const baseUrl =
            process.env.CLIENT_URL ||
            process.env.APP_BASE_URL ||
            process.env.APP_URL ||
            "https://metricorex.com";

        const results: Array<Record<string, any>> = [];
        let created = 0;
        let updated = 0;
        let failed = 0;

        for (const [index, row] of rows.entries()) {
            const rowResult: Record<string, any> = { row: index + 1 };
            try {
                const name = String(row.name || row.employee_name || '').trim();
                const email = String(row.email || row.employee_email || '').trim().toLowerCase();
                const role = String(row.role || row.job_title || 'Employee').trim() || 'Employee';
                const salary = row.salary !== undefined && row.salary !== '' ? parseFloat(row.salary) : null;
                const salaryCurrency = String(row.salary_currency || row.currency || 'NGN').trim().toUpperCase() || 'NGN';
                const bankCode = row.bank_code || row.bankCode || null;
                const bankAccountNumber = row.bank_account_number || row.account_number || row.bankAccountNumber || null;
                const accountName = row.account_name || row.accountName || null;
                const contractStartDate = row.contract_start_date || row.contractStartDate || null;
                const department = row.department || null;
                const jobTitle = row.job_title || row.title || null;
                const phoneNumber = row.phone_number || row.phone || null;
                const bankName = row.bank_name || row.bankName || null;
                const bankCountry = String(row.bank_country || row.bankCountry || (salaryCurrency === 'USD' ? 'US' : 'NG')).toUpperCase().slice(0, 5) || null;
                const swiftCode = row.swift_code || row.swiftCode || row.swift || null;
                const routingNumber = row.routing_number || row.routingNumber || row.aba || row.routing || null;
                const beneficiaryAddress = row.beneficiary_address || row.address || null;
                const beneficiaryCity = row.beneficiary_city || row.city || null;
                const beneficiaryCountry = (row.beneficiary_country || row.country || null)
                    ? String(row.beneficiary_country || row.country).toUpperCase().slice(0, 5)
                    : null;

                if (!name) throw new Error('Name is required');
                if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email is required');
                if (salary !== null && (isNaN(salary) || salary < 0)) throw new Error('Salary must be a positive number');

                const existing = await query(
                    `SELECT id, status FROM users WHERE business_id = $1 AND email = $2 LIMIT 1`,
                    [businessId, email]
                );

                let memberId: string;
                let status: string;
                let inviteLink: string | null = null;
                let emailSent = false;

                if (existing.rows.length > 0) {
                    // Existing member -> refresh payroll details only.
                    // Recipient detail changes reset the verification status.
                    memberId = existing.rows[0].id;
                    status = existing.rows[0].status;
                    await query(
                        `UPDATE users SET
                            name = COALESCE($1, name),
                            role = COALESCE($2, role),
                            salary_amount = COALESCE($3, salary_amount),
                            salary_currency = COALESCE($4, salary_currency),
                            bank_code = COALESCE($5, bank_code),
                            account_number = COALESCE($6, account_number),
                            account_name = COALESCE($7, account_name),
                            contract_start_date = COALESCE($8, contract_start_date),
                            department = COALESCE($9, department),
                            job_title = COALESCE($10, job_title),
                            phone_number = COALESCE($11, phone_number),
                            bank_name = COALESCE($12, bank_name),
                            bank_country = COALESCE($13, bank_country),
                            swift_code = COALESCE($14, swift_code),
                            routing_number = COALESCE($15, routing_number),
                            beneficiary_address = COALESCE($16, beneficiary_address),
                            beneficiary_city = COALESCE($17, beneficiary_city),
                            beneficiary_country = COALESCE($18, beneficiary_country),
                            verification_status = CASE
                                WHEN ($5 IS NOT NULL AND bank_code IS DISTINCT FROM $5)
                                  OR ($6 IS NOT NULL AND account_number IS DISTINCT FROM $6)
                                THEN 'unverified'
                                ELSE verification_status
                            END,
                            updated_at = CURRENT_TIMESTAMP
                         WHERE id = $19`,
                        [name, role, salary, salaryCurrency, bankCode, bankAccountNumber, accountName, contractStartDate,
                         department, jobTitle, phoneNumber, bankName, bankCountry, swiftCode, routingNumber,
                         beneficiaryAddress, beneficiaryCity, beneficiaryCountry, memberId]
                    );
                    updated += 1;
                    rowResult.action = 'updated';
                } else {
                    // New member -> create invited user with a fresh invite token
                    const inviteToken = crypto.randomBytes(32).toString("hex");
                    const inviteExpiresAt = new Date();
                    inviteExpiresAt.setDate(inviteExpiresAt.getDate() + 7);

                    const inserted = await query(
                        `INSERT INTO users
                         (business_id, name, email, role, status, invite_token, invite_expires_at,
                          salary_amount, salary_currency, bank_code, account_number, account_name, contract_start_date,
                          department, job_title, phone_number, bank_name, bank_country, swift_code, routing_number,
                          beneficiary_address, beneficiary_city, beneficiary_country, verification_status)
                         VALUES ($1, $2, $3, $4, 'invited', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, 'unverified')
                         ON CONFLICT (business_id, email) DO UPDATE SET
                           name = EXCLUDED.name,
                           role = EXCLUDED.role,
                           salary_amount = COALESCE(EXCLUDED.salary_amount, users.salary_amount),
                           salary_currency = COALESCE(EXCLUDED.salary_currency, users.salary_currency),
                           bank_code = COALESCE(EXCLUDED.bank_code, users.bank_code),
                           account_number = COALESCE(EXCLUDED.account_number, users.account_number),
                           account_name = COALESCE(EXCLUDED.account_name, users.account_name),
                           contract_start_date = COALESCE(EXCLUDED.contract_start_date, users.contract_start_date),
                           department = COALESCE(EXCLUDED.department, users.department),
                           job_title = COALESCE(EXCLUDED.job_title, users.job_title),
                           phone_number = COALESCE(EXCLUDED.phone_number, users.phone_number),
                           bank_name = COALESCE(EXCLUDED.bank_name, users.bank_name),
                           bank_country = COALESCE(EXCLUDED.bank_country, users.bank_country),
                           swift_code = COALESCE(EXCLUDED.swift_code, users.swift_code),
                           routing_number = COALESCE(EXCLUDED.routing_number, users.routing_number),
                           beneficiary_address = COALESCE(EXCLUDED.beneficiary_address, users.beneficiary_address),
                           beneficiary_city = COALESCE(EXCLUDED.beneficiary_city, users.beneficiary_city),
                           beneficiary_country = COALESCE(EXCLUDED.beneficiary_country, users.beneficiary_country)
                         RETURNING id, status`,
                        [businessId, name, email, role, inviteToken, inviteExpiresAt,
                         salary, salaryCurrency, bankCode, bankAccountNumber, accountName, contractStartDate,
                         department, jobTitle, phoneNumber, bankName, bankCountry, swiftCode, routingNumber,
                         beneficiaryAddress, beneficiaryCity, beneficiaryCountry]
                    );
                    memberId = inserted.rows[0].id;
                    status = inserted.rows[0].status;
                    inviteLink = `${baseUrl}/accept-invite/${inviteToken}`;

                    try {
                        emailSent = await sendEmail(
                            email,
                            name,
                            "You're Invited to Metricorex",
                            generateInviteEmailHtml(name, inviteLink),
                        );
                    } catch (emailError) {
                        console.error(`Payroll import invite email threw for ${email}:`, emailError);
                    }
                    created += 1;
                    rowResult.action = 'created';
                }

                rowResult.success = true;
                rowResult.id = memberId;
                rowResult.status = status;
                rowResult.name = name;
                rowResult.email = email;
                rowResult.emailSent = emailSent;
                if (inviteLink) rowResult.inviteLink = inviteLink;
            } catch (rowError: any) {
                failed += 1;
                rowResult.success = false;
                rowResult.error = rowError?.message || 'Failed to import row';
            }
            results.push(rowResult);
        }

        try {
            const { logActivity } = await import("../services/activity");
            await logActivity({
                businessId,
                userId: userId!,
                action: "import",
                actionType: "payroll",
                description: `Imported ${created + updated} payroll employees via Excel (${created} created, ${updated} updated, ${failed} failed)`,
                metadata: { created, updated, failed },
            });
        } catch (logErr) {
            console.warn("Failed to log payroll import activity:", logErr);
        }

        res.json({
            success: failed < rows.length || rows.length > 0,
            data: {
                total: rows.length,
                created,
                updated,
                failed,
                results,
            },
            message: failed === rows.length && rows.length > 0
                ? 'Import failed - no rows could be processed'
                : `Imported ${created + updated} of ${rows.length} employees`,
        });
    } catch (error) {
        console.error("Payroll employees import error:", error);
        res.status(500).json({ success: false, error: "Failed to import employees" });
    }
});

/**
 * GET /payroll/employees
 * Full employee directory with recipient + verification details.
 * Filters: verification_status (unverified|verified|failed), search, currency,
 * status, salary has-bank-details filter, pagination.
 */
router.get("/employees", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const { verification_status, search, currency, status, page = '1', limit = '50' } = req.query as Record<string, string>;

        const params: any[] = [businessId];
        let sql = `
            SELECT id, name, email, role, job_title, department, phone_number, status,
                   salary_amount, salary_currency, bank_code, account_number, account_name,
                   bank_name, bank_country, swift_code, routing_number,
                   beneficiary_address, beneficiary_city, beneficiary_country,
                   verification_status, verified_account_name, verified_at, verification_error,
                   avatar_url, created_at
            FROM users
            WHERE business_id = $1 AND status != 'deleted'
              AND (salary_amount IS NOT NULL OR bank_code IS NOT NULL OR account_number IS NOT NULL OR role != 'owner')`;
        let idx = 2;

        if (verification_status && ['unverified', 'verified', 'failed', 'pending'].includes(verification_status)) {
            sql += ` AND verification_status = $${idx}`;
            params.push(verification_status);
            idx++;
        }
        if (currency) {
            sql += ` AND COALESCE(salary_currency, 'NGN') = $${idx}`;
            params.push(currency.toUpperCase());
            idx++;
        }
        if (status) {
            sql += ` AND status = $${idx}`;
            params.push(status);
            idx++;
        }
        if (search) {
            sql += ` AND (name ILIKE $${idx} OR email ILIKE $${idx} OR account_number ILIKE $${idx})`;
            params.push(`%${search}%`);
            idx++;
        }

        const countRes = await query(`SELECT COUNT(*)::int AS total FROM (${sql}) sub`, params);
        const total = countRes.rows[0]?.total || 0;

        sql += ` ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
        const lim = Math.min(Math.max(1, parseInt(limit) || 50), 200);
        params.push(lim, (Math.max(1, parseInt(page) || 1) - 1) * lim);

        const employeesRes = await query(sql, params);

        res.json({
            success: true,
            data: employeesRes.rows,
            pagination: { total, page: parseInt(page) || 1, limit: lim, totalPages: Math.ceil(total / lim) },
        });
    } catch (error: any) {
        console.error("List payroll employees error:", error);
        res.status(500).json({ success: false, error: "Failed to list employees" });
    }
});

/**
 * POST /payroll/employees/:id/verify
 * Runs an account-name lookup against the active transfer provider and stores
 * the verification result on the employee record.
 */
router.post("/employees/:id/verify", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const employeeId = req.params.id;

        const empRes = await query(
            `SELECT id, name, bank_code, account_number, verification_status FROM users
             WHERE id = $1 AND business_id = $2`,
            [employeeId, businessId],
        );
        if (empRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Employee not found" });
        }
        const employee = empRes.rows[0];
        if (!employee.bank_code || !employee.account_number) {
            return res.status(400).json({ success: false, error: "Employee has no bank account details to verify" });
        }

        try {
            const lookup = await accountLookup(employee.bank_code, employee.account_number);
            const accountName =
                lookup?.data?.account_name ||
                lookup?.data?.data?.account_name ||
                lookup?.data?.data?.accountName ||
                lookup?.data?.accountName ||
                null;
            const lookupStatus = lookup?.status || lookup?.data?.status;

            if (lookupStatus === 'success' && accountName) {
                await query(
                    `UPDATE users SET verification_status = 'verified', verified_account_name = $1,
                     verified_at = CURRENT_TIMESTAMP, verification_error = NULL, updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [accountName, employeeId],
                );
                return res.json({ success: true, data: { verification_status: 'verified', account_name: accountName } });
            }

            const errMsg = lookup?.message || lookup?.data?.message || 'Account lookup failed';
            await query(
                `UPDATE users SET verification_status = 'failed', verification_error = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                [errMsg, employeeId],
            );
            return res.status(400).json({ success: false, error: errMsg });
        } catch (lookupError: any) {
            const errMsg = lookupError?.message || 'Account lookup failed';
            await query(
                `UPDATE users SET verification_status = 'failed', verification_error = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                [errMsg, employeeId],
            ).catch(() => {});
            return res.status(400).json({ success: false, error: errMsg });
        }
    } catch (error: any) {
        console.error("Verify employee error:", error);
        res.status(500).json({ success: false, error: "Failed to verify employee" });
    }
});

/**
 * POST /payroll/employees/verify-bulk
 * Verify all pending/unverified employees at once (or a provided list of ids).
 * Returns per-employee results.
 */
router.post("/employees/verify-bulk", authenticateToken, checkSubscriptionStatus, checkFeaturePermission('manage_finance'), requireTeamPermission('manage_finance'), async (req: AuthenticatedRequest, res) => {
    try {
        const businessId = req.user!.businessId;
        const ids: string[] | undefined = Array.isArray(req.body?.employee_ids) ? req.body.employee_ids : undefined;

        const targets = ids && ids.length > 0
            ? await query(
                `SELECT id, name, bank_code, account_number FROM users
                 WHERE business_id = $1 AND id = ANY($2::uuid[]) AND verification_status != 'verified'
                   AND bank_code IS NOT NULL AND account_number IS NOT NULL`,
                [businessId, ids],
              )
            : await query(
                `SELECT id, name, bank_code, account_number FROM users
                 WHERE business_id = $1 AND verification_status != 'verified'
                   AND bank_code IS NOT NULL AND account_number IS NOT NULL`,
                [businessId],
              );

        const results: Array<Record<string, any>> = [];
        let verified = 0;
        let failed = 0;

        for (const emp of targets.rows) {
            try {
                const lookup = await accountLookup(emp.bank_code, emp.account_number);
                const accountName =
                    lookup?.data?.account_name ||
                    lookup?.data?.data?.account_name ||
                    lookup?.data?.accountName ||
                    null;
                const lookupStatus = lookup?.status || lookup?.data?.status;
                if (lookupStatus === 'success' && accountName) {
                    await query(
                        `UPDATE users SET verification_status = 'verified', verified_account_name = $1,
                         verified_at = CURRENT_TIMESTAMP, verification_error = NULL WHERE id = $2`,
                        [accountName, emp.id],
                    );
                    verified++;
                    results.push({ id: emp.id, name: emp.name, success: true, account_name: accountName });
                } else {
                    const errMsg = lookup?.message || lookup?.data?.message || 'Account lookup failed';
                    await query(
                        `UPDATE users SET verification_status = 'failed', verification_error = $1 WHERE id = $2`,
                        [errMsg, emp.id],
                    );
                    failed++;
                    results.push({ id: emp.id, name: emp.name, success: false, error: errMsg });
                }
            } catch (err: any) {
                failed++;
                const errMsg = err?.message || 'Account lookup failed';
                await query(
                    `UPDATE users SET verification_status = 'failed', verification_error = $1 WHERE id = $2`,
                    [errMsg, emp.id],
                ).catch(() => {});
                results.push({ id: emp.id, name: emp.name, success: false, error: errMsg });
            }
        }

        res.json({
            success: true,
            data: { total: targets.rows.length, verified, failed, results },
            message: `Verified ${verified} of ${targets.rows.length} employees`,
        });
    } catch (error: any) {
        console.error("Bulk verify employees error:", error);
        res.status(500).json({ success: false, error: "Failed to run bulk verification" });
    }
});

export default router;
