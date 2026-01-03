
import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const PLANS = [
  {
    name: "Starter Yearly",
    description: "Perfect for small teams (Yearly)",
    price: 240.00,
    discount: 40.00,
    currency: "USD",
    duration: "yearly",
    features: [
      "Advanced Analytics",
      "Up to 20 Team Members",
      "Email Support",
      "2 Months Free"
    ],
    max_team_members: 20,
    trial_days: 0,
    permissions: [
      "view_dashboard",
      "manage_tasks",
      "manage_team",
      "manage_epics",
      "manage_ideas",
      "view_ranking"
    ],
    is_active: true
  },
  {
    name: "Pro Yearly",
    description: "For growing businesses (Yearly)",
    price: 720.00,
    discount: 120.00,
    currency: "USD",
    duration: "yearly",
    features: [
      "All Features",
      "Unlimited Team Members",
      "Priority Support",
      "2 Months Free"
    ],
    max_team_members: 999999,
    trial_days: 0,
    permissions: [
      "view_dashboard",
      "manage_tasks",
      "manage_team",
      "manage_epics",
      "manage_ideas",
      "view_activity",
      "export_data",
      "view_ranking",
      "manage_finance"
    ],
    is_active: true
  }
];

async function seedPlans() {
  try {
    console.log("Seeding Yearly Plans...");

    for (const plan of PLANS) {
      // Check if exists by name
      const res = await pool.query("SELECT id FROM pricing_plans WHERE name = $1 AND duration = 'yearly'", [plan.name]);
      
      if (res.rows.length === 0) {
        console.log(`Creating ${plan.name}...`);
        await pool.query(
          `INSERT INTO pricing_plans (
            name, description, price, discount, currency, duration, features, 
            max_team_members, trial_days, permissions, is_active
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            plan.name,
            plan.description,
            plan.price,
            plan.discount,
            plan.currency,
            plan.duration,
            JSON.stringify(plan.features),
            plan.max_team_members,
            plan.trial_days,
            JSON.stringify(plan.permissions),
            plan.is_active
          ]
        );
      } else {
        console.log(`${plan.name} already exists. Updating...`);
        // Optional: Update existing to ensure they match our standard
        await pool.query(
          `UPDATE pricing_plans SET 
            price = $1, discount = $2, features = $3, permissions = $4, is_active = $5
           WHERE name = $6 AND duration = 'yearly'`,
           [plan.price, plan.discount, JSON.stringify(plan.features), JSON.stringify(plan.permissions), plan.is_active, plan.name]
        );
      }
    }
    
    console.log("Seeding completed successfully.");
  } catch (error) {
    console.error("Seeding failed:", error);
  } finally {
    await pool.end();
  }
}

seedPlans();
