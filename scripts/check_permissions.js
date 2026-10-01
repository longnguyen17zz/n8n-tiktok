import { google } from 'googleapis';
import { CONFIG } from '../src/config.js';

async function checkPermissions() {
  const credentials = JSON.parse(CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/drive']
  });

  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.permissions.list({
    fileId: CONFIG.DRIVE_OUTPUT_FOLDER_ID,
    fields: 'permissions(id, displayName, type, role, emailAddress)'
  });

  console.log('Permissions on folder:', JSON.stringify(res.data.permissions, null, 2));
}

checkPermissions();
