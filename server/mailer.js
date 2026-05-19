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

module.exports = {
  initMailer,
  sendApprovalRequest,
  sendApprovalNotification
};
