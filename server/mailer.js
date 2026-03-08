const nodemailer = require('nodemailer');
const config = require('../config.json');

let transporter = null;

function initMailer() {
  if (!config.notifications?.email?.enabled) {
    console.log('Email notifications disabled');
    return;
  }

  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: config.notifications.email.from,
      pass: config.notifications.email.appPassword
    }
  });

  console.log('Email notifications enabled');
}

async function sendApprovalRequest(username, approvalToken) {
  if (!transporter) return;

  const approveUrl = `${config.siteUrl}/api/approve/${approvalToken}`;
  const denyUrl = `${config.siteUrl}/api/deny/${approvalToken}`;

  const emailBody = `
New user registration request:

Username: ${username}

Approve: ${approveUrl}

Deny: ${denyUrl}

Or manage in admin panel: ${config.siteUrl}/admin.html
`;

  const smsBody = `New user: ${username}\nApprove: ${approveUrl}`;

  const recipients = config.notifications.email.to;

  for (const recipient of recipients) {
    try {
      const isSms = recipient.includes('@vtext.com') || 
                    recipient.includes('@txt.att.net') || 
                    recipient.includes('@tmomail.net');

      await transporter.sendMail({
        from: config.notifications.email.from,
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
    ? `Hi ${username},\n\nYour account has been approved! You can now view the live stream at ${config.siteUrl}\n\nWelcome to Sornig Farm!`
    : `Hi ${username},\n\nUnfortunately, your account request was not approved.\n\nIf you believe this was a mistake, please contact us.`;

  try {
    await transporter.sendMail({
      from: config.notifications.email.from,
      to: email,
      subject,
      text
    });
  } catch (err) {
    console.error('Failed to send approval notification:', err.message);
  }
}

module.exports = {
  initMailer,
  sendApprovalRequest,
  sendApprovalNotification
};
