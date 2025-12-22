import axios from "axios";
import nodemailer from "nodemailer";

interface EmailPayload {
  to: Array<{
    email: string;
    name?: string;
  }>;
  subject: string;
  htmlContent: string;
  sender: {
    name: string;
    email: string;
  };
  replyTo: {
    email: string;
  };
}

export async function sendEmail(
  to: string,
  toName: string,
  subject: string,
  htmlContent: string,
): Promise<boolean> {
  try {
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_BASE_URL) {
      // Fallback to Nodemailer if SMTP vars are present
      if (process.env.SMTP_HOST) {
        try {
          const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || "587"),
            secure: process.env.SMTP_SECURE === "true",
            auth: {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS,
            },
          });

          await transporter.sendMail({
            from: `"${process.env.SMTP_FROM_NAME || 'MetricFlow'}" <${process.env.SMTP_FROM_EMAIL || 'noreply@metricflow.com'}>`,
            to: to,
            subject: subject,
            html: htmlContent,
          });
          console.log("Email sent successfully via Nodemailer:", { to, subject });
          return true;
        } catch (smtpError) {
          console.error("Nodemailer failed:", smtpError);
          return false;
        }
      }

      console.error("BREVO_API_KEY/URL not set and no SMTP config found");
      return false;
    }

    const payload: EmailPayload = {
      to: [
        {
          email: to,
          name: toName,
        },
      ],
      subject,
      htmlContent,
      sender: {
        name: process.env.BREVO_SENDER_NAME || "VeloBank",
        email: process.env.BREVO_SENDER_EMAIL || "noreply@quantigrate.com",
      },
      replyTo: {
        email: process.env.BREVO_SENDER_EMAIL || "noreply@quantigrate.com",
      },
    };

    const response = await axios.post(
      `${process.env.BREVO_BASE_URL}/v3/smtp/email`,
      payload,
      {
        headers: {
          "accept": "application/json",
          "Api-Key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: parseInt(process.env.BREVO_TIMEOUT_SECONDS || "30") * 1000,
      },
    );

    console.log("Email sent successfully:", {
      messageId: response.data?.messageId,
      to,
      subject,
    });
    return true;
  } catch (error) {
    console.error("Failed to send email:", {
      to,
      subject,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
