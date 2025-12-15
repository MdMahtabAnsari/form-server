const express = require('express');
const cors = require('cors');
const SibApiV3Sdk = require('sib-api-v3-sdk');
const redis = require('redis');
const {config} = require('dotenv');

// Appwrite SDK
const { Client, Databases, Query } = require('node-appwrite');
config();
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Brevo (Sendinblue) API config
const apiKey = process.env.BRAVO_API_KEY;
const toEmail = process.env.TO_EMAIL;

SibApiV3Sdk.ApiClient.instance.authentications['api-key'].apiKey = apiKey;

// Appwrite config
const appwriteClient = new Client()
  .setEndpoint('https://fra.cloud.appwrite.io/v1')
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(appwriteClient);
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
const COLLECTION_ID = process.env.APPWRITE_COLLECTION_ID;
const PAYMENT_COLLECTION_ID = process.env.APPWRITE_PAYMENTS_COLLECTION_ID;

// Redis client setup
const redisClient = redis.createClient({
  url: process.env.REDIS_URL
});
redisClient.connect().catch(console.error);

// --- In-memory payment status store (for demo; use DB for production) ---
const paymentStatusStore = {}; // { email: true }

// Helper function to render non-education fields as HTML list
function renderObject(obj) {
  let html = '<ul>';
  for (const [k, v] of Object.entries(obj)) {
    if (
      k === 'graduation' ||
      k === 'twelfth' ||
      k === 'tenth'
    ) continue; // skip education fields here
    if (typeof v === 'object' && v !== null) {
      html += `<li><b>${k}:</b> ${renderObject(v)}</li>`;
    } else {
      html += `<li><b>${k}:</b> ${v}</li>`;
    }
  }
  html += '</ul>';
  return html;
}

// Helper function to render education as a table with post-specific requirements
function renderEducationTable(edu, post) {
  // Define what's required for each post
  const getRequirements = (selectedPost) => {
    switch (selectedPost) {
      case 'Assistant Branch Manager':
      case 'Relationship Manager':
        return { tenth: true, twelfth: true, graduation: true };
      case 'Multi Tasking Staff':
        return { tenth: true, twelfth: false, graduation: false };
      case 'Block Supervisor':
        return { tenth: true, twelfth: true, graduation: false };
      default:
        return { tenth: true, twelfth: true, graduation: true };
    }
  };

  const requirements = getRequirements(post);

  return `
    <div style="margin-bottom: 20px;">
      <p style="color: #666; font-size: 14px; margin-bottom: 10px;">
        <strong>Education Requirements for ${post}:</strong>
        10th: Required | 
        12th/Diploma: ${requirements.twelfth ? 'Required' : 'Optional'} | 
        Graduation: ${requirements.graduation ? 'Required' : 'Optional'}
      </p>
      <table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse; width: 100%;">
        <tr style="background-color: #f8f9fa;">
          <th style="padding: 8px;">Level</th>
          <th style="padding: 8px;">School/College</th>
          <th style="padding: 8px;">Board/University</th>
          <th style="padding: 8px;">Stream/Major</th>
          <th style="padding: 8px;">Year</th>
          <th style="padding: 8px;">Percentage/CGPA</th>
          <th style="padding: 8px;">Status</th>
        </tr>
        <tr>
          <td style="padding: 8px;">10th</td>
          <td style="padding: 8px;">${edu.tenth?.school || 'Not provided'}</td>
          <td style="padding: 8px;">${edu.tenth?.board || 'Not provided'}</td>
          <td style="padding: 8px;">-</td>
          <td style="padding: 8px;">${edu.tenth?.year || 'Not provided'}</td>
          <td style="padding: 8px;">${edu.tenth?.percentage || 'Not provided'}</td>
          <td style="padding: 8px; color: #dc3545;">Required</td>
        </tr>
        <tr>
          <td style="padding: 8px;">12th/Diploma</td>
          <td style="padding: 8px;">${edu.twelfth?.school || 'Not provided'}</td>
          <td style="padding: 8px;">${edu.twelfth?.board || 'Not provided'}</td>
          <td style="padding: 8px;">${edu.twelfth?.stream || 'Not provided'}</td>
          <td style="padding: 8px;">${edu.twelfth?.year || 'Not provided'}</td>
          <td style="padding: 8px;">${edu.twelfth?.percentage || 'Not provided'}</td>
          <td style="padding: 8px; color: ${requirements.twelfth ? '#dc3545' : '#28a745'};">
            ${requirements.twelfth ? 'Required' : 'Optional'}
          </td>
        </tr>
        <tr>
          <td style="padding: 8px;">Graduation</td>
          <td style="padding: 8px;">${edu.graduation?.college || 'Not provided'}</td>
          <td style="padding: 8px;">${edu.graduation?.university || 'Not provided'}</td>
          <td style="padding: 8px;">${edu.graduation?.major || 'Not provided'}</td>
          <td style="padding: 8px;">${edu.graduation?.year || 'Not provided'}</td>
          <td style="padding: 8px;">${edu.graduation?.cgpa || 'Not provided'}</td>
          <td style="padding: 8px; color: ${requirements.graduation ? '#dc3545' : '#28a745'};">
            ${requirements.graduation ? 'Required' : 'Optional'}
          </td>
        </tr>
      </table>
    </div>
  `;
}

// Helper function to get center label from value
function getCenterLabel(value) {
  const centerMap = {
    'delhi-ncr': 'Delhi-NCR',
    'bhubaneswar': 'Bhubaneswar',
    'ahmedabad': 'Ahmedabad',
    'kolkata': 'Kolkata',
    'haryana': 'Haryana'
  };
  return centerMap[value] || value;
}

// Helper function to normalize and validate email
function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  
  // Remove whitespace and convert to lowercase
  const trimmed = email.trim().toLowerCase();
  
  // Basic email validation regex
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  
  if (!emailRegex.test(trimmed)) {
    return null; // Invalid email format
  }
  
  return trimmed;
}

// Endpoint to check if Aadhar exists
app.post('/check-aadhar', async (req, res) => {
  const { aadhar } = req.body;
  if (!aadhar) return res.status(400).json({ error: 'Aadhar is required' });
  try {
    const result = await databases.listDocuments(DATABASE_ID, COLLECTION_ID, [
      Query.equal('aadharNumber', aadhar)
    ]);
    if (result.total > 0) {
      return res.json({ exists: true });
    }
    res.json({ exists: false });
  } catch (err) {
    res.status(500).json({ error: 'Error checking Aadhar' });
  }
});

// Endpoint to store Aadhar in Appwrite
// app.post('/store-aadhar', async (req, res) => {
//   const { aadhar } = req.body;
//   if (!aadhar) return res.status(400).json({ error: 'Aadhar is required' });
//   try {
//     // Try to create document, will fail if duplicate due to unique index
//     await databases.createDocument(DATABASE_ID, COLLECTION_ID, 'unique()', {
//       aadharNumber: aadhar
//     });
//     res.json({ success: true });
//   } catch (err) {
//     console.error('Error storing Aadhar:', err);
//     if (
//       err.code === 409 ||
//       (err.response && err.response.message && err.response.message.includes('already exists'))
//     ) {
//       res.status(409).json({ error: 'Aadhar already exists' });
//     } else {
//       res.status(500).json({ error: 'Error storing Aadhar' });
//     }
//   }
// });

// --- Email OTP endpoints using Brevo and Redis ---

// Send OTP to email using Brevo and store in Redis
app.post('/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    // Store OTP in Redis with 5 minutes expiry (use normalized email)
    await redisClient.setEx(`otp:${normalizedEmail}`, 300, otp);

    const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

    sendSmtpEmail.subject = 'Your OTP Code';
    sendSmtpEmail.htmlContent = `<p>Your OTP code is <b>${otp}</b>. It is valid for 5 minutes.</p>`;
    sendSmtpEmail.sender = { name: 'Job Application', email: toEmail };
    sendSmtpEmail.to = [{ email: normalizedEmail }];

    await apiInstance.sendTransacEmail(sendSmtpEmail);

    res.json({ success: true, message: 'OTP sent to email' });
  } catch (err) {
    console.error('Brevo OTP send error:', err?.response?.data || err.message || err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Verify OTP using Redis
app.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP are required' });

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  try {
    const storedOtp = await redisClient.get(`otp:${normalizedEmail}`);
    if (storedOtp && storedOtp === otp) {
      await redisClient.del(`otp:${normalizedEmail}`); // Remove OTP after use
      return res.json({ success: true, message: 'OTP verified' });
    } else {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }
  } catch (err) {
    console.error('Redis OTP verify error:', err?.message || err);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// --- End Email OTP endpoints ---

// --- PayU Webhook endpoint ---
// This version is robust to any content type and logs everything for debugging.
app.post('/payu-webhook', express.text({ type: '*/*' }), async (req, res) => {
  console.log('Headers:', req.headers);
  console.log('Raw body:', req.body);

  let body = req.body;
  // Try to parse if it's a string (urlencoded or JSON)
  if (typeof body === 'string') {
    try {
      // Try JSON first
      body = JSON.parse(body);
    } catch {
      // If not JSON, try urlencoded
      body = Object.fromEntries(new URLSearchParams(body));
    }
  }

  console.log('Parsed body:', body);

  // Now extract email and status safely
  const rawEmail = body?.email || body?.buyerEmail || body?.customer_email || body?.customerEmail;
  const email = normalizeEmail(rawEmail);
  const status = body?.status || body?.transaction_status || body?.payment_status || body?.status_code;

  if (!email || !status) {
    console.log('PayU webhook missing valid email or status. Raw email:', rawEmail, 'Status:', status, 'Full body:', body);
  }

  if (email && status && status.toLowerCase() === 'success') {
    // Store payment status in appwrite database
    try {
      const isExisting = await databases.listDocuments(DATABASE_ID, PAYMENT_COLLECTION_ID, [
        Query.equal('email', email)
      ]);
      if (isExisting.total > 0) {
        console.log(`Payment already exists for ${email}, treating as success`);
      } else {
        await databases.createDocument(DATABASE_ID, PAYMENT_COLLECTION_ID, 'unique()', {
          email: email,
          paid: true,
        });
        console.log(`Payment successful for ${email}`);
      }
    } catch (error) {
      console.error('Error storing payment status in Appwrite:', error);
    }
  }

  res.status(200).send('OK');
});

// --- Endpoint for frontend to check payment status ---
app.post('/check-payment', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  try {
    // Check for normalized email first
    let result = await databases.listDocuments(DATABASE_ID, PAYMENT_COLLECTION_ID, [
      Query.equal('email', normalizedEmail)
    ]);
    
    if (result.total > 0) {
      return res.json({ paid: true });
    }

    // Also check for the original case (for backward compatibility)
    if (email !== normalizedEmail) {
      result = await databases.listDocuments(DATABASE_ID, PAYMENT_COLLECTION_ID, [
        Query.equal('email', email)
      ]);
      
      if (result.total > 0) {
        return res.json({ paid: true });
      }
    }

    res.json({ paid: false });
  } catch (err) {
    console.error('Error checking payment status:', err);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// Send email with PDF attachment if provided, and confirmation to applicant
app.post('/send-email', async (req, res) => {
  try {
    const { formData, files, pdfBase64 } = req.body;

    // Prepare HTML content for the admin email
    let htmlContent = `<h2>New Job Application Received</h2>`;

    // Add important fields at the top
    htmlContent += `<h3>Application Details:</h3><ul>`;
    if (formData.applicationNumber) htmlContent += `<li><b>Application Number:</b> ${formData.applicationNumber}</li>`;
    if (formData.post) htmlContent += `<li><b>Post:</b> ${formData.post}</li>`;
    if (formData.category) htmlContent += `<li><b>Category:</b> ${formData.category}</li>`;
    // if (formData.category !== 'PwBD' && formData.paymentAmount) htmlContent += `<li><b>Payment Amount:</b> ${formData.paymentAmount}/-</li>`;
    htmlContent += `</ul>`;

    htmlContent += `<h3>Form Data:</h3>`;
    htmlContent += renderObject(formData);

    // Add center choices if present
    if (files && (files.centerChoice1 || files.centerChoice2)) {
      htmlContent += `<h3>Center Preferences:</h3><ul>`;
      if (files.centerChoice1) {
        const choice1Label = getCenterLabel(files.centerChoice1);
        htmlContent += `<li><b>First Choice (Priority 1):</b> ${choice1Label}</li>`;
      }
      if (files.centerChoice2) {
        const choice2Label = getCenterLabel(files.centerChoice2);
        htmlContent += `<li><b>Second Choice (Priority 2):</b> ${choice2Label}</li>`;
      }
      htmlContent += `</ul>`;
    }

    htmlContent += `<h3>Education Details:</h3>`;
    htmlContent += renderEducationTable({
      graduation: formData.graduation,
      twelfth: formData.twelfth,
      tenth: formData.tenth,
    }, formData.post);

    // Add Cloudinary image URLs as links and images in the email
    let inlineImagesHtml = '';
    for (const [key, url] of Object.entries(files)) {
      if (key !== 'center' && url && typeof url === 'string' && url.startsWith('http')) {
        inlineImagesHtml += `<p><b>${key}:</b><br><a href="${url}" target="_blank">${url}</a><br><img src="${url}" width="200"/></p>`;
      }
    }
    if (inlineImagesHtml) {
      htmlContent += `<h3>Uploaded Files:</h3>${inlineImagesHtml}`;
    }

    // Send email to admin using Brevo
    const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

    sendSmtpEmail.subject = 'New Job Application Received';
    sendSmtpEmail.htmlContent = htmlContent;
    sendSmtpEmail.sender = { name: 'Job Application', email: toEmail };
    sendSmtpEmail.to = [{ email: toEmail }];

    // Attach PDF if present
    if (pdfBase64) {
      sendSmtpEmail.attachment = [
        {
          name: 'AGORA_Applicant_Data.pdf',
          content: pdfBase64, // base64 string (no data:... prefix)
        }
      ];
    }

    await apiInstance.sendTransacEmail(sendSmtpEmail);

    // --- Send confirmation email to applicant ---
    if (formData.email) {
      const confirmationEmail = new SibApiV3Sdk.SendSmtpEmail();
      confirmationEmail.subject = 'Application Received - Next Steps';
      confirmationEmail.htmlContent = `
        <p>Dear ${formData.fullName || 'Applicant'},</p>
        <p>Thank you for your interest in joining LHCPL. We appreciate the time and effort you took to apply for the ${formData.post || '[Job Position]'} position.</p>
        <p>We are excited to inform you that we have received your application and will review it carefully. Our recruitment team will be in touch with you shortly to provide updates on the next steps.</p>
        <p><b>Application Number:</b> ${formData.applicationNumber || ''}</p>
        <p><b>Post:</b> ${formData.post || ''}</p>
        <p><b>Category:</b> ${formData.category || ''}</p>
        
        <p>In the coming days, we will be sending you an admit card and more details about the examination process. Please keep an eye on your email inbox for these updates.</p>
        <p>Once again, thank you for considering LHPCL as your potential employer. We look forward to taking your application to the next stage.</p>
        <br>
        <p>Best regards,</p>
        <p><b>Sunil Bajaj</b><br/>
        Recruitment Head<br/>
        Lavish Healthcare Pvt Ltd.</p>
      `;
      confirmationEmail.sender = { name: 'LHCPL Recruitment', email: toEmail };
      confirmationEmail.to = [{ email: formData.email }];

      await apiInstance.sendTransacEmail(confirmationEmail);
    }

    res.json({ message: 'Email sent successfully!' });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// Endpoint to check if Email exists
app.post('/check-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  try {
    // Check for normalized email first
    const normalizedResult = await databases.listDocuments(DATABASE_ID, COLLECTION_ID, [
      Query.equal('email', normalizedEmail)
    ]);
    
    if (normalizedResult.total > 0) {
      return res.json({ exists: true });
    }

    // Also check for the original case (for backward compatibility with existing data)
    // This is important if there are emails in the database that were stored before normalization
    if (email !== normalizedEmail) {
      const originalResult = await databases.listDocuments(DATABASE_ID, COLLECTION_ID, [
        Query.equal('email', email)
      ]);
      
      if (originalResult.total > 0) {
        return res.json({ exists: true });
      }
    }

    res.json({ exists: false });
  } catch (err) {
    console.error('Error checking Email:', err);
    res.status(500).json({ error: 'Error checking Email' });
  }
});

// Endpoint to store Email in Appwrite
// app.post('/store-email', async (req, res) => {
//   const { email } = req.body;
//   if (!email) return res.status(400).json({ error: 'Email is required' });
//   try {
//     await databases.createDocument(DATABASE_ID, COLLECTION_ID, 'unique()', {
//       email: email
//     });
//     res.json({ success: true });
//   } catch (err) {
//     if (
//       err.code === 409 ||
//       (err.response && err.response.message && err.response.message.includes('already exists'))
//     ) {
//       res.status(409).json({ error: 'Email already exists' });
//     } else {
//       res.status(500).json({ error: 'Error storing Email' });
//     }
//   }
// });

// Endpoint to check if Phone exists
app.post('/check-phone', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone is required' });
  try {
    const result = await databases.listDocuments(DATABASE_ID, COLLECTION_ID, [
      Query.equal('phone', phone)
    ]);
    if (result.total > 0) {
      return res.json({ exists: true });
    }
    res.json({ exists: false });
  } catch (err) {
    res.status(500).json({ error: 'Error checking Phone' });
  }
});

// Endpoint to store Phone in Appwrite
// app.post('/store-phone', async (req, res) => {
//   const { phone } = req.body;
//   if (!phone) return res.status(400).json({ error: 'Phone is required' });
//   try {
//     await databases.createDocument(DATABASE_ID, COLLECTION_ID, 'unique()', {
//       phone: phone
//     });
//     res.json({ success: true });
//   } catch (err) {
//     if (
//       err.code === 409 ||
//       (err.response && err.response.message && err.response.message.includes('already exists'))
//     ) {
//       res.status(409).json({ error: 'Phone already exists' });
//     } else {
//       res.status(500).json({ error: 'Error storing Phone' });
//     }
//   }
// });


// Endpoint to store Email, Phone, and Aadhar in Appwrite

app.post('/store-data', async (req, res) => {
  const { email, phone, aadharNumber,applicationNumber } = req.body;
  if (!email || !phone || !aadharNumber) return res.status(400).json({ error: 'Email, Phone, and Aadhar are required' });

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  try {
    await databases.createDocument(DATABASE_ID, COLLECTION_ID, 'unique()', {
      email: normalizedEmail,
      phone: phone,
      aadharNumber: aadharNumber,
      applicationNumber: applicationNumber
    });
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('Error storing Data:', err);
    if (
      err.code === 409 ||
      (err.response && err.response.message && err.response.message.includes('already exists'))
    ) {
      res.status(409).json({ error: 'Data already exists' });
    } else {
      res.status(500).json({ error: 'Error storing Data' });
    }
  }
});

app.listen(3000, () => {
  console.log('Backend server running on http://localhost:3000');
});
