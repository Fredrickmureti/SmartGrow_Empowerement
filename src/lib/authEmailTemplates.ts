// Supabase Auth Email Templates
// Copy these into Supabase Dashboard → Authentication → Email Templates

export interface AuthEmailTemplate {
  id: string;
  name: string;
  description: string;
  subject: string;
  html: string;
  variables: string[];
}

const baseStyles = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  margin: 0;
  padding: 0;
  background-color: #f4f4f5;
`;

const headerGradient = `background: linear-gradient(135deg, #3b82f6 0%, #7c3aed 100%);`;

const ctaButtonStyle = `
  display: inline-block;
  background: linear-gradient(135deg, #3b82f6 0%, #7c3aed 100%);
  color: #ffffff;
  text-decoration: none;
  padding: 14px 32px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 16px;
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
`;

export const confirmSignupTemplate: AuthEmailTemplate = {
  id: 'confirm-signup',
  name: 'Confirm Sign Up',
  description: 'Ask users to confirm their email address after signing up',
  subject: 'Confirm your AccrualFlow account',
  variables: ['{{ .ConfirmationURL }}', '{{ .Email }}', '{{ .SiteURL }}'],
  html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm Your Email</title>
</head>
<body style="${baseStyles}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <tr>
            <td style="${headerGradient} padding: 32px; text-align: center;">
              <table cellpadding="0" cellspacing="0" style="margin: 0 auto;">
                <tr>
                  <td style="padding-right: 12px;">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M9 12L11 14L15 10M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </td>
                  <td>
                    <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">Confirm Your Email</h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 32px;">
              <p style="margin: 0 0 20px; color: #18181b; font-size: 16px; line-height: 1.6;">
                Welcome to <strong>AccrualFlow</strong>! 🎉
              </p>
              <p style="margin: 0 0 24px; color: #18181b; font-size: 16px; line-height: 1.6;">
                You're just one step away from managing your business finances like a pro. Click the button below to verify your email address and activate your account.
              </p>
              
              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 16px 0 32px;">
                    <a href="{{ .ConfirmationURL }}" style="${ctaButtonStyle}">
                      Confirm Email Address
                    </a>
                  </td>
                </tr>
              </table>
              
              <!-- Security Notice -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fef3c7; border-radius: 8px; border-left: 4px solid #f59e0b;">
                <tr>
                  <td style="padding: 16px;">
                    <p style="margin: 0; color: #92400e; font-size: 14px; line-height: 1.5;">
                      <strong>⏰ This link expires in 24 hours.</strong><br>
                      If you didn't create an account with AccrualFlow, you can safely ignore this email.
                    </p>
                  </td>
                </tr>
              </table>
              
              <!-- Alternative Link -->
              <p style="margin: 24px 0 0; color: #71717a; font-size: 13px; line-height: 1.5;">
                Button not working? Copy and paste this link into your browser:<br>
                <a href="{{ .ConfirmationURL }}" style="color: #3b82f6; word-break: break-all;">{{ .ConfirmationURL }}</a>
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f4f4f5; padding: 24px 32px; text-align: center; border-top: 1px solid #e4e4e7;">
              <p style="margin: 0 0 8px; color: #71717a; font-size: 12px;">
                © 2025 AccrualFlow. All rights reserved.
              </p>
              <p style="margin: 0; color: #a1a1aa; font-size: 11px;">
                This is an automated message. Please do not reply directly to this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
};

export const inviteUserTemplate: AuthEmailTemplate = {
  id: 'invite-user',
  name: 'Invite User',
  description: 'Invite users who don\'t yet have an account to sign up',
  subject: 'You\'ve been invited to join AccrualFlow',
  variables: ['{{ .ConfirmationURL }}', '{{ .Email }}', '{{ .SiteURL }}', '{{ .Token }}'],
  html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're Invited!</title>
</head>
<body style="${baseStyles}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <tr>
            <td style="${headerGradient} padding: 32px; text-align: center;">
              <table cellpadding="0" cellspacing="0" style="margin: 0 auto;">
                <tr>
                  <td style="padding-right: 12px;">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M17 21V19C17 16.7909 15.2091 15 13 15H5C2.79086 15 1 16.7909 1 19V21M23 21V19C23 17.1362 21.7252 15.5701 20 15.126M16 3.12602C17.7252 3.57006 19 5.13623 19 7C19 8.86377 17.7252 10.4299 16 10.874M13 7C13 9.20914 11.2091 11 9 11C6.79086 11 5 9.20914 5 7C5 4.79086 6.79086 3 9 3C11.2091 3 13 4.79086 13 7Z" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </td>
                  <td>
                    <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">You're Invited!</h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 32px;">
              <p style="margin: 0 0 20px; color: #18181b; font-size: 16px; line-height: 1.6;">
                Great news! 🎊
              </p>
              <p style="margin: 0 0 24px; color: #18181b; font-size: 16px; line-height: 1.6;">
                You've been invited to join <strong>AccrualFlow</strong>, a powerful platform for managing business finances, invoicing, and accounting. Click below to accept the invitation and set up your account.
              </p>
              
              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 16px 0 32px;">
                    <a href="{{ .ConfirmationURL }}" style="${ctaButtonStyle}">
                      Accept Invitation
                    </a>
                  </td>
                </tr>
              </table>
              
              <!-- Info Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #eff6ff; border-radius: 8px; border-left: 4px solid #3b82f6;">
                <tr>
                  <td style="padding: 16px;">
                    <p style="margin: 0; color: #1e40af; font-size: 14px; line-height: 1.5;">
                      <strong>What's next?</strong><br>
                      After clicking the button, you'll create a password and complete your profile setup. It only takes a minute!
                    </p>
                  </td>
                </tr>
              </table>
              
              <!-- Alternative Link -->
              <p style="margin: 24px 0 0; color: #71717a; font-size: 13px; line-height: 1.5;">
                Button not working? Copy and paste this link into your browser:<br>
                <a href="{{ .ConfirmationURL }}" style="color: #3b82f6; word-break: break-all;">{{ .ConfirmationURL }}</a>
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f4f4f5; padding: 24px 32px; text-align: center; border-top: 1px solid #e4e4e7;">
              <p style="margin: 0 0 8px; color: #71717a; font-size: 12px;">
                © 2025 AccrualFlow. All rights reserved.
              </p>
              <p style="margin: 0; color: #a1a1aa; font-size: 11px;">
                If you weren't expecting this invitation, you can safely ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
};

export const magicLinkTemplate: AuthEmailTemplate = {
  id: 'magic-link',
  name: 'Magic Link',
  description: 'Allow users to sign in via a one-time link sent to their email',
  subject: 'Your AccrualFlow login link',
  variables: ['{{ .ConfirmationURL }}', '{{ .Email }}', '{{ .SiteURL }}'],
  html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign In to AccrualFlow</title>
</head>
<body style="${baseStyles}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <tr>
            <td style="${headerGradient} padding: 32px; text-align: center;">
              <table cellpadding="0" cellspacing="0" style="margin: 0 auto;">
                <tr>
                  <td style="padding-right: 12px;">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M15 3H19C20.1046 3 21 3.89543 21 5V19C21 20.1046 20.1046 21 19 21H15M10 17L15 12M15 12L10 7M15 12H3" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </td>
                  <td>
                    <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">Sign In to Your Account</h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 32px;">
              <p style="margin: 0 0 20px; color: #18181b; font-size: 16px; line-height: 1.6;">
                Hi there! 👋
              </p>
              <p style="margin: 0 0 24px; color: #18181b; font-size: 16px; line-height: 1.6;">
                You requested a magic link to sign in to your AccrualFlow account. Click the button below to securely access your dashboard — no password needed!
              </p>
              
              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 16px 0 32px;">
                    <a href="{{ .ConfirmationURL }}" style="${ctaButtonStyle}">
                      Sign In Now
                    </a>
                  </td>
                </tr>
              </table>
              
              <!-- Security Warning -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fef2f2; border-radius: 8px; border-left: 4px solid #ef4444;">
                <tr>
                  <td style="padding: 16px;">
                    <p style="margin: 0; color: #991b1b; font-size: 14px; line-height: 1.5;">
                      <strong>🔒 Security Notice</strong><br>
                      This link expires in <strong>1 hour</strong> and can only be used once. Never share this link with anyone — AccrualFlow staff will never ask for it.
                    </p>
                  </td>
                </tr>
              </table>
              
              <!-- Alternative Link -->
              <p style="margin: 24px 0 0; color: #71717a; font-size: 13px; line-height: 1.5;">
                Button not working? Copy and paste this link into your browser:<br>
                <a href="{{ .ConfirmationURL }}" style="color: #3b82f6; word-break: break-all;">{{ .ConfirmationURL }}</a>
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f4f4f5; padding: 24px 32px; text-align: center; border-top: 1px solid #e4e4e7;">
              <p style="margin: 0 0 8px; color: #71717a; font-size: 12px;">
                © 2025 AccrualFlow. All rights reserved.
              </p>
              <p style="margin: 0; color: #a1a1aa; font-size: 11px;">
                Didn't request this? Someone may have entered your email by mistake. You can safely ignore this.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
};

export const changeEmailTemplate: AuthEmailTemplate = {
  id: 'change-email',
  name: 'Change Email Address',
  description: 'Ask users to verify their new email address after changing it',
  subject: 'Confirm your new email address',
  variables: ['{{ .ConfirmationURL }}', '{{ .Email }}', '{{ .NewEmail }}', '{{ .SiteURL }}'],
  html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm Your New Email</title>
</head>
<body style="${baseStyles}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <tr>
            <td style="${headerGradient} padding: 32px; text-align: center;">
              <table cellpadding="0" cellspacing="0" style="margin: 0 auto;">
                <tr>
                  <td style="padding-right: 12px;">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M4 4H20C21.1 4 22 4.9 22 6V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V6C2 4.9 2.9 4 4 4Z" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      <path d="M22 6L12 13L2 6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </td>
                  <td>
                    <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">Confirm Your New Email</h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 32px;">
              <p style="margin: 0 0 20px; color: #18181b; font-size: 16px; line-height: 1.6;">
                Email Change Request 📧
              </p>
              <p style="margin: 0 0 24px; color: #18181b; font-size: 16px; line-height: 1.6;">
                You've requested to change your AccrualFlow account email address. Please click the button below to confirm this change.
              </p>
              
              <!-- Email Change Info -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; border-radius: 8px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 16px;">
                    <p style="margin: 0 0 8px; color: #71717a; font-size: 13px;">New email address:</p>
                    <p style="margin: 0; color: #18181b; font-size: 16px; font-weight: 600;">{{ .Email }}</p>
                  </td>
                </tr>
              </table>
              
              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 16px 0 32px;">
                    <a href="{{ .ConfirmationURL }}" style="${ctaButtonStyle}">
                      Confirm New Email
                    </a>
                  </td>
                </tr>
              </table>
              
              <!-- Security Warning -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fef2f2; border-radius: 8px; border-left: 4px solid #ef4444;">
                <tr>
                  <td style="padding: 16px;">
                    <p style="margin: 0; color: #991b1b; font-size: 14px; line-height: 1.5;">
                      <strong>⚠️ Didn't request this change?</strong><br>
                      If you did not initiate this email change, please ignore this email and consider changing your password immediately to secure your account.
                    </p>
                  </td>
                </tr>
              </table>
              
              <!-- Alternative Link -->
              <p style="margin: 24px 0 0; color: #71717a; font-size: 13px; line-height: 1.5;">
                Button not working? Copy and paste this link into your browser:<br>
                <a href="{{ .ConfirmationURL }}" style="color: #3b82f6; word-break: break-all;">{{ .ConfirmationURL }}</a>
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f4f4f5; padding: 24px 32px; text-align: center; border-top: 1px solid #e4e4e7;">
              <p style="margin: 0 0 8px; color: #71717a; font-size: 12px;">
                © 2025 AccrualFlow. All rights reserved.
              </p>
              <p style="margin: 0; color: #a1a1aa; font-size: 11px;">
                This link expires in 24 hours for security purposes.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
};

export const resetPasswordTemplate: AuthEmailTemplate = {
  id: 'reset-password',
  name: 'Reset Password',
  description: 'Allow users to reset their password if they forget it',
  subject: 'Reset your AccrualFlow password',
  variables: ['{{ .ConfirmationURL }}', '{{ .Email }}', '{{ .SiteURL }}', '{{ .Token }}'],
  html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
</head>
<body style="${baseStyles}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <tr>
            <td style="${headerGradient} padding: 32px; text-align: center;">
              <table cellpadding="0" cellspacing="0" style="margin: 0 auto;">
                <tr>
                  <td style="padding-right: 12px;">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M12 15V17M6 21H18C19.1046 21 20 20.1046 20 19V13C20 11.8954 19.1046 11 18 11H6C4.89543 11 4 11.8954 4 13V19C4 20.1046 4.89543 21 6 21ZM16 11V7C16 4.79086 14.2091 3 12 3C9.79086 3 8 4.79086 8 7V11H16Z" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </td>
                  <td>
                    <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">Reset Your Password</h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px 32px;">
              <p style="margin: 0 0 20px; color: #18181b; font-size: 16px; line-height: 1.6;">
                Password Reset Request 🔐
              </p>
              <p style="margin: 0 0 24px; color: #18181b; font-size: 16px; line-height: 1.6;">
                We received a request to reset the password for your AccrualFlow account. Click the button below to create a new password.
              </p>
              
              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 16px 0 32px;">
                    <a href="{{ .ConfirmationURL }}" style="${ctaButtonStyle}">
                      Reset Password
                    </a>
                  </td>
                </tr>
              </table>
              
              <!-- Security Tips -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f0fdf4; border-radius: 8px; border-left: 4px solid #22c55e;">
                <tr>
                  <td style="padding: 16px;">
                    <p style="margin: 0 0 8px; color: #166534; font-size: 14px; font-weight: 600;">
                      🛡️ Password Tips
                    </p>
                    <ul style="margin: 0; padding-left: 20px; color: #166534; font-size: 13px; line-height: 1.6;">
                      <li>Use at least 12 characters</li>
                      <li>Mix uppercase, lowercase, numbers & symbols</li>
                      <li>Don't reuse passwords from other sites</li>
                    </ul>
                  </td>
                </tr>
              </table>
              
              <!-- Security Warning -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fef2f2; border-radius: 8px; border-left: 4px solid #ef4444; margin-top: 16px;">
                <tr>
                  <td style="padding: 16px;">
                    <p style="margin: 0; color: #991b1b; font-size: 14px; line-height: 1.5;">
                      <strong>Didn't request this?</strong><br>
                      If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.
                    </p>
                  </td>
                </tr>
              </table>
              
              <!-- Alternative Link -->
              <p style="margin: 24px 0 0; color: #71717a; font-size: 13px; line-height: 1.5;">
                Button not working? Copy and paste this link into your browser:<br>
                <a href="{{ .ConfirmationURL }}" style="color: #3b82f6; word-break: break-all;">{{ .ConfirmationURL }}</a>
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f4f4f5; padding: 24px 32px; text-align: center; border-top: 1px solid #e4e4e7;">
              <p style="margin: 0 0 8px; color: #71717a; font-size: 12px;">
                © 2025 AccrualFlow. All rights reserved.
              </p>
              <p style="margin: 0; color: #a1a1aa; font-size: 11px;">
                This link expires in 1 hour for security purposes.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
};

export const authEmailTemplates: AuthEmailTemplate[] = [
  confirmSignupTemplate,
  inviteUserTemplate,
  magicLinkTemplate,
  changeEmailTemplate,
  resetPasswordTemplate,
];

export default authEmailTemplates;
