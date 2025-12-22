
import "dotenv/config";
import { sendEmail } from "./services/email";

async function testEmail() {
  console.log("Testing email sending...");
  const to = "test-recipient@example.com"; // We will mock the axios call or just see if it errors
  const toName = "Test User";
  const subject = "Test Email from KPITracker";
  const html = "<p>This is a test email.</p>";

  try {
    const result = await sendEmail(to, toName, subject, html);
    if (result) {
      console.log("✅ Email sent successfully according to function return.");
    } else {
      console.error("❌ Email sending function returned false.");
    }
  } catch (error) {
    console.error("❌ Exception during email sending:", error);
  }
}

testEmail();
