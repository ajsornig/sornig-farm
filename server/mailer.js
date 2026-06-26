const nodemailer = require('nodemailer');

const emailFrom = process.env.EMAIL_FROM;
const emailPass = process.env.EMAIL_APP_PASSWORD;
const emailTo = process.env.EMAIL_TO ? process.env.EMAIL_TO.split(',') : [];
const siteUrl = process.env.SITE_URL || 'http://localhost:3000';

let transporter = null;

function initMailer() {
  if (!emailFrom || !emailPass) {
    console.log('Email notifications disabled (EMAIL_FROM or EMAIL_APP_PASSWORD not set)');
    return;
  }

  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: emailFrom,
      pass: emailPass
    }
  });

  console.log('Email notifications enabled');
}

async function sendApprovalRequest(username, approvalToken) {
  if (!transporter) return;

  const approveUrl = `${siteUrl}/api/approve/${approvalToken}`;
  const denyUrl = `${siteUrl}/api/deny/${approvalToken}`;

  const emailBody = `
New user registration request:

Username: ${username}

Approve: ${approveUrl}

Deny: ${denyUrl}

Or manage in admin panel: ${siteUrl}/admin.html
`;

  const smsBody = `New user: ${username}\nApprove: ${approveUrl}`;

  const recipients = emailTo;

  for (const recipient of recipients) {
    try {
      const isSms = recipient.includes('@vtext.com') || 
                    recipient.includes('@txt.att.net') || 
                    recipient.includes('@tmomail.net');

      await transporter.sendMail({
        from: emailFrom,
        to: recipient,
        subject: isSms ? '' : `Sornig Farm: New user "${username}" awaiting approval`,
        text: isSms ? smsBody : emailBody
      });
      console.log(`Notification sent to ${recipient}`);
    } catch (err) {
      console.error(`Failed to send notification to ${recipient}:`, err.message);
    }
  }
}

async function sendApprovalNotification(username, email, approved) {
  if (!transporter || !email) return;

  const subject = approved 
    ? 'Sornig Farm: Your account has been approved!'
    : 'Sornig Farm: Your account request was denied';

  const text = approved
    ? `Hi ${username},\n\nYour account has been approved! You can now view the live stream at ${siteUrl}\n\nWelcome to Sornig Farm!`
    : `Hi ${username},\n\nUnfortunately, your account request was not approved.\n\nIf you believe this was a mistake, please contact us.`;

  try {
    await transporter.sendMail({
      from: emailFrom,
      to: email,
      subject,
      text
    });
  } catch (err) {
    console.error('Failed to send approval notification:', err.message);
  }
}

async function sendPasswordResetEmail(username, email, resetToken) {
  if (!transporter) return;

  const resetUrl = `${siteUrl}/api/reset-password/${resetToken}`;

  const text = `Hi ${username},\n\nYou requested a password reset for your Sornig Farm account.\n\nClick here to reset your password:\n${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, you can safely ignore this email.`;

  try {
    await transporter.sendMail({
      from: emailFrom,
      to: email,
      subject: 'Sornig Farm: Password Reset Request',
      text
    });
    return { success: true };
  } catch (err) {
    console.error('Failed to send reset email:', err.message);
    return { error: 'Failed to send email' };
  }
}

async function sendBroadcast(subject, message, recipients) {
  if (!transporter) return { error: 'Email not configured' };
  if (!recipients.length) return { error: 'No recipients' };

  const results = { sent: 0, failed: 0, errors: [] };
  for (const { username, email } of recipients) {
    try {
      await transporter.sendMail({
        from: emailFrom,
        to: email,
        subject: `Sornig Farm: ${subject}`,
        text: `Hi ${username},\n\n${message}\n\n- Sornig Farm\n${siteUrl}`
      });
      results.sent++;
    } catch (err) {
      results.failed++;
      results.errors.push({ username, error: err.message });
      console.error(`Broadcast failed for ${email}:`, err.message);
    }
  }
  return results;
}

module.exports = {
  initMailer,
  sendApprovalRequest,
  sendApprovalNotification,
  sendPasswordResetEmail,
  sendBroadcast
};
